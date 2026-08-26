# Gate 3 — Exactly-once submission across a simulated payer boundary

An exact, human-approved WellAuth submission is transactionally claimed,
compiled into a PAS-shaped FHIR R4 request, transmitted **exactly once** to a
distinct authenticated simulated payer service, and associated with a durable
receipt and synthetic payer response — without mutating clinical truth.

**All payer interaction is with a clearly labelled SIMULATED payer.** Northstar
Health Plan is fictional. No real payer, payer network, clearinghouse or X12
transaction is involved, and all clinical data is synthetic.

## What crosses the boundary

```
Cloud Healthcare API (FHIR R4)          clinical truth, provider reads only
        │
        ▼
wellauth-provider (Cloud Run)           wellauth-provider-sa
        ├── Firestore wellauth-workflow  workflow truth
        ├── PAS request compiler         provider/pas.js
        └── submission / idempotency     provider/submission.js
        │
        │  authenticated HTTPS, Cloud Run ID token, POST /Claim/$submit
        ▼
wellauth-payer-simulator (Cloud Run)    wellauth-payer-sa  ← NO Healthcare access
        └── Firestore wellauth-payer     payer truth, separate database
```

The boundary is real in four independent ways: separate service, separate
service account, separate origin, separate Firestore database. A provider-local
write would not be a submission — this is.

## State machine delta

Gate 2 ended at `APPROVED`. Gate 3 adds a **submission axis** carried on
`submission.state`. The workflow's own `state` stays `APPROVED` for the whole
lifecycle, because the approval is the thing being *consumed*; collapsing both
axes into one field would erase the difference between "approved, not yet sent"
and "approved, in flight".

| Submission state | Entered from | Invariant |
|---|---|---|
| `SUBMITTING` | `APPROVED`, transactionally | Exactly one caller wins the CAS. Current approval matches current packet hash; all source versions fresh; stable submission id + Claim business identifier established. While here, no second submission can transmit. |
| `SUBMITTED_OR_PENDING` | `SUBMITTING` | Payer accepted; durable receipt held; exact request hash retained; approval consumed. Payer has not reached a terminal decision. |
| `COMPLETE` | `SUBMITTING` | Payer returned a terminal decision. `payerStatus` is `approved` **or** `denied` — the transport succeeded either way. |
| `FAILED` | `SUBMITTING` | Non-acceptance is a **known fact**: the payer refused the request (4xx) or explicitly guaranteed it recorded nothing. A fresh submission is then safe. |
| `UNKNOWN_SUBMISSION_OUTCOME` | `SUBMITTING` | WellAuth cannot determine whether the payer accepted. **Never retried automatically.** Submission id and request hash retained; requires explicit reconciliation. |

Once a submission exists and is not `FAILED`, `attach_evidence`,
`remove_evidence`, `prepare` and `reconcile_sources` all refuse with
`ALREADY_SUBMITTED` — the workflow cannot be edited out from under a real
outbound transaction.

## Exactly-once

Four independent mechanisms, in the order they apply:

1. **Preconditions before anything.** `submit_prior_authorization` re-verifies
   workflow state, revision, approval presence, approval↔packet-hash binding,
   approval↔manifest binding, server-recomputed 5/5 completeness, manifest
   integrity, binding↔manifest agreement, destination, and live version-exact
   freshness of order, coverage and all five evidence resources. Any failure
   raises **before** the transition is claimed, so **zero outbound calls**.
2. **Transactional claim.** A Firestore transaction moves `APPROVED →
   SUBMITTING`, re-asserting every precondition inside the transaction. Exactly
   one caller wins; the loser gets `SUBMISSION_IN_PROGRESS` and never reaches
   the network.
3. **Deterministic business identifier.** The Claim identifier is
   `WA-{workflowId}-{packetHash[0:24]}` — a pure function of the approved
   packet, never random. A replay produces the *same* identifier, so even a
   duplicate delivery is recognised by the payer as the same logical
   authorization rather than a second one.
4. **Payer-side collapse.** The simulator keys its record on that identifier
   inside its own transaction. A second delivery increments `replayCount` and
   returns the original decision; it never re-decides and never mints a second
   authorization number.

There is **no retry loop anywhere.** "Retry until 200" is exactly the bug that
duplicates authorizations.

The suite does not take the provider's word for this: it counts transmissions
from the **payer's own durable records**.

## Ambiguous outcome

The simulator's `accept-then-disconnect` mode persists the request and then
destroys the socket without responding. The provider observes a transport
error, cannot distinguish "never arrived" from "arrived and the reply was
lost", and therefore records `UNKNOWN_SUBMISSION_OUTCOME` — not failed, not
complete, not reverted to approved, and **not resent**.

Reconciliation (`POST /workflows/{id}/submission/reconcile`) resolves it by
asking the payer about the stable identifier the provider already holds —
`GET /Claim/$status/{identifier}`. It is a keyed lookup, not a search; the
caller supplies nothing. Verified in P0.14/P0.15: the payer had recorded the
request, reconciliation found the existing receipt, resolved the state, and
still exactly one delivery existed afterwards.

If the payer definitively holds no record, the submission becomes `FAILED`
with `CONFIRMED_NOT_RECEIVED` — the only safe recovery, and safe precisely
because it is confirmed rather than assumed.

## HTTP success ≠ authorization

`interpretClaimResponse` derives the decision **only** from
`ClaimResponse.outcome`. A denial arrives as HTTP 201 with
`outcome: "error"` and is persisted as `payerStatus: "denied"` (P0.12). An
unrecognised outcome is never optimistically treated as approval, and no
decision is ever inferred from elapsed time (P0.16).

## Minimum necessary

The outgoing bundle contains exactly 10 resources: the `Claim`, the patient,
the requesting practitioner + role + clinic, the payer organization, the
coverage, and the three additional evidence resources. Every one is referenced
by the Claim.

Stripped before disclosure: FHIR `text` narrative (repeats whole clinical
notes), `contained`, `implicitRules`, `language`. `DocumentReference.content`
keeps contentType/title/creation and drops `data` and `url` — the requirement is
satisfied by the document's existence and metadata, not its bytes.

P0.18 asserts all nine decoy resources and the second synthetic patient are
absent, that no `data`/`url`/narrative is present, and that every reference
resolves inside the bundle.

## Exact submission (canonical happy path)

| Field | Value |
|---|---|
| Packet hash | `sha256:78f9d2aeea567e0b195d28ee26495de998a592cc4404abdd76782cb3c0057d74` |
| Claim business identifier | `WA-wf-wellauth-001-78f9d2aeea567e0b195d28ee` |
| Request hash | `sha256:869454256848fdc49ea94cf860827623583be48c2c9158a472dd67cf2658cc83` |
| Evidence count | 5 of 5 |
| Destination | Northstar Health Plan (**simulated**) |
| Transport | `POST /Claim/$submit`, Cloud Run ID token |
| Attempts | 1 |
| PAS validation | see `GATE-3-PAS-VALIDATION.md` |

### Payer response

| Field | Value |
|---|---|
| Receipt id | `NS-RCPT-d76ac637-b832-4573-81b5-76b1a69047f7` |
| Response resource | `ClaimResponse` (FHIR R4) |
| Outcome / status | `complete` → `approved` (**simulator decision**) |
| Payer reference | `NS-AUTH-FEE74F7DDB78` |
| Disposition | "Prior authorization approved by simulated payer" |
| Authorization period | 2026-08-26 → 2026-11-24 (persisted for Act II, unused in Gate 3) |
| Association | payer `requestHash` == provider `requestHash`, verified in P0.1 |

## Bounded status

`GET /workflows/{id}/authorization-status` takes **only** a workflow id. There
is no parameter for a Claim id, payer reference or patient, so a browser agent
cannot ask about a submission that is not its own; query strings are discarded
before routing. It reads provider-persisted state, never the payer live, and
always carries `simulated: true` with an explicit simulation notice.

## Cloud state

| Resource | Value |
|---|---|
| Provider | `wellauth-provider`, revision `wellauth-provider-00006-bjg`, `--no-allow-unauthenticated` |
| Payer simulator | `wellauth-payer-simulator`, revision `wellauth-payer-simulator-00003-chk`, `--no-allow-unauthenticated` |
| Provider SA | `wellauth-provider-sa` — `healthcare.fhirResourceReader` (read-only), `datastore.user` conditioned to `wellauth-workflow` |
| Payer SA | `wellauth-payer-sa` — `datastore.user` conditioned to `wellauth-payer`. **No Healthcare API access of any kind.** |
| Provider → payer | `roles/run.invoker` on the simulator only |
| Persistence added | Firestore database `wellauth-payer` (nam5), collection `northstar_submissions` |
| Fixture SA | `wellauth-fixture-sa` — unchanged; still the only identity that may write FHIR |

New provider subcollection: `wellauth_workflows/{id}/submissions/{attemptId}` —
append-only attempt ledger.

## FHIR read-only proof

P0.23 impersonates the **provider runtime service account** and attempts
`PUT /Condition/wellauth-condition-001` against the live store:

```
provider runtime FHIR write attempt -> 403
```

Reads with the same identity succeed. The provider was not granted write access
to make anything easier. P0.24 re-hashes all six clinical resources and confirms
submission changed none of them; the three touched during stale-state tests were
advanced by the **fixture** identity and their content hashes are unchanged.

## Logging review

P0.22 scans captured provider logs for eight canaries: both synthetic MRNs
(`WELLAUTH-CANARY-MRN-8842`, `-9001`), the subscriber id (`NS-SYNTH-4417`), the
patient id, clinical narrative phrases, raw FHIR bodies, bearer credentials, and
the outbound bundle. None present. Both services log only correlation id,
route, outcome, receipt id and mode. The payer never logs the claim or bundle.

## Tests

```sh
npm test                                                      # Gate 0   46/46
npm run test:fhir-smoke                                       # Gate 1   93/93
npm run test:gate2                                            # Gate 2  147/147
PAYER_BASE_URL=<payer> npm run test:gate3                     # Gate 3  173/173
GATE3_BASE_URL=<provider> PAYER_BASE_URL=<payer> \
  npm run test:gate3                                          # Gate 3  174/174
```

The deployed run adds one check (query-string injection against the bounded
status route) that only exists over HTTP.

## Not claimed

Gate 3 does **not** claim: real payer connectivity, a payer network, production
prior authorization, X12 278, clearinghouse integration, trading-partner
conformance, HIPAA compliance, or production readiness. The payer is a
simulator and every artifact it produces is tagged `simulated`.

PAS conformance is claimed only to the extent the validator output supports —
see `GATE-3-PAS-VALIDATION.md`.

## Cleanup

```sh
gcloud run services delete wellauth-payer-simulator --region us-central1
gcloud firestore databases delete --database=wellauth-payer
gcloud iam service-accounts delete wellauth-payer-sa@preflight-hackathon.iam.gserviceaccount.com
# Gate 1 dataset/FHIR store and Gate 2 workflow database are deliberately NOT deleted.
```
