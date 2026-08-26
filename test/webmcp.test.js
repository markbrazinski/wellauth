/**
 * WebMCP lifecycle proofs against the REAL @mcp-b/webmcp-polyfill.
 *
 * These deliberately do not mock document.modelContext. The whole commission is
 * "do capabilities actually appear and disappear", so every assertion reads back
 * from the browser API's own getTools(), not from our bookkeeping.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupWebMCPPolyfill, initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'

/** Read the inventory back from the browser API itself. */
async function browserTools() {
  const tools = await document.modelContext.getTools()
  return tools.map((t) => t.name).sort()
}

/** Minimal stand-in for the app's registrar, exercising the same abort mechanism. */
function makeRegistrar() {
  const live = new Map()
  return {
    async sync(desired, handlers = {}) {
      for (const [name, controller] of live) {
        if (!desired.includes(name)) {
          controller.abort()
          live.delete(name)
        }
      }
      for (const name of desired) {
        if (live.has(name)) continue
        const controller = new AbortController()
        await document.modelContext.registerTool(
          {
            name,
            description: `tool ${name}`,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: handlers[name] ?? (async () => ({ ok: true, tool: name })),
          },
          { signal: controller.signal },
        )
        live.set(name, controller)
      }
    },
    names: () => [...live.keys()].sort(),
  }
}

beforeEach(() => initializeWebMCPPolyfill())
afterEach(() => cleanupWebMCPPolyfill())

describe('polyfill surface matches the spec we coded against', () => {
  it('exposes document.modelContext with registerTool/getTools', () => {
    expect(typeof document.modelContext).toBe('object')
    expect(typeof document.modelContext.registerTool).toBe('function')
    expect(typeof document.modelContext.getTools).toBe('function')
  })

  it('has no unregisterTool / provideContext / clearContext', () => {
    // Removal is AbortSignal-only. If these ever appear, our registrar's
    // assumptions need revisiting.
    expect(document.modelContext.unregisterTool).toBeUndefined()
    expect(document.modelContext.provideContext).toBeUndefined()
    expect(document.modelContext.clearContext).toBeUndefined()
  })
})

describe('dynamic registration is real, not cosmetic', () => {
  it('2 -> 5 -> 2 is reflected in the browser inventory', async () => {
    const reg = makeRegistrar()
    const BASE = ['get_order_context', 'discover_coverage_requirements']
    const FIVE = [...BASE, 'find_supporting_evidence', 'inspect_evidence', 'bind_evidence']

    await reg.sync(BASE)
    expect(await browserTools()).toEqual([...BASE].sort())
    expect(await browserTools()).toHaveLength(2)

    await reg.sync(FIVE)
    expect(await browserTools()).toEqual([...FIVE].sort())
    expect(await browserTools()).toHaveLength(5)

    await reg.sync(BASE)
    const back = await browserTools()
    expect(back).toHaveLength(2)
    expect(back).not.toContain('bind_evidence')
    expect(back).not.toContain('find_supporting_evidence')
    expect(back).not.toContain('inspect_evidence')
  })

  it('aborting a registration removes it from getTools()', async () => {
    const controller = new AbortController()
    await document.modelContext.registerTool(
      {
        name: 'temporary_tool',
        description: 'goes away',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      },
      { signal: controller.signal },
    )
    expect(await browserTools()).toContain('temporary_tool')

    controller.abort()
    expect(await browserTools()).not.toContain('temporary_tool')
  })

  it('removed tools cannot subsequently be invoked', async () => {
    let callCount = 0
    const controller = new AbortController()
    await document.modelContext.registerTool(
      {
        name: 'doomed_tool',
        description: 'will be unregistered',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          callCount += 1
          return { ok: true }
        },
      },
      { signal: controller.signal },
    )

    const [handle] = await document.modelContext.getTools()
    expect(handle.name).toBe('doomed_tool')
    await document.modelContext.executeTool(handle, '{}')
    expect(callCount).toBe(1)

    controller.abort()
    expect(await browserTools()).not.toContain('doomed_tool')

    // Invoking the stale handle must fail, and must NOT reach our code.
    await expect(document.modelContext.executeTool(handle, '{}')).rejects.toThrow()
    expect(callCount).toBe(1)
  })

  it('inventory changes without a reload and fires toolchange', async () => {
    let changes = 0
    document.modelContext.addEventListener('toolchange', () => {
      changes += 1
    })

    const reg = makeRegistrar()
    await reg.sync(['a'])
    await reg.sync(['a', 'b'])
    await reg.sync([])

    // Same document object throughout -- no navigation, no reload.
    expect(changes).toBeGreaterThan(0)
    expect(await browserTools()).toEqual([])
  })
})

describe('registered set cannot drift from the intended set', () => {
  it('bookkeeping and browser inventory agree at every step', async () => {
    const reg = makeRegistrar()
    const sequence = [
      ['get_order_context', 'discover_coverage_requirements'],
      ['get_order_context', 'discover_coverage_requirements', 'bind_evidence'],
      ['get_order_context'],
      ['get_order_context', 'submit_prior_authorization'],
      [],
    ]

    for (const desired of sequence) {
      await reg.sync(desired)
      expect(reg.names()).toEqual([...desired].sort())
      expect(await browserTools()).toEqual([...desired].sort())
    }
  })

  it('re-syncing the same set does not duplicate registrations', async () => {
    const reg = makeRegistrar()
    await reg.sync(['get_order_context'])
    await reg.sync(['get_order_context'])
    await reg.sync(['get_order_context'])
    expect(await browserTools()).toEqual(['get_order_context'])
  })
})

describe('tool execution returns plain JSON values', () => {
  it('execute result round-trips without MCP content-block wrapping', async () => {
    const payload = { orderId: 'synthetic-order-7731', priorAuthorizationRequired: true }
    const controller = new AbortController()
    await document.modelContext.registerTool(
      {
        name: 'get_order_context',
        description: 'returns the order',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => payload,
      },
      { signal: controller.signal },
    )

    const [handle] = await document.modelContext.getTools()
    const raw = await document.modelContext.executeTool(handle, '{}')
    // executeTool resolves to a JSON string per spec.
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    expect(parsed).toMatchObject(payload)
  })

  it('input reaches execute as a plain object', async () => {
    let seen = null
    const controller = new AbortController()
    await document.modelContext.registerTool(
      {
        name: 'inspect_evidence',
        description: 'echoes input',
        inputSchema: {
          type: 'object',
          properties: { evidenceId: { type: 'string' } },
          required: ['evidenceId'],
        },
        execute: async (input) => {
          seen = input
          return { got: input.evidenceId }
        },
      },
      { signal: controller.signal },
    )

    const [handle] = await document.modelContext.getTools()
    await document.modelContext.executeTool(handle, JSON.stringify({ evidenceId: 'ev-100' }))
    expect(seen).toEqual({ evidenceId: 'ev-100' })
  })
})

describe('regression: concurrent sync must not throw "Duplicate tool name"', () => {
  it('two overlapping registrations of the same name do not both register', async () => {
    // Reproduces the StrictMode double-invoke race: registerTool is async, so
    // claiming the name only AFTER the await let both callers through.
    const live = new Map()
    const register = async (name) => {
      if (live.has(name)) return
      const controller = new AbortController()
      live.set(name, controller) // claim BEFORE awaiting
      await document.modelContext.registerTool(
        {
          name,
          description: 'racy',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({ ok: true }),
        },
        { signal: controller.signal },
      )
    }

    await expect(
      Promise.all([register('racy_tool'), register('racy_tool'), register('racy_tool')]),
    ).resolves.toBeDefined()

    const names = (await document.modelContext.getTools()).map((t) => t.name)
    expect(names.filter((n) => n === 'racy_tool')).toHaveLength(1)
  })

  it('the browser genuinely rejects a real duplicate name', async () => {
    // Guards the assumption the fix depends on.
    const c1 = new AbortController()
    await document.modelContext.registerTool(
      { name: 'dup_tool', description: 'first', inputSchema: { type: 'object', properties: {} }, execute: async () => ({}) },
      { signal: c1.signal },
    )
    const c2 = new AbortController()
    await expect(
      document.modelContext.registerTool(
        { name: 'dup_tool', description: 'second', inputSchema: { type: 'object', properties: {} }, execute: async () => ({}) },
        { signal: c2.signal },
      ),
    ).rejects.toThrow()
  })
})
