// Deterministic proofs against the authoritative backend state machine.
// No browser, no mocks -- this is the same module the HTTP server calls.

import { beforeEach, describe, expect, it } from 'vitest'
import * as store from '../server/state.js'

const ALL = [
  'get_order_context',
  'discover_coverage_requirements',
  'find_supporting_evidence',
  'inspect_evidence',
  'bind_evidence',
  'prepare_prior_authorization',
  'submit_prior_authorization',
]

/** Drive the workflow to a fully-bound packet. */
function bindAll() {
  store.discoverRequirements()
  const pairs = [
    ['req-001', 'ev-100'],
    ['req-002', 'ev-101'],
    ['req-003', 'ev-102'],
    ['req-004', 'ev-103'],
    ['req-005', 'ev-104'],
  ]
  for (const [r, e] of pairs) store.bindEvidence(r, e)
}

beforeEach(() => store.reset())

describe('capability inventory per state', () => {
  it('1. initial state registers exactly 2 tools', () => {
    const s = store.snapshot()
    expect(s.workflowState).toBe('CONTEXT_READY')
    expect(s.availableTools).toEqual([
      'get_order_context',
      'discover_coverage_requirements',
    ])
    expect(s.availableTools).toHaveLength(2)
  })

  it('2. requirements-resolved state registers exactly 5', () => {
    store.discoverRequirements()
    const s = store.snapshot()
    expect(s.workflowState).toBe('REQUIREMENTS_RESOLVED')
    expect(s.availableTools).toHaveLength(5)
    expect(s.availableTools).toContain('find_supporting_evidence')
    expect(s.availableTools).toContain('inspect_evidence')
    expect(s.availableTools).toContain('bind_evidence')
  })

  it('3. reset returns to exactly 2', () => {
    bindAll()
    expect(store.snapshot().availableTools.length).toBeGreaterThan(2)
    const s = store.reset()
    expect(s.workflowState).toBe('CONTEXT_READY')
    expect(s.availableTools).toHaveLength(2)
    expect(s.availableTools).not.toContain('bind_evidence')
  })

  it('4. packet-complete state adds prepare_prior_authorization', () => {
    bindAll()
    const s = store.snapshot()
    expect(s.workflowState).toBe('PACKET_COMPLETE')
    expect(s.availableTools).toHaveLength(6)
    expect(s.availableTools).toContain('prepare_prior_authorization')
  })

  it('5. incomplete state never exposes prepare_prior_authorization', () => {
    // Every state short of a fully-bound packet must withhold it.
    expect(store.snapshot().availableTools).not.toContain('prepare_prior_authorization')

    store.discoverRequirements()
    expect(store.snapshot().availableTools).not.toContain('prepare_prior_authorization')

    store.bindEvidence('req-001', 'ev-100')
    store.bindEvidence('req-002', 'ev-101')
    store.bindEvidence('req-003', 'ev-102')
    store.bindEvidence('req-004', 'ev-103')
    const s = store.snapshot()
    expect(s.satisfiedCount).toBe(4)
    expect(s.availableTools).not.toContain('prepare_prior_authorization')
  })

  it('every state maps only to known tool names', () => {
    for (const state of store.STATES) {
      for (const name of store.TOOLS_BY_STATE[state]) {
        expect(ALL).toContain(name)
      }
    }
  })
})

describe('6. tools return schema-valid deterministic results', () => {
  it('get_order_context is deterministic and synthetic', () => {
    const a = store.getOrderContext()
    const b = store.getOrderContext()
    expect(a).toEqual(b)
    expect(a).toEqual({
      patientId: 'synthetic-patient-0001',
      orderId: 'synthetic-order-7731',
      orderedService: 'Cardiac MRI',
      serviceCode: '75561',
      status: 'ordered',
      priorAuthorizationRequired: true,
    })
    // No real PHI: every identifier is explicitly marked synthetic.
    expect(a.patientId).toMatch(/^synthetic-/)
  })

  it('discover_coverage_requirements returns exactly five stable requirements', () => {
    const first = store.discoverRequirements()
    expect(first.requirements).toHaveLength(5)
    for (const r of first.requirements) {
      expect(typeof r.id).toBe('string')
      expect(typeof r.label).toBe('string')
      expect(typeof r.evidenceType).toBe('string')
    }
    const second = store.discoverRequirements()
    expect(second.requirements).toEqual(first.requirements)
  })

  it('find/inspect evidence return schema-valid shapes', () => {
    store.discoverRequirements()
    const all = store.findEvidence()
    expect(all.evidence).toHaveLength(5)

    const filtered = store.findEvidence('req-002')
    expect(filtered.evidence).toHaveLength(1)
    expect(filtered.evidence[0].evidenceId).toBe('ev-101')

    const hit = store.inspectEvidence('ev-100')
    expect(hit.found).toBe(true)
    expect(hit.evidence.title).toBe('Cardiology consult note')

    // Failures are returned as data, because WebMCP rejections lose detail.
    const miss = store.inspectEvidence('ev-does-not-exist')
    expect(miss.found).toBe(false)
    expect(miss.reason).toBe('UNKNOWN_EVIDENCE_ID')
  })
})

describe('0A. discovery advances state and populates the page', () => {
  it('commits REQUIREMENTS_RESOLVED and exposes requirements to the UI', () => {
    const before = store.snapshot()
    expect(before.requirements).toEqual([])
    expect(before.workflowState).toBe('CONTEXT_READY')

    const result = store.discoverRequirements()
    const after = store.snapshot()

    expect(result.requirements).toHaveLength(5)          // agent got structured data
    expect(after.workflowState).toBe('REQUIREMENTS_RESOLVED') // server advanced
    expect(after.requirements).toHaveLength(5)           // page will render them
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.availableTools).toHaveLength(5)         // inventory expanded
  })
})

describe('0B. evidence binding advances 4/5 -> 5/5', () => {
  it('commits the binding and registers prepare_prior_authorization', () => {
    store.discoverRequirements()
    store.bindEvidence('req-001', 'ev-100')
    store.bindEvidence('req-002', 'ev-101')
    store.bindEvidence('req-003', 'ev-102')
    store.bindEvidence('req-004', 'ev-103')

    const before = store.snapshot()
    expect(before.satisfiedCount).toBe(4)
    expect(before.availableTools).not.toContain('prepare_prior_authorization')

    const result = store.bindEvidence('req-005', 'ev-104')
    expect(result.ok).toBe(true)

    const after = store.snapshot()
    expect(after.satisfiedCount).toBe(5)
    expect(after.workflowState).toBe('PACKET_COMPLETE')
    expect(after.requirements.every((r) => r.satisfied)).toBe(true)
    expect(after.requirements.find((r) => r.id === 'req-005').boundEvidenceId).toBe('ev-104')
    expect(after.availableTools).toContain('prepare_prior_authorization')
    expect(after.revision).toBeGreaterThan(before.revision)
  })
})

describe('0C. backend refusal does not create fake success', () => {
  it('refuses mismatched evidence and does not advance revision or state', () => {
    store.discoverRequirements()
    store.bindEvidence('req-001', 'ev-100')
    store.bindEvidence('req-002', 'ev-101')
    store.bindEvidence('req-003', 'ev-102')
    store.bindEvidence('req-004', 'ev-103')
    const before = store.snapshot()

    // ev-100 supports req-001, not req-005.
    const refused = store.bindEvidence('req-005', 'ev-100')

    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('EVIDENCE_DOES_NOT_SATISFY_REQUIREMENT')

    const after = store.snapshot()
    expect(after.satisfiedCount).toBe(4)                    // still 4/5
    expect(after.workflowState).toBe('REQUIREMENTS_RESOLVED')
    expect(after.revision).toBe(before.revision)            // revision did NOT advance
    expect(after.availableTools).not.toContain('prepare_prior_authorization')
  })

  it('refuses unknown ids without side effects', () => {
    store.discoverRequirements()
    const before = store.snapshot()

    expect(store.bindEvidence('req-nope', 'ev-100').reason).toBe('UNKNOWN_REQUIREMENT_ID')
    expect(store.bindEvidence('req-001', 'ev-nope').reason).toBe('UNKNOWN_EVIDENCE_ID')

    const after = store.snapshot()
    expect(after.satisfiedCount).toBe(0)
    expect(after.revision).toBe(before.revision)
  })

  it('refuses preparation while the packet is incomplete', () => {
    store.discoverRequirements()
    store.bindEvidence('req-001', 'ev-100')
    const before = store.snapshot()

    const refused = store.preparePriorAuthorization()
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('PACKET_INCOMPLETE')
    expect(store.snapshot().revision).toBe(before.revision)
    expect(store.snapshot().preparedPacket).toBeNull()
  })
})

describe('0D. preparation transitions to PREPARED_AWAITING_APPROVAL', () => {
  it('reveals the disclosure and removes the agent path forward', () => {
    bindAll()
    const result = store.preparePriorAuthorization()
    expect(result.ok).toBe(true)

    const s = store.snapshot()
    expect(s.workflowState).toBe('PREPARED_AWAITING_APPROVAL')
    expect(s.preparedPacket).not.toBeNull()
    expect(s.preparedPacket.destinationPayer).toContain('Synthetic Payer')
    expect(s.preparedPacket.proposedDisclosure).toHaveLength(5)
    expect(s.preparedPacket.packetHash).toMatch(/^[0-9a-f]{16}$/)
    expect(s.preparedPacket.complete).toBe(true)

    // The agent has NO capability that advances this state.
    expect(s.availableTools).not.toContain('submit_prior_authorization')
    expect(s.availableTools).not.toContain('prepare_prior_authorization')
    expect(s.availableTools).toHaveLength(5)
  })
})

describe('0E. human approval changes agent capabilities', () => {
  it('approval registers submit_prior_authorization', () => {
    bindAll()
    store.preparePriorAuthorization()
    const prepared = store.snapshot()
    expect(prepared.availableTools).not.toContain('submit_prior_authorization')

    const result = store.approve(prepared.preparedPacket.packetHash)
    expect(result.ok).toBe(true)

    const after = store.snapshot()
    expect(after.workflowState).toBe('APPROVED')
    expect(after.approval.approvedPacketHash).toBe(prepared.preparedPacket.packetHash)
    expect(after.availableTools).toContain('submit_prior_authorization')
    expect(after.availableTools).toHaveLength(6)
  })

  it('approval is pinned to the exact prepared packet hash', () => {
    bindAll()
    store.preparePriorAuthorization()
    const before = store.snapshot()

    const stale = store.approve('deadbeefdeadbeef')
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe('STALE_PACKET_HASH')
    expect(store.snapshot().workflowState).toBe('PREPARED_AWAITING_APPROVAL')
    expect(store.snapshot().revision).toBe(before.revision)
    expect(store.snapshot().availableTools).not.toContain('submit_prior_authorization')
  })

  it('approval cannot happen before preparation', () => {
    bindAll()
    const refused = store.approve('anything')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('NOTHING_PREPARED')
  })

  it('no WebMCP tool in any state can perform approval', () => {
    // Approval exists only as an HTTP route the human UI calls. If a tool name
    // containing "approve" ever appears in an inventory, the gate is broken.
    for (const state of store.STATES) {
      for (const name of store.TOOLS_BY_STATE[state]) {
        expect(name).not.toMatch(/approve/i)
      }
    }
  })
})

describe('Gate 0 submission stub', () => {
  it('submit exists after approval but refuses to submit', () => {
    bindAll()
    store.preparePriorAuthorization()
    store.approve(store.snapshot().preparedPacket.packetHash)

    const result = store.submitPriorAuthorization()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('NOT_IMPLEMENTED_GATE_0')
    // State must not advance past APPROVED in Gate 0.
    expect(store.snapshot().workflowState).toBe('APPROVED')
  })

  it('submit refuses outright when not approved', () => {
    bindAll()
    store.preparePriorAuthorization()
    const result = store.submitPriorAuthorization()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('NOT_APPROVED')
  })
})

describe('7. state synchronization invariant', () => {
  it('availableTools always equals TOOLS_BY_STATE for the current state', () => {
    const checkpoints = []
    const capture = () => {
      const s = store.snapshot()
      checkpoints.push(s.workflowState)
      expect(s.availableTools).toEqual(store.TOOLS_BY_STATE[s.workflowState])
    }

    capture()
    store.discoverRequirements(); capture()
    store.bindEvidence('req-001', 'ev-100'); capture()
    store.bindEvidence('req-002', 'ev-101')
    store.bindEvidence('req-003', 'ev-102')
    store.bindEvidence('req-004', 'ev-103')
    store.bindEvidence('req-005', 'ev-104'); capture()
    store.preparePriorAuthorization(); capture()
    store.approve(store.snapshot().preparedPacket.packetHash); capture()
    store.reset(); capture()

    expect(checkpoints).toEqual([
      'CONTEXT_READY',
      'REQUIREMENTS_RESOLVED',
      'REQUIREMENTS_RESOLVED',
      'PACKET_COMPLETE',
      'PREPARED_AWAITING_APPROVAL',
      'APPROVED',
      'CONTEXT_READY',
    ])
  })

  it('the packet cannot be mutated once prepared', () => {
    bindAll()
    store.preparePriorAuthorization()
    const before = store.snapshot()

    const refused = store.bindEvidence('req-001', 'ev-100')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('PACKET_LOCKED')
    expect(store.snapshot().revision).toBe(before.revision)
    expect(store.snapshot().preparedPacket.packetHash).toBe(before.preparedPacket.packetHash)
  })

  it('revision advances only on committed change', () => {
    const r0 = store.snapshot().revision
    store.getOrderContext()
    store.findEvidence()
    expect(store.snapshot().revision).toBe(r0) // pure reads do not advance

    store.discoverRequirements()
    expect(store.snapshot().revision).toBeGreaterThan(r0)
  })
})
