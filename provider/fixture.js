// Canonical Act II fixture, provider side. Re-exports the payer's single
// source so the two services cannot drift apart on dates or references.
//
// ponytail: a re-export, not a second copy. Same reasoning as payer/canonical.js.
export {
  CANONICAL_AUTHORIZATION_REFERENCE,
  CANONICAL_WORKFLOW_ID,
  EXTENDED_VALID_THROUGH,
  INITIAL_VALID_THROUGH,
  REMEDIATION_REASON_CODE,
  REMEDIATION_REASON_DISPLAY,
  SCHEDULED_SERVICE_DATE,
  SCHEDULED_SERVICE_DISPLAY,
  VALID_FROM,
} from '../payer/fixture.js'
