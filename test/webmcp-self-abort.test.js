/**
 * THE TERMINAL-TRANSITION DEFECT.
 *
 * Every tool's `execute` calls refresh(), which re-syncs capabilities. A
 * mutating tool's own capability is usually withdrawn by the state it just
 * produced -- so the sync would abort the registration whose `execute` was
 * still on the stack.
 *
 * That is not benign: the polyfill (and native WebMCP) tie the in-flight call
 * to the registration's AbortSignal, so the call dies with "Tool unregistered"
 * even though the backend operation succeeded. In a native browser this
 * surfaced as "page configuration exceeded supported limits" immediately after
 * the final extension submission.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupWebMCPPolyfill, initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'

/**
 * The real TOOL_REGISTRY execute() closures talk to the provider over fetch and
 * read `currentSnapshot.revision`. This suite is about the REGISTRATION
 * lifecycle, not the network, so the transport is stubbed and a snapshot is
 * published -- everything else is the production module.
 */
async function loadRegistrar() {
  vi.resetModules()
  const m = await import('../src/webmcp.ts')
  m.setSnapshot({ revision: 7, availableTools: [] })
  return m
}

beforeEach(() => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: true, revision: 8, state: 'APPROVED' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})

const browserTools = async () =>
  (await document.modelContext.getTools()).map((t) => t.name).sort()

beforeEach(() => initializeWebMCPPolyfill())
afterEach(() => cleanupWebMCPPolyfill())

describe('the underlying browser behaviour this guards against', () => {
  it('aborting a registration mid-execute kills the in-flight call', async () => {
    // Pinned so a future polyfill/native change that makes this benign is
    // noticed, rather than silently making the fix look unnecessary.
    const c = new AbortController()
    await document.modelContext.registerTool({
      name: 'doomed',
      description: 'aborts itself while running',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        c.abort()
        await new Promise((r) => setTimeout(r, 10))
        return { ok: true }
      },
    }, { signal: c.signal })

    const [handle] = await document.modelContext.getTools()
    await expect(document.modelContext.executeTool(handle, '{}')).rejects.toThrow()
  })
})

describe('a tool that withdraws itself still returns its result', () => {
  it('the terminal submit survives its own withdrawal', async () => {
    const { syncTools } = await loadRegistrar()

    // REMEDIATION_APPROVED: the extension submit exists.
    const approved = ['check_authorization_status', 'get_order_context',
                      'submit_authorization_extension']
    // AUTHORIZATION_ALIGNED: it is withdrawn by the state the call produces.
    const aligned = ['check_authorization_status', 'get_order_context']

    let serverTools = approved
    // refresh() is what execute() calls: it re-syncs from the NEW server list.
    const refresh = () => { void syncTools(serverTools, refresh) }

    await syncTools(approved, refresh)
    expect(await browserTools()).toEqual([...approved].sort())

    const handle = (await document.modelContext.getTools())
      .find((t) => t.name === 'submit_authorization_extension')
    expect(handle).toBeDefined()

    // Invoking it advances state so that this very capability disappears.
    serverTools = aligned
    const raw = await document.modelContext.executeTool(handle, '{}')
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw

    // THE POINT: the call completed and returned real backend truth. Before
    // the fix this rejected with "Tool unregistered".
    expect(result).toBeTruthy()

    // And the capability really is gone afterwards -- deferred, not skipped.
    await syncTools(aligned, refresh)
    const after = await browserTools()
    expect(after).toEqual([...aligned].sort())
    expect(after).not.toContain('submit_authorization_extension')
  })

  it('a deferred withdrawal is not re-registered underneath itself', async () => {
    const { syncTools, registeredToolNames } = await loadRegistrar()
    const approved = ['get_order_context', 'submit_authorization_extension']
    const aligned = ['get_order_context']

    let serverTools = approved
    const refresh = () => { void syncTools(serverTools, refresh) }
    await syncTools(approved, refresh)

    const handle = (await document.modelContext.getTools())
      .find((t) => t.name === 'submit_authorization_extension')

    serverTools = aligned
    await document.modelContext.executeTool(handle, '{}')
    // Several syncs land while the withdrawal is retiring.
    await Promise.all([
      syncTools(aligned, refresh),
      syncTools(aligned, refresh),
      syncTools(aligned, refresh),
    ])

    const after = await browserTools()
    expect(after).toEqual([...aligned].sort())
    expect(new Set(after).size).toBe(after.length)
    expect(registeredToolNames()).toEqual([...aligned].sort())
  })

  it('the withdrawal genuinely takes the DEFERRED path', async () => {
    // Guards the mechanism, not just the outcome: if a refactor ever aborts
    // synchronously again, the outcome tests could still pass by luck on a
    // faster/slower runtime. This asserts the deferral actually engaged.
    const { syncTools, syncTraces, clearSyncTraces } = await loadRegistrar()
    const approved = ['get_order_context', 'submit_authorization_extension']
    const aligned = ['get_order_context']

    let serverTools = approved
    const refresh = () => { void syncTools(serverTools, refresh) }
    await syncTools(approved, refresh)
    clearSyncTraces()

    const handle = (await document.modelContext.getTools())
      .find((t) => t.name === 'submit_authorization_extension')
    serverTools = aligned
    await document.modelContext.executeTool(handle, '{}')
    await new Promise((r) => setTimeout(r, 60))

    const removals = syncTraces().flatMap((t) => t.removed)
    expect(removals.some((r) => r.includes('(deferred)'))).toBe(true)
    expect(await browserTools()).toEqual(aligned)
  })

  it('the whole terminal sequence leaves exactly the read-only tools', async () => {
    const { syncTools } = await loadRegistrar()
    const seq = [
      ['check_authorization_status', 'get_order_context', 'resolve_authorization_window'],
      ['check_authorization_status', 'get_order_context'],
      ['check_authorization_status', 'get_order_context', 'submit_authorization_extension'],
      ['check_authorization_status', 'get_order_context'],
    ]
    const refresh = () => {}
    for (const desired of seq) {
      await syncTools(desired, refresh)
      const got = await browserTools()
      expect(got).toEqual([...desired].sort())
      expect(new Set(got).size).toBe(got.length)
    }
  })
})
