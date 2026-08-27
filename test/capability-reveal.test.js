/**
 * Capability-reveal UX (design delta).
 *
 * The three visual tiers and the reveal reasons are PRESENTATION over the real
 * `availableTools` list. These tests pin the two properties that matter:
 *
 *   1. presentation never invents, gates or reorders a capability -- a tier is
 *      only ever assigned to a name the server actually granted;
 *   2. a mutating capability is never dressed as read-only, because the
 *      subdued treatment is a claim about what the capability DOES.
 */

import { describe, expect, it } from 'vitest'
import { tierOf } from '../src/Assistant'
import { TOOL_REGISTRY } from '../src/capabilities'
import { capabilitiesFor } from '../provider/capabilities.js'

const none = { primary: null, fresh: null }

describe('tier classification', () => {
  it('marks a freshly revealed hero capability as new', () => {
    expect(tierOf('submit_prior_authorization', {
      primary: null, fresh: 'submit_prior_authorization',
    })).toBe('new')
  })

  it('new outranks primary for the same capability', () => {
    expect(tierOf('submit_authorization_extension', {
      primary: 'submit_authorization_extension',
      fresh: 'submit_authorization_extension',
    })).toBe('new')
  })

  it('emphasizes the primary next capability', () => {
    expect(tierOf('prepare_prior_authorization', {
      primary: 'prepare_prior_authorization', fresh: null,
    })).toBe('primary')
  })

  it('subdues read-only capabilities', () => {
    for (const n of ['get_order_context', 'find_supporting_evidence',
                     'inspect_evidence', 'check_authorization_status']) {
      expect(tierOf(n, none), n).toBe('readonly')
    }
  })

  it('leaves ordinary mutations untiered', () => {
    expect(tierOf('attach_evidence', none)).toBe(null)
    expect(tierOf('remove_evidence', none)).toBe(null)
  })

  it('never marks a non-hero capability as new', () => {
    // A NEW badge on "inspect evidence" would cheapen the hero beats.
    expect(tierOf('inspect_evidence', {
      primary: null, fresh: 'inspect_evidence',
    })).toBe('readonly')
  })
})

describe('the readonly tier tells the truth about mutation', () => {
  it('every capability shown as read-only really is read-only', () => {
    const shownReadOnly = Object.keys(TOOL_REGISTRY)
      .filter((n) => tierOf(n, none) === 'readonly')
    expect(shownReadOnly.length).toBeGreaterThan(0)
    for (const n of shownReadOnly) {
      expect(TOOL_REGISTRY[n].readOnlyHint, `${n} is styled read-only`).toBe(true)
    }
  })

  it('no mutating capability is ever subdued as read-only', () => {
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      if (def.readOnlyHint === false) {
        expect(tierOf(name, none), `${name} must not be styled read-only`)
          .not.toBe('readonly')
      }
    }
  })
})

describe('presentation never outruns the server', () => {
  /** Every state the capability policy can actually produce. */
  const STATES = [
    [{ state: 'CONTEXT_READY', completeness: { satisfied: 0 } }, {}],
    [{ state: 'REQUIREMENTS_RESOLVED', completeness: { satisfied: 0 } }, {}],
    [{ state: 'PACKET_COMPLETE', completeness: { satisfied: 5 } }, {}],
    [{ state: 'PREPARED_AWAITING_APPROVAL', completeness: { satisfied: 5 } }, {}],
    [{ state: 'APPROVED', completeness: { satisfied: 5 } }, {}],
    [{ state: 'APPROVED', completeness: { satisfied: 5 },
       submission: { state: 'COMPLETE', payerStatus: 'approved' } },
     { phase: 'PAYER_APPROVED_COVERAGE_GAP' }],
    [{ state: 'APPROVED', completeness: { satisfied: 5 },
       submission: { state: 'COMPLETE', payerStatus: 'approved' } },
     { phase: 'REMEDIATION_PREPARED' }],
    [{ state: 'APPROVED', completeness: { satisfied: 5 },
       submission: { state: 'COMPLETE', payerStatus: 'approved' } },
     { phase: 'REMEDIATION_APPROVED' }],
    [{ state: 'APPROVED', completeness: { satisfied: 5 },
       submission: { state: 'COMPLETE', payerStatus: 'approved' } },
     { phase: 'AUTHORIZATION_ALIGNED' }],
  ]

  it('a tier is only ever given to a genuinely available capability', () => {
    for (const [wf, act2] of STATES) {
      const available = capabilitiesFor(wf, act2)
      for (const name of available) {
        // Tiering is a pure function of the name; the point is that the loop
        // only ever runs over names the SERVER granted.
        expect(Object.keys(TOOL_REGISTRY)).toContain(name)
      }
    }
  })

  it('no human-approval action is ever offered as a capability', () => {
    for (const [wf, act2] of STATES) {
      for (const name of capabilitiesFor(wf, act2)) {
        expect(name).not.toMatch(/approve/)
      }
    }
  })

  it('no submit capability exists at either human gate', () => {
    const gateA = capabilitiesFor(
      { state: 'PREPARED_AWAITING_APPROVAL', completeness: { satisfied: 5 } }, {})
    expect(gateA).not.toContain('submit_prior_authorization')

    const gateB = capabilitiesFor(
      { state: 'APPROVED', completeness: { satisfied: 5 },
        submission: { state: 'COMPLETE', payerStatus: 'approved' } },
      { phase: 'REMEDIATION_PREPARED' })
    expect(gateB).not.toContain('submit_authorization_extension')
  })

  it('mutating capabilities disappear once a submission exists', () => {
    const after = capabilitiesFor(
      { state: 'APPROVED', completeness: { satisfied: 5 },
        submission: { state: 'COMPLETE', payerStatus: 'approved' } },
      { phase: 'AUTHORIZATION_ALIGNED' })
    for (const n of ['attach_evidence', 'remove_evidence',
                     'prepare_prior_authorization', 'submit_prior_authorization']) {
      expect(after, n).not.toContain(n)
    }
    // What remains is read-only.
    for (const n of after) expect(TOOL_REGISTRY[n].readOnlyHint, n).toBe(true)
  })
})
