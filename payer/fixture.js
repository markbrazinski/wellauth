// Canonical synthetic-payer fixture. SINGLE SOURCE for every Act II date and
// reference value; the spec requires these literals not be scattered across
// frontend and backend code.
//
// Northstar Health Plan is FICTIONAL and every value here is synthetic.
//
// The Act I approval is deliberately granted a validity window that ENDS
// BEFORE the already-scheduled MRI. That mismatch is the entire point of
// Act II: the payer says "approved" while the scheduled care stays
// administratively blocked. The dates are fixed rather than computed from
// "now" so the demo is deterministic on any day it is run.

/** The already-scheduled service. Clinical truth; never mutated by Act II. */
export const SCHEDULED_SERVICE_DATE = '2026-09-18'
export const SCHEDULED_SERVICE_DISPLAY = 'September 18 · 9:30 AM'

/** Payer authorization reference for the canonical workflow. */
export const CANONICAL_AUTHORIZATION_REFERENCE = 'NS-40192'

/** Initial validity: ends BEFORE the scheduled MRI. */
export const INITIAL_VALID_THROUGH = '2026-09-12'

/** The only validity end the payer will grant on remediation. */
export const EXTENDED_VALID_THROUGH = '2026-10-03'

/** Start of the authorization window. */
export const VALID_FROM = '2026-08-26'

/**
 * The canonical workflow whose authorization reference is pinned. Any other
 * identifier still gets a derived reference -- the fixture pins the demo, it
 * does not special-case correctness.
 */
export const CANONICAL_WORKFLOW_ID = 'wf-wellauth-001'

export const REMEDIATION_REASON_CODE = 'scheduled-service-outside-authorization-window'
export const REMEDIATION_REASON_DISPLAY =
  'Scheduled service falls outside the current authorization validity window.'
