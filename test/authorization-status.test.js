/**
 * P0-2: after AUTHORIZATION_ALIGNED, check_authorization_status must report the
 * EFFECTIVE authorization -- not the original Act I receipt window.
 *
 * The audit found the UI showing Oct 3 while the tool still returned Sep 12.
 * These tests pin the exact contract the commission requires, and equally that
 * the original Sep 12 receipt survives as history rather than being overwritten.
 */

import { describe, expect, it } from 'vitest'
import { projectAuthorizationStatus } from '../provider/submission.js'
import {
  CANONICAL_AUTHORIZATION_REFERENCE,
  EXTENDED_VALID_THROUGH,
  INITIAL_VALID_THROUGH,
  SCHEDULED_SERVICE_DATE,
  VALID_FROM,
} from '../provider/fixture.js'

const W = 'wf-wellauth-001'

/** Act I complete: payer approved, window ENDS BEFORE the scheduled MRI. */
const actOneApproved = {
  state: 'APPROVED',
  payer: 'Northstar Health Plan',
  submission: {
    state: 'COMPLETE',
    payerStatus: 'approved',
    claimIdentifier: 'WA-wf-wellauth-001-057feedea98cc37297a4904e',
    attempts: 1,
    completedAt: '2026-08-27T04:23:51.556Z',
    receipt: {
      payerReference: CANONICAL_AUTHORIZATION_REFERENCE,
      receiptId: 'NS-RCPT-a4bfe900',
      disposition: 'Prior authorization approved by simulated payer',
      preAuthPeriod: { start: VALID_FROM, end: INITIAL_VALID_THROUGH },
      receivedAt: '2026-08-27T04:23:51.556Z',
    },
  },
}

/** Act II complete: the payer extended the window through Oct 3. */
const aligned = {
  ...actOneApproved,
  remediation: {
    state: 'AUTHORIZATION_ALIGNED',
    currentValidThrough: EXTENDED_VALID_THROUGH,
    scheduledServiceDate: SCHEDULED_SERVICE_DATE,
    payerAuthorizationReference: CANONICAL_AUTHORIZATION_REFERENCE,
    submission: { extensionReceiptId: 'NS-EXT-77c1', outcome: 'applied' },
  },
}

describe('before Act II -- the original window is the effective window', () => {
  const s = projectAuthorizationStatus(W, actOneApproved, SCHEDULED_SERVICE_DATE)

  it('reports the Sep 12 window as in force', () => {
    expect(s.validThrough).toBe(INITIAL_VALID_THROUGH)
    expect(s.authorizationPeriod).toEqual({ start: VALID_FROM, end: INITIAL_VALID_THROUGH })
  })

  it('reports the scheduled MRI as NOT covered', () => {
    expect(s.coversScheduledServiceDate).toBe(false)
    expect(s.administrativeReadiness).toBe('blocked')
  })

  it('does not claim an extension that never happened', () => {
    expect(s.authorizationExtended).toBe(false)
    expect(s.remediationState).toBe(null)
  })
})

describe('P0-2 after AUTHORIZATION_ALIGNED -- every required field', () => {
  const s = projectAuthorizationStatus(W, aligned, SCHEDULED_SERVICE_DATE)

  it('payer is Northstar Health Plan', () => {
    expect(s.payer).toBe('Northstar Health Plan')
  })

  it('payer decision is approved', () => {
    expect(s.payerStatus).toBe('approved')
  })

  it('payer reference is NS-40192', () => {
    expect(s.payerReference).toBe('NS-40192')
  })

  it('scheduled service date is 2026-09-18', () => {
    expect(s.scheduledServiceDate).toBe('2026-09-18')
  })

  it('effective validity is through 2026-10-03, NOT the Sep 12 receipt', () => {
    expect(s.validThrough).toBe('2026-10-03')
    expect(s.validThrough).not.toBe(INITIAL_VALID_THROUGH)
    expect(s.authorizationPeriod.end).toBe('2026-10-03')
  })

  it('coversScheduledServiceDate is true', () => {
    expect(s.coversScheduledServiceDate).toBe(true)
  })

  it('administrative alignment is ready', () => {
    expect(s.administrativeReadiness).toBe('ready')
  })

  it('records that the authorization was extended', () => {
    expect(s.authorizationExtended).toBe(true)
    expect(s.remediationState).toBe('AUTHORIZATION_ALIGNED')
    expect(s.extensionReceiptId).toBe('NS-EXT-77c1')
  })
})

describe('P0-2 historical truth is preserved, never overwritten', () => {
  const s = projectAuthorizationStatus(W, aligned, SCHEDULED_SERVICE_DATE)

  it('keeps the ORIGINAL Sep 12 receipt window verbatim', () => {
    expect(s.originalAuthorization.authorizationPeriod)
      .toEqual({ start: VALID_FROM, end: INITIAL_VALID_THROUGH })
  })

  it('keeps the original receipt id and disposition', () => {
    expect(s.originalAuthorization.receiptId).toBe('NS-RCPT-a4bfe900')
    expect(s.originalAuthorization.disposition)
      .toBe('Prior authorization approved by simulated payer')
    expect(s.originalAuthorization.decidedAt).toBe('2026-08-27T04:23:51.556Z')
  })

  it('never reports more than one payer submission', () => {
    expect(s.attempts).toBe(1)
  })

  it('is still clearly labelled as a simulated payer', () => {
    expect(s.simulated).toBe(true)
    expect(s.simulationNotice).toMatch(/simulated payer/i)
  })
})

describe('the tool agrees with what the workspace renders', () => {
  it('reports the same validity the Aligned UI reads from remediation', () => {
    // src/LowerRegion.tsx Aligned{} renders remediation.currentValidThrough.
    const s = projectAuthorizationStatus(W, aligned, SCHEDULED_SERVICE_DATE)
    expect(s.validThrough).toBe(aligned.remediation.currentValidThrough)
    expect(s.scheduledServiceDate).toBe(aligned.remediation.scheduledServiceDate)
  })
})

describe('edge cases', () => {
  it('never guesses coverage when a date is missing', () => {
    const s = projectAuthorizationStatus(W, actOneApproved, null)
    expect(s.coversScheduledServiceDate).toBe(null)
    expect(s.administrativeReadiness).toBe('unknown')
  })

  it('treats the boundary date as covered', () => {
    const s = projectAuthorizationStatus(W, aligned, '2026-10-03')
    expect(s.coversScheduledServiceDate).toBe(true)
  })

  it('reports not-submitted before any submission exists', () => {
    const s = projectAuthorizationStatus(W, { state: 'CONTEXT_READY', payer: 'Northstar Health Plan' })
    expect(s.payerStatus).toBe('not-submitted')
    expect(s.submissionState).toBe(null)
  })

  it('an in-flight remediation does not yet claim the extended window', () => {
    const pending = {
      ...actOneApproved,
      remediation: { state: 'REMEDIATION_PREPARED', scheduledServiceDate: SCHEDULED_SERVICE_DATE },
    }
    const s = projectAuthorizationStatus(W, pending, SCHEDULED_SERVICE_DATE)
    expect(s.validThrough).toBe(INITIAL_VALID_THROUGH)
    expect(s.coversScheduledServiceDate).toBe(false)
    expect(s.authorizationExtended).toBe(false)
  })
})
