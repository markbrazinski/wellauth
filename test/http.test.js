// End-to-end proofs over real HTTP against the running backend.
//
// The reload tests matter most: they prove the UI can reconstruct itself from
// server state alone, with no React state and no prior WebMCP invocation
// surviving in browser memory.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import * as store from '../server/state.js'

let base

const ROUTES = {
  'GET /api/state': () => store.snapshot(),
  'POST /api/reset': () => store.reset(),
  'POST /api/order-context': () => store.getOrderContext(),
  'POST /api/discover-requirements': () => store.discoverRequirements(),
  'POST /api/find-evidence': (b) => store.findEvidence(b.requirementId),
  'POST /api/inspect-evidence': (b) => store.inspectEvidence(b.evidenceId),
  'POST /api/bind-evidence': (b) => store.bindEvidence(b.requirementId, b.evidenceId),
  'POST /api/prepare': () => store.preparePriorAuthorization(),
  'POST /api/approve': (b) => store.approve(b.packetHash),
  'POST /api/submit': () => store.submitPriorAuthorization(),
}

let server

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const handler = ROUTES[`${req.method} ${req.url.split('?')[0]}`]
    if (!handler) return res.writeHead(404).end('{}')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(handler(body)))
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://localhost:${server.address().port}`
})

afterAll(() => new Promise((r) => server.close(r)))
beforeEach(() => store.reset())

const get = (p) => fetch(`${base}${p}`).then((r) => r.json())
const post = (p, body = {}) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

/** A fresh GET /api/state is exactly what a page reload does. */
const reload = () => get('/api/state')

async function driveToApproved() {
  await post('/api/discover-requirements')
  await post('/api/bind-evidence', { requirementId: 'req-001', evidenceId: 'ev-100' })
  await post('/api/bind-evidence', { requirementId: 'req-002', evidenceId: 'ev-101' })
  await post('/api/bind-evidence', { requirementId: 'req-003', evidenceId: 'ev-102' })
  await post('/api/bind-evidence', { requirementId: 'req-004', evidenceId: 'ev-103' })
  await post('/api/bind-evidence', { requirementId: 'req-005', evidenceId: 'ev-104' })
  await post('/api/prepare')
  const prepared = await reload()
  await post('/api/approve', { packetHash: prepared.preparedPacket.packetHash })
}

describe('tools are reachable over HTTP and return deterministic data', () => {
  it('get_order_context', async () => {
    const a = await post('/api/order-context')
    const b = await post('/api/order-context')
    expect(a).toEqual(b)
    expect(a.orderedService).toBe('Cardiac MRI')
    expect(a.priorAuthorizationRequired).toBe(true)
  })

  it('discover_coverage_requirements returns five and advances state', async () => {
    expect((await reload()).workflowState).toBe('CONTEXT_READY')
    const result = await post('/api/discover-requirements')
    expect(result.requirements).toHaveLength(5)
    expect((await reload()).workflowState).toBe('REQUIREMENTS_RESOLVED')
  })
})

describe('reload recovery reconstructs UI state from the server', () => {
  it('recovers REQUIREMENTS_RESOLVED', async () => {
    await post('/api/discover-requirements')
    const s = await reload()
    expect(s.workflowState).toBe('REQUIREMENTS_RESOLVED')
    expect(s.requirements).toHaveLength(5)
    expect(s.availableTools).toHaveLength(5)
  })

  it('recovers PACKET_COMPLETE with bindings intact', async () => {
    await post('/api/discover-requirements')
    for (const [r, e] of [
      ['req-001', 'ev-100'],
      ['req-002', 'ev-101'],
      ['req-003', 'ev-102'],
      ['req-004', 'ev-103'],
      ['req-005', 'ev-104'],
    ]) {
      await post('/api/bind-evidence', { requirementId: r, evidenceId: e })
    }
    const s = await reload()
    expect(s.workflowState).toBe('PACKET_COMPLETE')
    expect(s.satisfiedCount).toBe(5)
    expect(s.requirements.every((r) => r.satisfied)).toBe(true)
    expect(s.availableTools).toContain('prepare_prior_authorization')
  })

  it('recovers PREPARED_AWAITING_APPROVAL with the disclosure', async () => {
    await post('/api/discover-requirements')
    for (const [r, e] of [
      ['req-001', 'ev-100'],
      ['req-002', 'ev-101'],
      ['req-003', 'ev-102'],
      ['req-004', 'ev-103'],
      ['req-005', 'ev-104'],
    ]) {
      await post('/api/bind-evidence', { requirementId: r, evidenceId: e })
    }
    await post('/api/prepare')

    const s = await reload()
    expect(s.workflowState).toBe('PREPARED_AWAITING_APPROVAL')
    expect(s.preparedPacket.proposedDisclosure).toHaveLength(5)
    expect(s.preparedPacket.destinationPayer).toBeTruthy()
    expect(s.availableTools).not.toContain('submit_prior_authorization')
  })

  it('recovers APPROVED and the submit capability', async () => {
    await driveToApproved()
    const s = await reload()
    expect(s.workflowState).toBe('APPROVED')
    expect(s.approval).not.toBeNull()
    expect(s.availableTools).toContain('submit_prior_authorization')
  })

  it('repeated reloads are stable and do not advance state', async () => {
    await driveToApproved()
    const a = await reload()
    const b = await reload()
    const c = await reload()
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

describe('0C over HTTP: refusal leaves the page unchanged', () => {
  it('mismatched binding is refused and 4/5 holds', async () => {
    await post('/api/discover-requirements')
    for (const [r, e] of [
      ['req-001', 'ev-100'],
      ['req-002', 'ev-101'],
      ['req-003', 'ev-102'],
      ['req-004', 'ev-103'],
    ]) {
      await post('/api/bind-evidence', { requirementId: r, evidenceId: e })
    }
    const before = await reload()

    const refused = await post('/api/bind-evidence', {
      requirementId: 'req-005',
      evidenceId: 'ev-100',
    })
    expect(refused.ok).toBe(false)

    const after = await reload()
    expect(after.satisfiedCount).toBe(4)
    expect(after.revision).toBe(before.revision)
    expect(after.availableTools).not.toContain('prepare_prior_authorization')
  })
})

describe('0E over HTTP: approval is human-only and gates submit', () => {
  it('submit is absent before approval and present after', async () => {
    await post('/api/discover-requirements')
    for (const [r, e] of [
      ['req-001', 'ev-100'],
      ['req-002', 'ev-101'],
      ['req-003', 'ev-102'],
      ['req-004', 'ev-103'],
      ['req-005', 'ev-104'],
    ]) {
      await post('/api/bind-evidence', { requirementId: r, evidenceId: e })
    }
    await post('/api/prepare')

    const prepared = await reload()
    expect(prepared.availableTools).not.toContain('submit_prior_authorization')

    await post('/api/approve', { packetHash: prepared.preparedPacket.packetHash })

    const approved = await reload()
    expect(approved.workflowState).toBe('APPROVED')
    expect(approved.availableTools).toContain('submit_prior_authorization')
  })

  it('submit refuses with NOT_IMPLEMENTED_GATE_0 after approval', async () => {
    await driveToApproved()
    const result = await post('/api/submit')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('NOT_IMPLEMENTED_GATE_0')
    expect((await reload()).workflowState).toBe('APPROVED')
  })
})
