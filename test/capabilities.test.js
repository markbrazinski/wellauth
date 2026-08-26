// The capability lifecycle IS the product thesis: what may the browser agent
// do here, now? These assertions exist so that a change which lets a
// submission capability exist before its human approval fails loudly.

import { describe, expect, it } from 'vitest'
import { capabilitiesFor } from '../provider/capabilities.js'

const submitted = { state: 'COMPLETE', payerStatus: 'approved' }
const wf = (state, satisfied, submission) => ({
  state,
  completeness: { satisfied },
  ...(submission ? { submission } : {}),
})

describe('Act I capability lifecycle', () => {
  it('exposes only orientation and discovery at CONTEXT_READY', () => {
    expect(capabilitiesFor(wf('CONTEXT_READY', 0))).toEqual([
      'get_order_context',
      'discover_coverage_requirements',
    ])
  })

  it('adds evidence operations once requirements are resolved', () => {
    const caps = capabilitiesFor(wf('REQUIREMENTS_RESOLVED', 0))
    expect(caps).toContain('find_supporting_evidence')
    expect(caps).toContain('attach_evidence')
    // Nothing is bound yet, so there is nothing to remove.
    expect(caps).not.toContain('remove_evidence')
  })

  it('offers removal only when something is bound', () => {
    expect(capabilitiesFor(wf('REQUIREMENTS_RESOLVED', 4))).toContain('remove_evidence')
  })

  it('unlocks prepare only at 5/5', () => {
    expect(capabilitiesFor(wf('REQUIREMENTS_RESOLVED', 4)))
      .not.toContain('prepare_prior_authorization')
    expect(capabilitiesFor(wf('PACKET_COMPLETE', 5)))
      .toContain('prepare_prior_authorization')
  })

  // THE HUMAN GATE. The tool must be ABSENT, not disabled.
  it('exposes NO submission capability while awaiting human approval', () => {
    const caps = capabilitiesFor(wf('PREPARED_AWAITING_APPROVAL', 5))
    expect(caps).not.toContain('submit_prior_authorization')
    expect(caps).not.toContain('prepare_prior_authorization')
  })

  it('unlocks submit only after approval', () => {
    expect(capabilitiesFor(wf('APPROVED', 5))).toContain('submit_prior_authorization')
  })

  it('withdraws submit and mutation once a submission exists', () => {
    const caps = capabilitiesFor(wf('APPROVED', 5, submitted), { phase: null })
    expect(caps).not.toContain('submit_prior_authorization')
    expect(caps).not.toContain('attach_evidence')
    expect(caps).toContain('check_authorization_status')
  })

  it('never exposes an approval capability in any state', () => {
    for (const state of ['CONTEXT_READY', 'REQUIREMENTS_RESOLVED', 'PACKET_COMPLETE',
                         'PREPARED_AWAITING_APPROVAL', 'APPROVED']) {
      for (const name of capabilitiesFor(wf(state, 5))) {
        expect(name).not.toMatch(/approve/)
      }
    }
  })
})

describe('Act II capability lifecycle', () => {
  const base = wf('APPROVED', 5, submitted)

  it('does not offer remediation before the payer response is evaluated', () => {
    expect(capabilitiesFor(base, { phase: null }))
      .not.toContain('resolve_authorization_window')
  })

  it('unlocks remediation on a detected coverage gap', () => {
    expect(capabilitiesFor(base, { phase: 'PAYER_APPROVED_COVERAGE_GAP' }))
      .toContain('resolve_authorization_window')
  })

  // The second human gate, same construction as the first.
  it('exposes NO extension-submit capability while awaiting approval', () => {
    expect(capabilitiesFor(base, { phase: 'REMEDIATION_PREPARED' }))
      .not.toContain('submit_authorization_extension')
  })

  it('unlocks extension submit only after workforce approval', () => {
    expect(capabilitiesFor(base, { phase: 'REMEDIATION_APPROVED' }))
      .toContain('submit_authorization_extension')
  })

  it('withdraws all mutation at the terminal aligned state', () => {
    const caps = capabilitiesFor(base, { phase: 'AUTHORIZATION_ALIGNED' })
    expect(caps).not.toContain('submit_authorization_extension')
    expect(caps).not.toContain('resolve_authorization_window')
    expect(caps).toEqual(['get_order_context', 'check_authorization_status'])
  })
})
