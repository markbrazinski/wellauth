# Captured snapshots — canonical demo, deployed provider

Every file here is a **real HTTP response** captured on 2026-08-27 by driving
the complete canonical demo end-to-end against the deployed provider
(`wellauth-provider`, Cloud Run). Nothing is hand-written.

All data is synthetic. Northstar Health Plan is fictional. The payer is a
clearly labelled simulator.

These back the representative-JSON section of `../INTEGRATION-CONTRACT.md`.

| File | Beat |
|---|---|
| `01-initial-authorization-required.json` | CONTEXT_READY |
| `02-requirements-discovered.json` | REQUIREMENTS_RESOLVED |
| `03-four-of-five.json` | 4/5 |
| `04-five-of-five.json` | PACKET_COMPLETE |
| `05-prepared-awaiting-approval.json` | PREPARED_AWAITING_APPROVAL |
| `05b-prepared-disclosure.json` | frozen disclosure manifest |
| `06-approved-submit-unlocked.json` | APPROVED, submit unlocked |
| `06b-approval-response.json` | approval response (`submitted: false`) |
| `07-08-submitted-payer-approved-gap.json` | payer approved + coverage gap |
| `07b-authorization-status.json` | check_authorization_status |
| `09-10-remediation-prepared.json` | REMEDIATION_PREPARED |
| `11-remediation-approved-extension-unlocked.json` | REMEDIATION_APPROVED |
| `11b-remediation-approval-response.json` | 2nd approval response |
| `13-authorization-aligned.json` | AUTHORIZATION_ALIGNED (terminal) |
| `13b-final-authorization-status.json` | final status read |
| `14-missing-evidence-refusal.json` | 409 MISSING_REQUIRED_EVIDENCE |
| `evidence-find-req-001.json` | find_supporting_evidence (structured path) |
| `evidence-find-req-003-alternate-path.json` | fifth-beat alternate document path |
| `proof-submit-before-approval.json` | 409 APPROVAL_REQUIRED |
| `proof-approval-without-workforce-identity.json` | 401 APPROVER_IDENTITY_REQUIRED |
| `proof-extension-submit-before-approval.json` | REMEDIATION_APPROVAL_REQUIRED |

No `SUBMITTED_OR_PENDING` capture exists: the simulator answers synchronously,
so the demo path never rests there. See contract §7.7.
