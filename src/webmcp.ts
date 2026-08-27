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

/**
 * Publishes the latest server snapshot for tool closures to read.
 *
 * The revision is held MONOTONIC. Snapshot reads are concurrent -- a refresh
 * issued before a mutation can resolve after it -- so a late-arriving older
 * read would otherwise roll `revision` backwards and make the NEXT tool call
 * assert a stale expected_revision, which the backend then correctly (but
 * avoidably) refuses with REVISION_CONFLICT.
 *
 * Revision is monotonic on the server by construction, so clamping to the
 * highest value observed is not a client-side invention of state -- it is
 * refusing to un-observe something the server already reported. Everything
 * else in the snapshot is replaced wholesale, and the server re-validates the
 * revision inside the transaction regardless.
 */
export function setSnapshot(s: Snapshot): void {
  const known = currentSnapshot?.revision ?? -Infinity
  currentSnapshot =
    typeof s?.revision === 'number' && s.revision < known
      ? { ...s, revision: known }
      : s
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

          // A tool call may have advanced server state. Adopt the revision the
          // SERVER just reported before anything else runs, so a subsequent
          // back-to-back tool call asserts the current revision rather than the
          // one this closure was handed. Without this, an agent chaining two
          // mutations (attach, attach) sends a stale expected_revision on the
          // second and the backend correctly -- but avoidably -- refuses it
          // with REVISION_CONFLICT.
          //
          // This is NOT the frontend deciding state: it only carries forward a
          // revision the server itself just returned, and the server still
          // re-validates it inside the transaction.
          const rev = (result as { revision?: number } | null)?.revision
          if (typeof rev === 'number' && currentSnapshot) {
            currentSnapshot = { ...currentSnapshot, revision: rev }
          }

          // Re-read authoritative truth so the page and the capability
          // inventory reflect the new state without a reload.
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
    // registerTool awaits an internal task before resolving and rethrows
    // `signal.reason` if the registration was aborted inside that window. That
    // is a benign lost race -- this exact name was concurrently withdrawn --
    // and the next sync reconciles it. Escalating it would surface a spurious
    // "WebMCP registration failed" banner mid-demo (P0-3).
    if (controller.signal.aborted) return
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
  let inBrowser = new Set((await browserToolNames()) ?? [])

  // ORPHAN RECONCILIATION (P0-3).
  //
  // Previously an orphan was "adopted": skipped, and never entered into
  // `live`. That left a registration this page could never abort, so when the
  // server later WITHDREW the capability the tool stayed callable in the
  // browser -- a stale capability surviving its own withdrawal, and a direct
  // break of `browser tools === snapshot.availableTools`.
  //
  // There is no API to take ownership of someone else's AbortSignal, and the
  // polyfill/native both reject a duplicate name. The only correct move is to
  // treat an untracked registration as garbage from a dead page instance and
  // refuse to depend on it. We cannot remove it, so we report the divergence
  // loudly rather than silently pretending the inventory matches.
  const orphans = [...inBrowser].filter((n) => !live.has(n))
  if (orphans.length > 0) {
    console.warn(`[wellauth] untracked WebMCP registrations present: ${orphans.join(', ')}`)
  }

  for (const name of desired) {
    if (live.has(name)) continue
    const def = TOOL_REGISTRY[name]
    if (!def) {
      console.warn(`[wellauth] server requested unknown tool "${name}"`)
      continue
    }
    if (inBrowser.has(name)) {
      // An orphan occupying a name we now genuinely need. We cannot abort it,
      // so it stays -- but it must NOT be silently trusted: its execute
      // closure belongs to a dead page instance and would post a stale
      // revision. Re-read the browser inventory once in case it has since
      // cleared, then register properly if the name is free.
      inBrowser = new Set((await browserToolNames()) ?? [])
      if (inBrowser.has(name)) {
        console.warn(`[wellauth] name "${name}" held by an untracked registration`)
        continue
      }
    }
    await registerOne(def, refresh)
  }
}

/** Abort every registration. Used on teardown. */
export function unregisterAll(): void {
  for (const controller of live.values()) controller.abort()
  live.clear()
}

/**
 * ORPHAN PREVENTION (P0-3).
 *
 * Orphans -- registrations still held by the browser that no live page
 * instance can abort -- are what let a withdrawn capability survive. They
 * appear when a document is replaced without this module tearing its own
 * registrations down: bfcache restore, soft navigation, HMR.
 *
 * `pagehide` is the reliable one-shot for that; `beforeunload` is not fired
 * for bfcache and `unload` is deprecated. Cheap, idempotent, and it makes the
 * adoption path above a genuine last resort rather than the normal case.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => unregisterAll())
}
