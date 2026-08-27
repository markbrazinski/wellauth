/**
 * P0-3: the browser's WebMCP inventory must equal snapshot.availableTools at
 * EVERY canonical transition of the full Act I + Act II chain.
 *
 * These run against the REAL @mcp-b/webmcp-polyfill and the REAL server-side
 * capability function, so the two sides of the invariant are the actual
 * production code -- not a restatement of it.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupWebMCPPolyfill, initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'
import { capabilitiesFor } from '../provider/capabilities.js'

// The registrar under test is the production module. It is imported fresh per
// test so its module-level `live` map cannot leak between cases -- which is
// itself the orphan condition P0-3 is about.
async function loadRegistrar() {
  vi.resetModules()
  return import('../src/webmcp.ts')
}

const browserTools = async () =>
  (await document.modelContext.getTools()).map((t) => t.name).sort()

beforeEach(() => initializeWebMCPPolyfill())
afterEach(() => cleanupWebMCPPolyfill())

/**
 * The canonical journey, expressed as authoritative BACKEND documents. Each
 * step's expected inventory is computed by the real server function, so this
 * test cannot drift from the capability policy it is guarding.
 */
const JOURNEY = [
  ['CONTEXT_READY', { state: 'CONTEXT_READY', completeness: { satisfied: 0 } }, {}],
  ['REQUIREMENTS_RESOLVED', { state: 'REQUIREMENTS_RESOLVED', completeness: { satisfied: 0 } }, {}],
  ['4 of 5', { state: 'REQUIREMENTS_RESOLVED', completeness: { satisfied: 4 } }, {}],
  ['5 of 5 (PACKET_COMPLETE)', { state: 'PACKET_COMPLETE', completeness: { satisfied: 5 } }, {}],
  ['PREPARED_AWAITING_APPROVAL',
    { state: 'PREPARED_AWAITING_APPROVAL', completeness: { satisfied: 5 } }, {}],
  ['APPROVED', { state: 'APPROVED', completeness: { satisfied: 5 } }, {}],
  ['SUBMITTED_OR_PENDING',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'SUBMITTED_OR_PENDING' } }, {}],
  ['PAYER_APPROVED_COVERAGE_GAP',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } },
    { phase: 'PAYER_APPROVED_COVERAGE_GAP' }],
  ['REMEDIATION_PREPARED',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } },
    { phase: 'REMEDIATION_PREPARED' }],
  ['REMEDIATION_APPROVED',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } },
    { phase: 'REMEDIATION_APPROVED' }],
  ['REMEDIATION_SUBMITTED',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } },
    { phase: 'REMEDIATION_SUBMITTED' }],
  ['AUTHORIZATION_ALIGNED',
    { state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } },
    { phase: 'AUTHORIZATION_ALIGNED' }],
]

describe('P0-3 full Act I + Act II WebMCP chain', () => {
  it('browser inventory === snapshot.availableTools at EVERY transition', async () => {
    const { syncTools } = await loadRegistrar()
    const seen = []

    for (const [label, wf, act2] of JOURNEY) {
      const available = capabilitiesFor(wf, act2)
      await syncTools(available, () => {})
      const inBrowser = await browserTools()

      expect(inBrowser, `${label}: browser inventory must equal availableTools`)
        .toEqual([...available].sort())
      // No duplicates, ever.
      expect(new Set(inBrowser).size, `${label}: duplicate tool registered`)
        .toBe(inBrowser.length)
      seen.push([label, inBrowser])
    }

    // The human gate: no submission capability while awaiting approval.
    const prepared = seen.find(([l]) => l === 'PREPARED_AWAITING_APPROVAL')[1]
    expect(prepared).not.toContain('submit_prior_authorization')
    const remPrepared = seen.find(([l]) => l === 'REMEDIATION_PREPARED')[1]
    expect(remPrepared).not.toContain('submit_authorization_extension')

    // And the capability really does appear after approval.
    expect(seen.find(([l]) => l === 'APPROVED')[1]).toContain('submit_prior_authorization')
    expect(seen.find(([l]) => l === 'REMEDIATION_APPROVED')[1])
      .toContain('submit_authorization_extension')
  })

  it('no stale tool survives its own withdrawal', async () => {
    const { syncTools } = await loadRegistrar()
    // Walk the journey forwards then backwards through the approval boundary,
    // which is where the audit saw WebMCP break.
    for (const phase of ['REMEDIATION_PREPARED', 'REMEDIATION_APPROVED',
                         'REMEDIATION_PREPARED', 'REMEDIATION_APPROVED',
                         'REMEDIATION_SUBMITTED', 'AUTHORIZATION_ALIGNED']) {
      const wf = {
        state: 'APPROVED', completeness: { satisfied: 5 },
        submission: { state: 'COMPLETE', payerStatus: 'approved' },
      }
      const available = capabilitiesFor(wf, { phase })
      await syncTools(available, () => {})
      expect(await browserTools(), `after ${phase}`).toEqual([...available].sort())
    }
  })

  it('overlapping syncs at the approval boundary still converge', async () => {
    const { syncTools } = await loadRegistrar()
    const wf = {
      state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' },
    }
    const prepared = capabilitiesFor(wf, { phase: 'REMEDIATION_PREPARED' })
    const approved = capabilitiesFor(wf, { phase: 'REMEDIATION_APPROVED' })

    // A human approval triggers refresh() while a tool-invocation refresh may
    // already be in flight -- two concurrent syncs with DIFFERENT server lists.
    for (let i = 0; i < 15; i++) {
      const a = syncTools(prepared, () => {})
      const b = syncTools(approved, () => {})
      await Promise.all([a, b])
      // The LAST sync queued wins; the chain must land exactly there.
      expect(await browserTools(), `iteration ${i}`).toEqual([...approved].sort())
    }
  })

  it('re-syncing an unchanged set never duplicates or drops a registration', async () => {
    const { syncTools } = await loadRegistrar()
    const available = capabilitiesFor(
      { state: 'APPROVED', completeness: { satisfied: 5 } }, {})
    for (let i = 0; i < 5; i++) await syncTools(available, () => {})
    expect(await browserTools()).toEqual([...available].sort())
  })

  it('a withdrawn capability is genuinely uncallable, not merely hidden', async () => {
    const { syncTools } = await loadRegistrar()
    const approved = capabilitiesFor({ state: 'APPROVED', completeness: { satisfied: 5 } }, {})
    await syncTools(approved, () => {})
    const handle = (await document.modelContext.getTools())
      .find((t) => t.name === 'submit_prior_authorization')
    expect(handle).toBeDefined()

    // Server withdraws it (back to awaiting approval).
    await syncTools(
      capabilitiesFor(
        { state: 'PREPARED_AWAITING_APPROVAL', completeness: { satisfied: 5 } }, {}),
      () => {})
    expect(await browserTools()).not.toContain('submit_prior_authorization')
    // The stale handle must not execute.
    await expect(document.modelContext.executeTool(handle, '{}')).rejects.toThrow()
  })
})
