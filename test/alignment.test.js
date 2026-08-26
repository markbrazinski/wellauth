// Coverage alignment decides whether the scheduled MRI is administratively
// blocked. Getting it wrong either hides a real gap or invents a false one.

import { describe, expect, it } from 'vitest'
import { derivePosture, evaluateAlignment } from '../provider/remediation.js'
import { EXTENDED_VALID_THROUGH, INITIAL_VALID_THROUGH, SCHEDULED_SERVICE_DATE }
  from '../provider/fixture.js'
import { awaitingPayer } from '../src/App'

describe('evaluateAlignment', () => {
  it('reports the canonical fixture as NOT covered', () => {
    const a = evaluateAlignment({
      scheduledServiceDate: SCHEDULED_SERVICE_DATE,
      validThrough: INITIAL_VALID_THROUGH,
    })
    expect(a.aligned).toBe(false)
  })

  it('reports coverage once extended', () => {
    expect(evaluateAlignment({
      scheduledServiceDate: SCHEDULED_SERVICE_DATE,
      validThrough: EXTENDED_VALID_THROUGH,
    }).aligned).toBe(true)
  })

  it('treats the boundary date as covered', () => {
    expect(evaluateAlignment({
      scheduledServiceDate: '2026-09-18', validThrough: '2026-09-18',
    }).aligned).toBe(true)
  })

  it('cannot decide without both dates', () => {
    expect(evaluateAlignment({ scheduledServiceDate: null, validThrough: '2026-09-12' })
      .aligned).toBe(null)
    expect(evaluateAlignment({ scheduledServiceDate: '2026-09-18', validThrough: null })
      .aligned).toBe(null)
  })
})

describe('derivePosture', () => {
  const approved = {
    submission: {
      state: 'COMPLETE', payerStatus: 'approved',
      receipt: { preAuthPeriod: { end: INITIAL_VALID_THROUGH } },
    },
  }

  it('stays silent until a payer approval is persisted', () => {
    expect(derivePosture({}, SCHEDULED_SERVICE_DATE).phase).toBe(null)
    expect(derivePosture({ submission: { state: 'SUBMITTING' } }, SCHEDULED_SERVICE_DATE).phase)
      .toBe(null)
  })

  it('never opens remediation on a denial', () => {
    expect(derivePosture(
      { submission: { state: 'COMPLETE', payerStatus: 'denied' } },
      SCHEDULED_SERVICE_DATE,
    ).phase).toBe(null)
  })

  it('detects the coverage gap from persisted payer state', () => {
    expect(derivePosture(approved, SCHEDULED_SERVICE_DATE).phase)
      .toBe('PAYER_APPROVED_COVERAGE_GAP')
  })

  it('offers no remediation when the window already covers the service', () => {
    const covered = {
      submission: {
        state: 'COMPLETE', payerStatus: 'approved',
        receipt: { preAuthPeriod: { end: EXTENDED_VALID_THROUGH } },
      },
    }
    expect(derivePosture(covered, SCHEDULED_SERVICE_DATE).phase).toBe('AUTHORIZATION_ALIGNED')
  })

  it('follows the durable remediation record once one exists', () => {
    expect(derivePosture(
      { ...approved, remediation: { state: 'REMEDIATION_PREPARED',
                                    currentValidThrough: INITIAL_VALID_THROUGH } },
      SCHEDULED_SERVICE_DATE,
    ).phase).toBe('REMEDIATION_PREPARED')
  })

  it('reaches AUTHORIZATION_ALIGNED only when validity actually covers the date', () => {
    expect(derivePosture(
      { ...approved, remediation: { state: 'REMEDIATION_SUBMITTED',
                                    currentValidThrough: EXTENDED_VALID_THROUGH } },
      SCHEDULED_SERVICE_DATE,
    ).phase).toBe('AUTHORIZATION_ALIGNED')
  })
})

// The page must keep polling exactly while the payer owes an outcome the
// browser cannot cause -- and must stop at every terminal state, or the demo
// machine sits in a refresh loop forever.
describe('awaitingPayer (external-update polling trigger)', () => {
  const snap = (extra) => ({ submission: null, remediation: null, ...extra })

  it('does not poll before any submission exists', () => {
    expect(awaitingPayer(snap({}))).toBe(false)
    expect(awaitingPayer(null)).toBe(false)
  })

  it('polls while an Act I submission is pending', () => {
    expect(awaitingPayer(snap({ submission: { state: 'SUBMITTED_OR_PENDING' } }))).toBe(true)
  })

  it('stops once the payer has decided', () => {
    for (const payerStatus of ['approved', 'denied']) {
      expect(awaitingPayer(snap({ submission: { state: 'COMPLETE', payerStatus } }))).toBe(false)
    }
  })

  it('polls while an Act II extension is pending, and stops when it lands', () => {
    const rem = (outcome) => snap({
      submission: { state: 'COMPLETE', payerStatus: 'approved' },
      remediation: { submission: { outcome } },
    })
    expect(awaitingPayer(rem('pending'))).toBe(true)
    expect(awaitingPayer(rem('approved'))).toBe(false)
    expect(awaitingPayer(rem(null))).toBe(false)
  })
})
