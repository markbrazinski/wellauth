// WebMCP registration lifecycle.
//
// Spec notes (verified against webmachinelearning/webmcp, Aug 2026):
//  - entry point is `document.modelContext` (NOT navigator.modelContext, which is
//    a deprecated alias, and NOT window.agent, which is dead);
//  - `provideContext()` / `clearContext()` / `unregisterTool()` do not exist;
//  - the ONLY way to unregister is to abort the AbortSignal passed at register time;
//  - `execute` returns a plain JSON-serializable value, not MCP content blocks;
//  - the browser fires `toolchange` automatically -- pages do not notify.

import { TOOL_REGISTRY, type Snapshot, type ToolDef } from './capabilities'

/**
 * The latest server snapshot. Tool `execute` closures read it for
 * `expected_revision`, so a tool call always asserts the revision the SERVER
 * last reported rather than one the client remembered from registration time.
 */
let currentSnapshot: Snapshot | null = null
export function setSnapshot(s: Snapshot): void {
  currentSnapshot = s
}

interface ModelContextLike {
  registerTool: (
    tool: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      annotations?: { readOnlyHint?: boolean }
      execute: (input: Record<string, unknown>) => Promise<unknown>
    },
    options?: { signal?: AbortSignal },
  ) => Promise<void>
  getTools?: () => Promise<Array<{ name: string }>>
}

function modelContext(): ModelContextLike | null {
  const doc = document as unknown as { modelContext?: ModelContextLike }
  if (typeof doc.modelContext?.registerTool === 'function') return doc.modelContext
  return null
}

export function isWebMcpAvailable(): boolean {
  return modelContext() !== null
}

/** Live registrations: tool name -> the controller that unregisters it. */
const live = new Map<string, AbortController>()

export type InvocationLog = {
  tool: string
  input: Record<string, unknown>
  result: unknown
  at: string
}

let onInvocation: ((log: InvocationLog) => void) | null = null
export function setInvocationListener(fn: (log: InvocationLog) => void) {
  onInvocation = fn
}

/** Names currently registered with the browser, as tracked locally. */
export function registeredToolNames(): string[] {
  return [...live.keys()].sort()
}

/** Ask the browser what it actually has, to detect divergence from `live`. */
export async function browserToolNames(): Promise<string[] | null> {
  const ctx = modelContext()
  if (!ctx?.getTools) return null
  const tools = await ctx.getTools()
  return tools.map((t) => t.name).sort()
}

async function registerOne(def: ToolDef, refresh: () => void): Promise<void> {
  const ctx = modelContext()
  if (!ctx) return

  const controller = new AbortController()
  // Claim the name BEFORE awaiting. registerTool is async, so two concurrent
  // syncs (React StrictMode double-invokes effects in dev) would otherwise both
  // see the name as free and the second would throw "Duplicate tool name".
  live.set(def.name, controller)
  try {
    await ctx.registerTool(
      {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: def.readOnlyHint },
        execute: async (input: Record<string, unknown>) => {
          const result = await def.execute(input ?? {}, currentSnapshot as Snapshot)
          // A tool call may have advanced server state; re-read it so the page
          // reflects the new authoritative truth without a reload.
          refresh()
          onInvocation?.({
            tool: def.name,
            input: input ?? {},
            result,
            at: new Date().toISOString(),
          })
          return result
        },
      },
      { signal: controller.signal },
    )
  } catch (e) {
    // Release the claim so a later sync can retry.
    live.delete(def.name)
    throw e
  }
}

/**
 * Make the browser's registered inventory exactly match `desired`.
 *
 * `desired` always comes from the server's availableTools. Tools not in the
 * list are aborted (genuinely unregistered, not merely hidden from the UI).
 */
// Serializes overlapping syncs. Two concurrent refreshes must not interleave
// abort/register on the same names.
let syncChain: Promise<void> = Promise.resolve()

export function syncTools(desired: string[], refresh: () => void): Promise<void> {
  syncChain = syncChain.then(
    () => syncToolsInner(desired, refresh),
    () => syncToolsInner(desired, refresh),
  )
  return syncChain
}

async function syncToolsInner(desired: string[], refresh: () => void): Promise<void> {
  if (!modelContext()) return
  const target = new Set(desired)

  for (const [name, controller] of live) {
    if (!target.has(name)) {
      controller.abort()
      live.delete(name)
    }
  }

  // A soft-navigated or restored document can still hold registrations made by
  // a previous instance of this page, which `live` knows nothing about.
  // Re-registering such a name throws, so reconcile against the browser's own
  // inventory rather than trusting local bookkeeping alone.
  const alreadyInBrowser = new Set((await browserToolNames()) ?? [])

  for (const name of desired) {
    if (live.has(name)) continue
    const def = TOOL_REGISTRY[name]
    if (!def) {
      console.warn(`[wellauth] server requested unknown tool "${name}"`)
      continue
    }
    if (alreadyInBrowser.has(name)) {
      // Orphaned from a prior instance: we cannot abort a controller we do not
      // own, so adopt the name and skip re-registration.
      console.warn(`[wellauth] adopting pre-existing registration "${name}"`)
      continue
    }
    await registerOne(def, refresh)
  }
}

/** Abort every registration. Used on teardown. */
export function unregisterAll(): void {
  for (const controller of live.values()) controller.abort()
  live.clear()
}
