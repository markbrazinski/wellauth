# WellAuth — Final UI Integration Contract

**Audience:** Claude Design (product design), validating the final WellAuth UI
against real backend truth.

**Status:** `CONTRACT HAS GAPS` — the demo spine is fully supported by real
implementation; four Category C projections and one Category D item are flagged
in §8. Nothing in §8 was silently solved.

**Authoritative sources:** `provider/capabilities.js`, `provider/workflow.js`,
`provider/remediation.js`, `provider/submission.js`, `provider/index.js`,
`provider/policy.js`. The existing smoke-test UI (`src/*.tsx`) is **disposable
presentation** and is NOT the source of this contract.

**All JSON in §7 was captured live** from the deployed provider
(`https://wellauth-provider-qxqdngmwjq-uc.a.run.app`) by driving the complete
canonical demo end-to-end on 2026-08-27. Nothing is invented.

> All clinical data is synthetic. Northstar Health Plan is fictional. Every
> payer interaction is with a clearly labelled simulator. This demonstration's
> authorization, disclosure, and audit boundaries are designed around a credible
> HIPAA-regulated deployment model, but no claim of HIPAA compliance is made.

---

## 0. The one thing to understand first

There is **one read** the UI performs:

```
GET /workflows/wf-wellauth-001/snapshot
```

It returns workflow state, clinical order context, requirements, evidence
bindings, prepared-packet identity, submission, payer result, Act II posture,
remediation, **and the authoritative list of agent capabilities**. The page and
the browser's WebMCP tool inventory are both reconstructed from this single
document.

The UI never computes state. It renders `snapshot`.

Two axes move independently and **both matter**:

| Axis | Field | Meaning |
|---|---|---|
| Workflow | `state` | Act I progress. Stops at `APPROVED`. |
| Submission | `submission.state` | Payer transmission lifecycle. |
| Act II | `act2.phase` | External-payer-driven remediation posture. |

`state` stays `APPROVED` for the entire submission and Act II lifecycle. This
is deliberate: the approval is the thing being *consumed*. **Design must key
the lower region off `act2.phase` first, then `submission`, then `state`** —
that is the real precedence.

---

## 1. Canonical workflow states

### 1.1 Act I — `state`

| State | Meaning | Entry condition | Exit condition |
|---|---|---|---|
| `CONTEXT_READY` | Order + coverage bound from exact FHIR reads. Requirements **not yet discovered**. | `POST /workflows/{id}` (auto on page load) | `discover_coverage_requirements` |
| `REQUIREMENTS_RESOLVED` | Five requirements resolved and versioned. Evidence may be attached/removed. Includes 0/5 through 4/5. | requirements resolved, or a binding change leaves <5/5 | reaching 5/5 |
| `PACKET_COMPLETE` | Server recomputed 5/5 from its own bindings. | 5th binding attached | `prepare_prior_authorization`, or any binding removal |
| `PREPARED_AWAITING_APPROVAL` | Exact disclosure frozen + hashed. **Agent has no submission capability.** | `prepare_prior_authorization` | human approval, or invalidation |
| `APPROVED` | A named workforce user approved that exact packet hash. | `POST /approval` with workforce headers | terminal for `state` |

**Invalidation:** attaching, removing, reconciling, or a stale source drops
`manifestRevision`, `preparedRevision`, `packetHash`, and `approval` to `null`
and returns `state` to `REQUIREMENTS_RESOLVED`/`PACKET_COMPLETE`. An approval is
**never** rebased onto newer content.

### 1.2 Submission — `submission.state`

| State | Meaning | Entry | Exit |
|---|---|---|---|
| `SUBMITTING` | Transaction claimed; exactly one caller reached the network. | `submit_prior_authorization` | payer answers |
| `SUBMITTED_OR_PENDING` | Payer holds it; no decision (`queued`/`partial`). | payer pending outcome | payer decision |
| `COMPLETE` | Payer decision recorded. `payerStatus` is `approved` or `denied`. | `outcome: complete`/`error` | terminal |
| `FAILED` | Payer refused **before recording**. Evidence editing re-opens. | 4xx validation refusal | re-submit |
| `UNKNOWN_SUBMISSION_OUTCOME` | Timeout/unreadable. **Never auto-retried.** | ambiguous transport | explicit reconcile |

`payerStatus` ∈ `approved` · `denied` · `pending` · `unrecognized-outcome` ·
`not-accepted` · `unknown` · `not-submitted`.

### 1.3 Act II — `act2.phase`

Act II **cannot begin** until `submission.state === 'COMPLETE'` **and**
`payerStatus === 'approved'`. It is then driven by a date comparison against
FHIR clinical truth.

| Phase | Meaning | Entry condition | Exit condition |
|---|---|---|---|
| `null` | No payer approval yet, or alignment not evaluable. | default | payer approves |
| `PAYER_APPROVED_COVERAGE_GAP` | **Hero beat.** Payer approved, but validity ends before the scheduled MRI. | `scheduledServiceDate > validThrough` | `resolve_authorization_window` |
| `REMEDIATION_PREPARED` | Bounded extension request frozen + hashed. **No submission capability.** | `resolve_authorization_window` | human approval |
| `REMEDIATION_APPROVED` | Workforce approved that exact remediation hash. | `POST /remediation/approval` | extension submit |
| `REMEDIATION_SUBMITTING` | Claimed; exactly one outbound extension possible. | `submit_authorization_extension` | payer answers |
| `REMEDIATION_SUBMITTED` | Payer responded but validity **still** doesn't cover the date. | settle, `aligned !== true` | — |
| `AUTHORIZATION_ALIGNED` | Persisted validity now covers the scheduled date. Terminal. | settle, `aligned === true` | terminal |
| `REMEDIATION_UNKNOWN_OUTCOME` | Ambiguous extension transport. Never auto-retried. | timeout/unreadable | reconciliation |

**Critical:** `AUTHORIZATION_ALIGNED` is reached **only** when persisted payer
validity actually covers the authoritative scheduled date. It is never asserted
from an HTTP 200. Design must not treat "extension submitted" as "aligned".

---

## 2. Workspace snapshot

`GET /workflows/{workflowId}/snapshot` → `200`.

### 2.1 Top level

| Field | Type | Meaning | Null/optional | Source |
|---|---|---|---|---|
| `workflowId` | string | Canonical `wf-wellauth-001`. | never | policy |
| `state` | enum | Act I state (§1.1). | never | Firestore |
| `revision` | number | Monotonic counter. **Every mutation must echo it** as `expected_revision`. | never | Firestore |
| `payer` | string | `"Northstar Health Plan"`. | never | server policy |
| `requirementSetVersion` | string\|null | `"northstar-cardiac-mri-v1"`. | `null` at `CONTEXT_READY` | Firestore |
| `completeness` | object | `{satisfied, required, complete}` (+`missing[]` post-change). | never | recomputed server-side |
| `order` | object\|null | Clinical order (§2.2). `null` if FHIR unreachable. | nullable | **FHIR R4** |
| `coverage` | object | `{resourceType, id, versionId}`. | never | FHIR |
| `manifestRevision` | number\|null | Frozen disclosure revision. | `null` until prepared | Firestore |
| `preparedRevision` | number\|null | Workflow revision at prepare. | `null` until prepared | Firestore |
| `packetHash` | string\|null | `sha256:…`. **The object a human approves.** | `null` until prepared | canonical hash |
| `approval` | object\|null | §4.1. | `null` until approved | Firestore |
| `submission` | object\|null | §2.4. | `null` until submitted | Firestore |
| `remediation` | object\|null | §2.6. | `null` until resolved | Firestore |
| `bindings` | array | Attached evidence (§2.3). Sorted by `requirementId`. | `[]` | Firestore |
| `requirements` | array | Five requirements (§2.3). **`[]` at `CONTEXT_READY`** — deliberate. | `[]` before discovery | policy |
| `scheduledServiceDate` | string\|null | `"2026-09-18"`. Date-only, for alignment. | nullable | **FHIR** |
| `scheduledServiceDisplay` | string | `"September 18 · 9:30 AM"`. Pre-formatted. | never | fixture |
| `act2` | object | `{phase, alignment}` (§2.5). | `phase` nullable | derived |
| `availableTools` | string[] | **Authoritative capability list** (§3). | never | `capabilitiesFor()` |
| `simulated` | boolean | Always `true`. | never | server |
| `updatedAt` | ISO string | Last mutation. | never | Firestore |
| `correlationId` | uuid | Per-request trace id. | never | HTTP layer |

> **`requirements: []` at `CONTEXT_READY` is intentional.** Returning the static
> policy list before discovery would make the page claim a discovery that never
> happened. Design an honest empty state.

### 2.2 `order` — clinical truth, read-only from FHIR

```json
{
  "workflowId": "wf-wellauth-001",
  "orderHandle": "ev_ae916c6f1cde9e9901ac",
  "service": { "display": "Cardiac MRI with contrast", "code": "75561",
               "system": "http://www.ama-assn.org/go/cpt" },
  "status": "active", "intent": "order",
  "authoredOn": "2026-08-10T14:05:00Z",
  "scheduled": "2026-09-18T09:30:00Z",
  "coverage": { "payer": "Northstar Health Plan", "status": "active",
                "periodStart": "2026-01-01", "periodEnd": "2026-12-31",
                "sourceVersionId": "MTc4Nzc4MzU3MDgxNzcxMDAwMA" },
  "sourceVersionId": "MTc4Nzc4MzU1MDI0NTg5MDAwMA",
  "sourceLastUpdated": "2026-08-26T22:32:35.024589+00:00",
  "etag": "W/\"MTc4Nzc4MzU1MDI0NTg5MDAwMA\""
}
```

**There is no patient name, DOB, MRN, or sex anywhere in the snapshot.** See
Gap C-1.

### 2.3 `requirements[]` and `bindings[]`

The UI joins these **on `requirementId`** to render evidence beneath its exact
requirement.

```json
"requirements": [
  { "id": "req-001", "label": "Documented cardiac symptoms within the relevant window",
    "expectedResourceType": "Condition", "alternatePath": false },
  { "id": "req-002", "label": "Prior echocardiogram result",
    "expectedResourceType": "DiagnosticReport", "alternatePath": false },
  { "id": "req-003", "label": "Failed or contraindicated conservative therapy",
    "expectedResourceType": "DocumentReference", "alternatePath": true },
  { "id": "req-004", "label": "Ordering physician identity / attestation requirement",
    "expectedResourceType": "PractitionerRole", "alternatePath": false },
  { "id": "req-005", "label": "Active payer-member eligibility / coverage requirement",
    "expectedResourceType": "Coverage", "alternatePath": false }
]
```

`alternatePath: true` on **req-003 marks the fifth-evidence hero beat** — the
fact exists only as a narrative `DocumentReference`, not a discrete resource.
Design may legitimately treat this flag as "found elsewhere in the record".

```json
"bindings": [{
  "requirementId": "req-001",
  "evidenceHandle": "ev_0b5a99faaba89bbcfefa",
  "resourceType": "Condition",
  "sourceVersionId": "MTc4Nzc4MDA2ODU3ODk3MDAwMA",
  "bindingRule": "structured-resource-path",
  "boundAt": "2026-08-27T01:31:02.436Z",
  "boundAtRevision": 3
}]
```

A requirement is **MET** iff a binding exists for its id. `bindingRule` ∈
`structured-resource-path` · `alternate-document-path`.

> **Bindings carry no human-readable title and no clinical date.** The locked IA
> asks for `↳ evidence title · date · source · attached by assistant`. Only
> `source` (`resourceType`), version, and `boundAt` are present. See Gap C-2.

### 2.4 `submission`

```json
{
  "submissionId": "sub-c4ffb975-…", "state": "COMPLETE",
  "claimIdentifier": "WA-wf-wellauth-001-e80e62bf8aad42a415321a31",
  "requestHash": "sha256:2859…", "packetHash": "sha256:e80e…",
  "destination": "Northstar Health Plan", "attempts": 1,
  "payerStatus": "approved",
  "startedAt": "2026-08-27T01:31:30.686Z",
  "completedAt": "2026-08-27T01:31:32.883Z",
  "authorizationPeriod": { "start": "2026-08-26", "end": "2026-09-12" },
  "payerReference": "NS-40192", "simulated": true
}
```

`authorizationPeriod.end` **is** the validity that creates the Act II gap.
`attempts` is a truthful transmission count — design may show it as proof that
one approval produced exactly one request.

### 2.5 `act2`

```json
{ "phase": "PAYER_APPROVED_COVERAGE_GAP",
  "alignment": { "evaluated": true, "aligned": false,
                 "scheduledServiceDate": "2026-09-18",
                 "validThrough": "2026-09-12" } }
```

`aligned`: `false` = gap (remediation valid) · `true` = covered · `null` = not
evaluable. **This object contains both dates the hero screen needs.**

### 2.6 `remediation`

```json
{
  "type": "WellAuthAuthorizationWindowRemediation/1",
  "state": "AUTHORIZATION_ALIGNED", "payer": "Northstar Health Plan",
  "payerAuthorizationReference": "NS-40192",
  "currentValidThrough": "2026-10-03", "scheduledServiceDate": "2026-09-18",
  "requestedValidThrough": "2026-10-03",
  "reasonCode": "scheduled-service-outside-authorization-window",
  "reasonDisplay": "Scheduled service falls outside the current authorization validity window.",
  "clinicalIntentChanged": false, "evidenceChanged": false, "orderChanged": false,
  "revision": 11, "hash": "sha256:0c2899fe…",
  "preparedAt": "2026-08-27T01:31:51.383Z",
  "approval": { "approvedBy": "A. Reyes", "role": "prior-auth-coordinator",
                "at": "2026-08-27T01:31:52.714Z",
                "remediationHash": "sha256:0c2899fe…", "outcome": "APPROVED" },
  "submission": { "remediationSubmissionId": "rem-2c1d2274-…", "attempts": 1,
                  "startedAt": "…", "completedAt": "…", "outcome": "updated",
                  "extensionReceiptId": "NS-EXT-f7e6eda6-…",
                  "ambiguityReason": null, "failureCode": null, "simulated": true },
  "simulated": true
}
```

`clinicalIntentChanged` / `evidenceChanged` / `orderChanged` are **explicit
`false` fields designed to be rendered.** They are the honest answer to "what is
the human actually authorizing?" — design should show them, not paraphrase them.

### 2.7 Prepared disclosure — a **separate** read

`GET /workflows/{id}/disclosure`. Only valid at `PREPARED_AWAITING_APPROVAL` or
`APPROVED`; otherwise `NOT_PREPARED`.

```json
{
  "artifact": "WellAuthPreparedSubmission/1",
  "requirementSetVersion": "northstar-cardiac-mri-v1",
  "destination": "Northstar Health Plan", "purpose": "prior-authorization-review",
  "order": { "resourceType": "ServiceRequest", "id": "wellauth-order-001",
             "versionId": "MTc4Nzc4MzU1MDI0NTg5MDAwMA" },
  "coverage": { "resourceType": "Coverage", "id": "wellauth-coverage-001",
                "versionId": "MTc4Nzc4MzU3MDgxNzcxMDAwMA" },
  "patientContextRef": "Patient/wellauth-patient-001",
  "items": [
    { "requirementId": "req-001", "resourceType": "Condition",
      "resourceId": "wellauth-condition-002",
      "sourceVersionId": "MTc4Nzc4MDA2ODU3ODk3MDAwMA",
      "inclusionReason": "satisfies:req-001:structured-resource-path" },
    { "requirementId": "req-003", "resourceType": "DocumentReference",
      "resourceId": "wellauth-doc-conservative-therapy",
      "sourceVersionId": "MTc4Nzc4MDA3MDMzNTg2NjAwMA",
      "inclusionReason": "satisfies:req-003:alternate-document-path" }
  ],
  "exclusionPolicy": { "version": "wellauth-minimum-necessary-v1",
    "excludes": ["unrelated-conditions","unrelated-encounters","unrelated-documents",
                 "other-patients","raw-clinical-narrative"] },
  "manifestRevision": 1, "packetHash": "sha256:e80e62bf…",
  "preparedAt": "…", "state": "PREPARED_AWAITING_APPROVAL",
  "currentPacketHash": "sha256:e80e62bf…"
}
```

This is **exactly what the payer would receive** — it names resource type, id,
and exact version, deliberately. `exclusionPolicy.excludes` is the
minimum-necessary story and is designed to be shown.

---

## 3. Capability lifecycle

`availableTools` is authoritative and **exhaustively enumerated below** (verified
by executing `capabilitiesFor()` over every reachable state).

| State / phase | `availableTools` | Δ |
|---|---|---|
| `CONTEXT_READY` | `get_order_context`, `discover_coverage_requirements` | baseline |
| `REQUIREMENTS_RESOLVED` 0/5 | + `find_supporting_evidence`, `inspect_evidence`, `attach_evidence` | **+3** |
| `REQUIREMENTS_RESOLVED` 1–4/5 | + `remove_evidence` | **+1** |
| `PACKET_COMPLETE` 5/5 | + `prepare_prior_authorization`, − `discover_coverage_requirements` | **+prepare** |
| `PREPARED_AWAITING_APPROVAL` | − `prepare_prior_authorization`. **No submit of any kind.** | **−prepare** |
| `APPROVED` (pre-submit) | + `submit_prior_authorization` | **+submit** |
| `submission` exists (any state ≠ `FAILED`) | `get_order_context`, `check_authorization_status` **only** | **−submit, −all evidence tools** |
| `act2: PAYER_APPROVED_COVERAGE_GAP` | + `resolve_authorization_window` | **+resolve** |
| `act2: REMEDIATION_PREPARED` | − `resolve_authorization_window`. **No extension submit.** | **−resolve** |
| `act2: REMEDIATION_APPROVED` | + `submit_authorization_extension` | **+ext submit** |
| `act2: REMEDIATION_SUBMITTING` / `SUBMITTED` | `get_order_context`, `check_authorization_status` | **−ext submit** |
| `act2: AUTHORIZATION_ALIGNED` | `get_order_context`, `check_authorization_status` | terminal |
| `submission.state: FAILED` | evidence tools + `submit_prior_authorization` return | re-openable |

### 3.1 The three rules design must honor

1. **Absence means genuinely unavailable.** At `PREPARED_AWAITING_APPROVAL` the
   tool is *not registered in the browser* — `getTools()` does not contain it.
   Never render a disabled submit button; there is no capability to disable.
2. **`submit_prior_authorization` does not exist before human approval.**
   Verified live: `POST /submit` at `PREPARED_AWAITING_APPROVAL` →
   `409 APPROVAL_REQUIRED`, zero payer calls.
3. **`submit_authorization_extension` does not exist before the second
   approval.** Verified live → `REMEDIATION_APPROVAL_REQUIRED`.
   `resolve_authorization_window` appears **only** after the payer-result
   mismatch is authoritative in persisted state.

### 3.2 Implementation names → recommended user-facing labels

Use **"Assistant"** in the healthcare UI, **"agent"** only in technical docs.
Raw tool names are acceptable **only** in the transient unlock cue.

| Implementation name | Recommended label | Mutating? |
|---|---|---|
| `get_order_context` | Review order context | no |
| `discover_coverage_requirements` | Discover payer requirements | **yes** |
| `find_supporting_evidence` | Find supporting evidence | no |
| `inspect_evidence` | Inspect evidence | no |
| `attach_evidence` | Attach existing evidence | **yes** |
| `remove_evidence` | Remove attached evidence | **yes** |
| `prepare_prior_authorization` | Prepare submission | **yes** |
| `submit_prior_authorization` | Submit to payer | **yes, transmits** |
| `check_authorization_status` | Check authorization status | no |
| `resolve_authorization_window` | Resolve authorization window | **yes, no transmit** |
| `submit_authorization_extension` | Submit extension | **yes, transmits** |

---

## 4. Human-only actions

Neither is a WebMCP tool in any state. Both require workforce headers
(`X-WellAuth-User`, `X-WellAuth-Role`) that a browser agent does not hold —
verified live: without them → `401 APPROVER_IDENTITY_REQUIRED`. Permitted roles:
`prior-auth-coordinator`, `clinician`, `supervisor`.

### 4.1 Approve submission

| | |
|---|---|
| **Route** | `POST /workflows/{id}/approval` |
| **Visible at** | `state === 'PREPARED_AWAITING_APPROVAL'` |
| **Human sees** | The full prepared disclosure (§2.7): every resource type, id, exact version, inclusion reason, and the exclusion policy. Plus the `packetHash`. |
| **What is approved** | The exact `packetHash` at the exact `revision`. Body sends `expected_revision`, a one-time `nonce`, and `acknowledged_packet_hash`. |
| **Server binds** | approver identity + role + `manifestRevision` + `packetHash` + `workflowRevision` + nonce. Source freshness is **re-verified** at this boundary; stale source → approval refused **and** the preparation torn down. |
| **Result** | `state: APPROVED`; `approval` populated. |
| **Capability gained** | `submit_prior_authorization` |
| **Does it transmit?** | **No.** Verified live: response returns `submitted: false` and `submission` is still `null` afterwards. |

### 4.2 Approve extension request

| | |
|---|---|
| **Route** | `POST /workflows/{id}/remediation/approval` |
| **Visible at** | `act2.phase === 'REMEDIATION_PREPARED'` |
| **Human sees** | Current validity, scheduled MRI date, requested validity, `reasonDisplay`, and the explicit `clinicalIntentChanged/evidenceChanged/orderChanged: false` triple. |
| **What is approved** | The exact `remediation.hash` at the exact `revision` (`acknowledged_hash` + `nonce`). |
| **Server binds** | identity + role + `remediationHash` + `workflowRevision` + nonce. Re-verifies the **gap still holds**; if the payer window already moved → `REMEDIATION_STALE`. |
| **Result** | `act2.phase: REMEDIATION_APPROVED` |
| **Capability gained** | `submit_authorization_extension` |
| **Does it transmit?** | **No.** Approving records authority only. |

**Neither approval is:** a WebMCP tool · FHIR Consent · a patient HIPAA
Authorization · the payer's decision · a checkbox the browser can forge.

---

## 5. Activity contract

Every event is **derived from durable backend state**, so a reload reproduces
the identical timeline. Nothing is appended optimistically. This is **not chat**
and not a raw tool log.

| Event | Actor | Displayable | Source field | Occurs when |
|---|---|---|---|---|
| Discovered payer requirements | Assistant | — | `state !== 'CONTEXT_READY'` | after discovery |
| Attached evidence for `{req-id}` | Assistant | requirement id, timestamp | `bindings[].boundAt` | per attachment |
| All 5 requirements satisfied | WellAuth | count | `completeness.complete` | at 5/5 |
| Prepared submission for review | Assistant | — | `packetHash !== null` | after prepare |
| Approved submission | **named human** | `approvedBy`, timestamp | `approval.approvedBy`, `.at` | after approval |
| Submitted to Northstar (simulated) | Assistant | — | `submission !== null` | after submit |
| Returned Approved / Denied | Simulated payer | decision | `submission.payerStatus` | on decision |
| Detected authorization-window mismatch | WellAuth | both dates | `act2.alignment` | on gap |
| Enabled authorization-window remediation | WellAuth | — | `act2.phase` | on gap |
| Prepared authorization-window remediation | Assistant | — | `remediation !== null` | after resolve |
| Approved extension request | **named human** | `approvedBy`, timestamp | `remediation.approval` | after 2nd approval |
| Submitted extension to Northstar (simulated) | Assistant | — | `remediation.submission.extensionReceiptId` | after ext submit |
| Updated authorization validity | Simulated payer | new validity | `phase === 'AUTHORIZATION_ALIGNED'` | on alignment |

**Timestamps:** only `bindings[].boundAt`, `approval.at`, and
`remediation.approval.at` carry durable per-event times. Other events derive
from state presence and have **no individual timestamp**. See Gap C-3.

---

## 6. Script-beat contract

Fourteen beats. Each maps to real backend truth.

---

### Beat 1 — Prior authorization required

**Backend state** `CONTEXT_READY` · rev 1 · `act2.phase: null`
**What changed** Workflow established from exact FHIR reads of order + coverage.
**Data available** `order` (service, scheduled, coverage), `payer`,
`scheduledServiceDisplay`. `completeness: 0/5`.
**Requirements/evidence** `requirements: []` — **deliberately empty.**
**Assistant capabilities** `get_order_context`, `discover_coverage_requirements`
**Human action** none
**Activity** empty
**Lower region** BLOCKED — "Payer requirements have not been discovered yet."
**Must NOT show** Any requirement rows. Any count like "0 of 5" that implies the
five are known. Any prepare/submit affordance.

---

### Beat 2 — Requirements discovered

**Backend state** `REQUIREMENTS_RESOLVED` · rev 2
**What changed** Five requirements resolved; `requirementSetVersion` set;
evidence handles registered server-side.
**Data available** `requirements[5]` with `label`, `expectedResourceType`,
`alternatePath`.
**Requirements/evidence** 5 rows, all **OPEN**. 0/5.
**Assistant capabilities** +`find_supporting_evidence`, `inspect_evidence`,
`attach_evidence` (5 total)
**Human action** none
**Activity** "Assistant · Discovered payer requirements"
**Lower region** BLOCKED — "5 of 5 requirements still need evidence."
**Must NOT show** `remove_evidence` (nothing bound). Prepare. Any evidence line.

---

### Beat 3 — Four of five satisfied

**Backend state** `REQUIREMENTS_RESOLVED` · rev 6 · 4/5
**What changed** Four bindings attached, each with exact `sourceVersionId`.
**Data available** `bindings[4]`, `completeness: {satisfied:4, required:5}`.
**Requirements/evidence** req-001/002/004/005 **MET** with provenance lines;
**req-003 OPEN**.
**Assistant capabilities** + `remove_evidence` (6 total)
**Human action** none
**Activity** 4 × "Attached evidence for {req-id}" with real `boundAt` times.
**Lower region** BLOCKED — "1 of 5 requirements still needs evidence."
**Must NOT show** `prepare_prior_authorization`. Any "ready" affordance.

> **The refusal is real and available here.** `POST /prepare` at 4/5 returns
> `409 MISSING_REQUIRED_EVIDENCE` — "Requirements without current evidence:
> req-003". Design may show this as the honest refusal beat.

---

### Beat 4 — Fifth evidence located elsewhere (4/5 → 5/5)

**Backend state** `PACKET_COMPLETE` · rev 7 · 5/5
**What changed** req-003 satisfied via `alternate-document-path` — a narrative
`DocumentReference`, structurally different from the other four.
**Data available** `bindings[5]`; the req-003 binding carries
`bindingRule: "alternate-document-path"`.
**Requirements/evidence** All five **MET**. Counter 5 of 5.
**Assistant capabilities** + `prepare_prior_authorization`; −
`discover_coverage_requirements`
**Human action** none
**Activity** + "Attached evidence for req-003", + "All 5 requirements satisfied"
**Lower region** READY — "All requirements are satisfied. The assistant can now
prepare the submission for your review."
**Must NOT show** Any submit capability. Any disclosure content (not yet frozen).

---

### Beat 5 — Prepared, awaiting approval

**Backend state** `PREPARED_AWAITING_APPROVAL` · rev 8 · `packetHash` set
**What changed** Exact disclosure frozen + hashed; `manifestRevision: 1`.
**Data available** Full disclosure via `GET /disclosure` (§2.7) + `packetHash`.
**Requirements/evidence** Unchanged, 5/5 MET.
**Assistant capabilities** −`prepare_prior_authorization`. **5 tools, none of
which can submit.**
**Human action** **Approve submission** (dominant filled control)
**Activity** + "Assistant · Prepared submission for review"
**Lower region** Proposed disclosure: every item's resourceType + requirementId
+ exact version, the exclusion policy, the packet hash, and the approve control
with "Approving does not transmit."
**Must NOT show** A disabled submit button. Any payer result. Any Act II
content. **This is a hero beat — do not compress it.**

---

### Beat 6 — Approved, submit unlocked

**Backend state** `APPROVED` · rev 9 · `approval` populated
**What changed** Named workforce user bound to that exact packet hash.
**Data available** `approval: {approvedBy:"A. Reyes", role:"prior-auth-coordinator", at, packetHash, manifestRevision, workflowRevision, outcome:"APPROVED"}`
**Requirements/evidence** Unchanged.
**Assistant capabilities** **+`submit_prior_authorization`** ← hero moment
**Human action** complete
**Activity** + "A. Reyes · Approved submission" (real timestamp)
**Lower region** APPROVED — "Approved by A. Reyes (prior-auth-coordinator). The
assistant now has the capability to submit this exact request."
**Must NOT show** Any payer result. Any claim that approval transmitted —
verified `submitted: false`, `submission` still `null`.

---

### Beat 7 — Submitted / pending

**Backend state** `state: APPROVED`, `submission.state: SUBMITTING` →
`SUBMITTED_OR_PENDING`
**What changed** Exactly one outbound request crossed the payer boundary.
**Data available** `submission.claimIdentifier`, `attempts: 1`, `destination`.
**Assistant capabilities** −submit, −**all** evidence tools;
`get_order_context` + `check_authorization_status` only
**Human action** none
**Lower region** PENDING — claim identifier, transmission count.
**Must NOT show** Any decision. Any Act II content.

> The canonical simulator answers synchronously, so this beat may be brief.
> `SUBMITTED_OR_PENDING` is genuinely reachable and the UI polls every 5s while
> it holds.

---

### Beat 8 — Payer approved, but date mismatch ★

**Backend state** `submission.state: COMPLETE`, `payerStatus: "approved"`,
`act2.phase: PAYER_APPROVED_COVERAGE_GAP` · rev 11
**What changed** **Nothing the browser did.** The payer's persisted validity
(`end: 2026-09-12`) does not reach the scheduled MRI (`2026-09-18`).
**Data available** `submission.authorizationPeriod`, `payerReference: "NS-40192"`,
`act2.alignment: {evaluated:true, aligned:false, scheduledServiceDate:"2026-09-18", validThrough:"2026-09-12"}`
**Assistant capabilities** **+`resolve_authorization_window`** ← unlocked by
external state
**Human action** none
**Activity** + "Simulated payer · Returned Approved", + "WellAuth · Detected
authorization-window mismatch", + "WellAuth · Enabled authorization-window
remediation"
**Lower region** SIMULATED PAYER · Approved — with "Does not cover scheduled
date", both dates side by side, and "The payer approved, but the ordered care
remains administratively blocked."
**Must NOT show** Success/complete framing. Any remediation artifact (not
prepared yet). Any suggestion WellAuth changed the schedule.

---

### Beat 9 — Remediation prepared

**Backend state** `act2.phase: REMEDIATION_PREPARED`
**What changed** Bounded extension request frozen + hashed.
**Data available** Full `remediation` object incl. `currentValidThrough`,
`requestedValidThrough: "2026-10-03"`, `reasonDisplay`, `hash`, and the
`clinicalIntentChanged/evidenceChanged/orderChanged: false` triple.
**Assistant capabilities** −`resolve_authorization_window`. **No extension
submit.** (`get_order_context`, `check_authorization_status`)
**Human action** **Approve extension request**
**Activity** + "Assistant · Prepared authorization-window remediation"
**Lower region** Proposed remediation: current validity, scheduled MRI,
requested change, reason, an explicit "Unchanged: ordered service, clinical
evidence, medical intent" block, and the approve control.
**Must NOT show** A disabled extension-submit button. Any transmission.

---

### Beat 10 — Extension approved, submit unlocked

**Backend state** `act2.phase: REMEDIATION_APPROVED`
**What changed** Second named human approval bound to the exact remediation hash.
**Data available** `remediation.approval: {approvedBy, role, at, remediationHash, outcome}`
**Assistant capabilities** **+`submit_authorization_extension`**
**Activity** + "A. Reyes · Approved extension request"
**Lower region** APPROVED — "The assistant now has the capability to submit this
exact extension request."
**Must NOT show** Any payer update. Approval did not transmit.

---

### Beat 11 — Extension submitted

**Backend state** `act2.phase: REMEDIATION_SUBMITTING` → settle
**Data available** `remediation.submission.remediationSubmissionId`, `attempts: 1`
**Assistant capabilities** status only
**Lower region** PENDING — "Remediation submitted to simulated payer · pending"
**Must NOT show** Alignment before the payer's validity is persisted.

---

### Beat 12 — Authorization aligned (terminal)

**Backend state** `act2.phase: AUTHORIZATION_ALIGNED`
**What changed** Persisted payer validity now `2026-10-03`, which **covers**
`2026-09-18`. Recomputed, never asserted from HTTP 200.
**Data available** `remediation.currentValidThrough: "2026-10-03"`,
`submission.outcome: "updated"`, `extensionReceiptId: "NS-EXT-…"`,
`payerAuthorizationReference: "NS-40192"`
**Assistant capabilities** `get_order_context`, `check_authorization_status`.
**All mutation withdrawn.**
**Activity** + "Simulated payer · Updated authorization validity"
**Lower region** SIMULATED PAYER · AUTHORIZATION UPDATED — scheduled MRI
"Covered by authorization", administrative readiness "Ready", reference
`#NS-40192 · EXT`, validity through Oct 3, and the notice **"Administrative
alignment only — not a clinical determination."**
**Must NOT show** A clinical determination. Real-payer framing. Any remaining
mutating capability.

---

### Beat 13 — Missing-evidence refusal (adversarial)

**Backend** any state <5/5. `POST /prepare` →
```json
{ "code": "MISSING_REQUIRED_EVIDENCE",
  "message": "Requirements without current evidence: req-003",
  "retryable": false, "correlationId": "31a8e3a2-…" }
```
HTTP **409**. Verified live.
**Lower region** BLOCKED with the exact missing requirement.
**Must NOT show** A path around it. WellAuth remains incomplete — that is the
correct behavior.

---

### Beat 14 — Agent attempts to self-authorize (adversarial)

Verified live, all three:

| Attempt | Result | Payer calls |
|---|---|---|
| `POST /submit` at `PREPARED_AWAITING_APPROVAL` | `409 APPROVAL_REQUIRED` | 0 |
| `POST /approval` without workforce headers | `401 APPROVER_IDENTITY_REQUIRED` | 0 |
| `POST /remediation/submit` at `REMEDIATION_PREPARED` | `REMEDIATION_APPROVAL_REQUIRED` | 0 |

---

## 7. Representative JSON

All captured live. Full files: see §7.15 for the manifest of what was recorded.

### 7.1 Initial — authorization required
```json
{ "workflowId": "wf-wellauth-001", "state": "CONTEXT_READY", "revision": 1,
  "payer": "Northstar Health Plan", "requirementSetVersion": null,
  "completeness": { "satisfied": 0, "required": 5, "complete": false },
  "order": { "service": { "display": "Cardiac MRI with contrast", "code": "75561" },
             "status": "active", "intent": "order",
             "scheduled": "2026-09-18T09:30:00Z",
             "coverage": { "payer": "Northstar Health Plan", "status": "active" } },
  "scheduledServiceDate": "2026-09-18",
  "scheduledServiceDisplay": "September 18 · 9:30 AM",
  "requirements": [], "bindings": [],
  "packetHash": null, "approval": null, "submission": null, "remediation": null,
  "act2": { "phase": null, "alignment": null },
  "availableTools": ["get_order_context", "discover_coverage_requirements"],
  "simulated": true }
```

### 7.2 Requirements discovered
```json
{ "state": "REQUIREMENTS_RESOLVED", "revision": 2,
  "requirementSetVersion": "northstar-cardiac-mri-v1",
  "completeness": { "satisfied": 0, "required": 5, "complete": false },
  "requirements": [ /* the five objects in §2.3 */ ], "bindings": [],
  "act2": { "phase": null, "alignment": null },
  "availableTools": ["get_order_context", "discover_coverage_requirements",
    "find_supporting_evidence", "inspect_evidence", "attach_evidence"] }
```

### 7.3 Four of five
```json
{ "state": "REQUIREMENTS_RESOLVED", "revision": 6,
  "completeness": { "satisfied": 4, "required": 5, "complete": false },
  "bindings": [
    { "requirementId": "req-001", "evidenceHandle": "ev_0b5a99faaba89bbcfefa",
      "resourceType": "Condition", "sourceVersionId": "MTc4Nzc4MDA2ODU3ODk3MDAwMA",
      "bindingRule": "structured-resource-path",
      "boundAt": "2026-08-27T01:31:02.436Z", "boundAtRevision": 3 },
    { "requirementId": "req-002", "resourceType": "DiagnosticReport",
      "bindingRule": "structured-resource-path", "boundAtRevision": 4 },
    { "requirementId": "req-004", "resourceType": "PractitionerRole",
      "bindingRule": "structured-resource-path", "boundAtRevision": 5 },
    { "requirementId": "req-005", "resourceType": "Coverage",
      "bindingRule": "structured-resource-path", "boundAtRevision": 6 } ],
  "packetHash": null,
  "availableTools": ["get_order_context", "discover_coverage_requirements",
    "find_supporting_evidence", "inspect_evidence", "attach_evidence",
    "remove_evidence"] }
```

### 7.4 Five of five
```json
{ "state": "PACKET_COMPLETE", "revision": 7,
  "completeness": { "satisfied": 5, "required": 5, "complete": true },
  "bindings": [ /* …+ */
    { "requirementId": "req-003", "evidenceHandle": "ev_b5f045fd2cc22a1a3779",
      "resourceType": "DocumentReference",
      "sourceVersionId": "MTc4Nzc4MDA3MDMzNTg2NjAwMA",
      "bindingRule": "alternate-document-path", "boundAtRevision": 7 } ],
  "availableTools": ["get_order_context", "find_supporting_evidence",
    "inspect_evidence", "attach_evidence", "remove_evidence",
    "prepare_prior_authorization"] }
```

### 7.5 Prepared awaiting approval
```json
{ "state": "PREPARED_AWAITING_APPROVAL", "revision": 8,
  "manifestRevision": 1, "preparedRevision": 8,
  "packetHash": "sha256:e80e62bf8aad42a415321a312088ac07285337f6f8cb058b13e9f78fe9644f10",
  "approval": null, "submission": null,
  "availableTools": ["get_order_context", "find_supporting_evidence",
    "inspect_evidence", "attach_evidence", "remove_evidence"] }
```
Note: **no submission capability of any kind.** Disclosure body in §2.7.

### 7.6 Approved / submit unlocked
```json
{ "state": "APPROVED", "revision": 9,
  "approval": { "approvedBy": "A. Reyes", "role": "prior-auth-coordinator",
    "at": "2026-08-27T01:31:29.492Z", "manifestRevision": 1,
    "packetHash": "sha256:e80e62bf…", "workflowRevision": 8, "outcome": "APPROVED" },
  "submission": null,
  "availableTools": ["get_order_context", "find_supporting_evidence",
    "inspect_evidence", "attach_evidence", "remove_evidence",
    "submit_prior_authorization"] }
```
Approval response body: `{"state":"APPROVED","submitted":false, …}` —
**`submitted: false` proves approval does not transmit.**

### 7.7 Submitted / pending

> **The one constructed example.** Every other block in §7 was captured live.
> The canonical simulator answers `/submit` synchronously, so the demo path
> transitions straight to 7.8 and this intermediate snapshot was never observed.
> `SUBMITTED_OR_PENDING` is genuinely reachable (payer `outcome: queued`/
> `partial`), and the shape below follows `projectSubmission()` exactly — but
> treat it as shape-accurate, not captured.

```json
{ "state": "APPROVED",
  "submission": { "submissionId": "sub-c4ffb975-…",
    "state": "SUBMITTED_OR_PENDING", "payerStatus": "pending",
    "claimIdentifier": "WA-wf-wellauth-001-e80e62bf8aad42a415321a31",
    "destination": "Northstar Health Plan", "attempts": 1,
    "authorizationPeriod": null, "payerReference": null, "simulated": true },
  "act2": { "phase": null, "alignment": null },
  "availableTools": ["get_order_context", "check_authorization_status"] }
```

### 7.8 Payer approved but date mismatch ★
```json
{ "state": "APPROVED", "revision": 11,
  "submission": { "state": "COMPLETE", "payerStatus": "approved",
    "claimIdentifier": "WA-wf-wellauth-001-e80e62bf8aad42a415321a31",
    "attempts": 1, "payerReference": "NS-40192",
    "authorizationPeriod": { "start": "2026-08-26", "end": "2026-09-12" },
    "completedAt": "2026-08-27T01:31:32.883Z", "simulated": true },
  "scheduledServiceDate": "2026-09-18",
  "act2": { "phase": "PAYER_APPROVED_COVERAGE_GAP",
    "alignment": { "evaluated": true, "aligned": false,
      "scheduledServiceDate": "2026-09-18", "validThrough": "2026-09-12" } },
  "remediation": null,
  "availableTools": ["get_order_context", "check_authorization_status",
    "resolve_authorization_window"] }
```

### 7.9 Remediation capability unlocked
Identical to 7.8 — **the unlock and the mismatch are the same snapshot.**
`resolve_authorization_window` is present because `act2.phase` is
`PAYER_APPROVED_COVERAGE_GAP`, nothing more.

### 7.10 Remediation prepared
```json
{ "act2": { "phase": "REMEDIATION_PREPARED", "alignment": { "aligned": false,
    "scheduledServiceDate": "2026-09-18", "validThrough": "2026-09-12" } },
  "remediation": { "type": "WellAuthAuthorizationWindowRemediation/1",
    "state": "REMEDIATION_PREPARED", "payerAuthorizationReference": "NS-40192",
    "currentValidThrough": "2026-09-12", "scheduledServiceDate": "2026-09-18",
    "requestedValidThrough": "2026-10-03",
    "reasonCode": "scheduled-service-outside-authorization-window",
    "reasonDisplay": "Scheduled service falls outside the current authorization validity window.",
    "clinicalIntentChanged": false, "evidenceChanged": false, "orderChanged": false,
    "hash": "sha256:0c2899fe6e6ba0f169f7d7e4154f79d7430bb7e81dda2799b3d3d8569fdac51a",
    "approval": null, "submission": null, "simulated": true },
  "availableTools": ["get_order_context", "check_authorization_status"] }
```

### 7.11 Remediation approved / extension submit unlocked
```json
{ "act2": { "phase": "REMEDIATION_APPROVED" },
  "remediation": { "state": "REMEDIATION_APPROVED",
    "approval": { "approvedBy": "A. Reyes", "role": "prior-auth-coordinator",
      "at": "2026-08-27T01:31:52.714Z",
      "remediationHash": "sha256:0c2899fe…", "outcome": "APPROVED" },
    "submission": null },
  "availableTools": ["get_order_context", "check_authorization_status",
    "submit_authorization_extension"] }
```

### 7.12 Remediation submitted
```json
{ "act2": { "phase": "REMEDIATION_SUBMITTED" },
  "remediation": { "state": "REMEDIATION_SUBMITTED",
    "submission": { "remediationSubmissionId": "rem-2c1d2274-…",
      "attempts": 1, "startedAt": "2026-08-27T01:31:53.390Z",
      "completedAt": null, "outcome": null, "extensionReceiptId": null } },
  "availableTools": ["get_order_context", "check_authorization_status"] }
```

### 7.13 Authorization aligned (terminal)
```json
{ "act2": { "phase": "AUTHORIZATION_ALIGNED",
    "alignment": { "evaluated": true, "aligned": true,
      "scheduledServiceDate": "2026-09-18", "validThrough": "2026-10-03" } },
  "remediation": { "state": "AUTHORIZATION_ALIGNED",
    "payerAuthorizationReference": "NS-40192",
    "currentValidThrough": "2026-10-03", "requestedValidThrough": "2026-10-03",
    "clinicalIntentChanged": false, "evidenceChanged": false, "orderChanged": false,
    "submission": { "attempts": 1, "outcome": "updated",
      "extensionReceiptId": "NS-EXT-f7e6eda6-0b65-458d-8a5a-84dd399b2c48",
      "ambiguityReason": null, "failureCode": null, "simulated": true } },
  "availableTools": ["get_order_context", "check_authorization_status"] }
```

Final `GET /authorization-status`:
```json
{ "workflowState": "APPROVED", "submissionState": "COMPLETE",
  "payerStatus": "approved", "payerReference": "NS-40192",
  "receiptId": "NS-RCPT-2e8f5e8f-…",
  "disposition": "Prior authorization approved by simulated payer",
  "authorizationPeriod": { "start": "2026-08-26", "end": "2026-09-12" },
  "claimIdentifier": "WA-wf-wellauth-001-e80e62bf…", "attempts": 1,
  "additionalInformationRequired": false, "requiresReconciliation": false,
  "payer": "Northstar Health Plan", "simulated": true,
  "simulationNotice": "Destination is a simulated payer. No real payer was contacted." }
```

> **Note for design:** `authorization-status.authorizationPeriod` reflects the
> **original** submission receipt (`end: 2026-09-12`), not the extended window.
> The post-extension validity lives at `remediation.currentValidThrough`
> (`2026-10-03`). Render final validity from `remediation`, never from
> `authorization-status`. See Gap C-4.

### 7.14 Missing-evidence refusal
```json
{ "httpStatus": 409,
  "response": { "code": "MISSING_REQUIRED_EVIDENCE",
    "message": "Requirements without current evidence: req-003",
    "retryable": false, "correlationId": "31a8e3a2-…" } }
```

### 7.15 Evidence discovery (for the fifth-beat screen)

`GET /workflows/{id}/requirements/req-003/evidence` — **this is where human
titles and clinical dates exist**, and it is the only place they do:
```json
{ "requirementId": "req-003", "status": "OK", "alternatePath": true,
  "candidates": [ { "evidenceHandle": "ev_b5f045fd2cc22a1a3779",
    "resourceType": "DocumentReference",
    "title": "Cardiology consult note - conservative therapy trial outcome",
    "code": "11488-4", "effectiveDate": "2026-08-01T09:00:00Z",
    "status": "current", "source": "wellauth/wellauth-r4",
    "sourceVersionId": "MTc4Nzc4MDA3MDMzNTg2NjAwMA",
    "matchedBy": { "requirementId": "req-003", "resourceType": "DocumentReference",
      "policy": "alternate-document-path" } } ] }
```
Note `resourceId` is **stripped** on this route by design (opaque handles only).

---

## 8. Contract gaps

### A — Already available (consume directly)

- Workflow, submission, and Act II state; `revision`.
- `completeness` counts; the 4/5 → 5/5 progression.
- Requirement labels, expected resource types, `alternatePath`.
- Bindings with exact source versions and `boundAt`.
- Full prepared disclosure incl. exclusion policy and packet hash.
- Both approvals with named approver, role, timestamp, and approved hash.
- Payer decision, reference `NS-40192`, `authorizationPeriod`, `attempts`.
- Both alignment dates, `aligned` boolean, `phase`.
- Remediation artifact incl. the explicit unchanged-scope triple.
- **`availableTools`** — the entire capability lifecycle.
- Bounded error codes for every refusal.
- `simulated: true` and `simulationNotice` for honest labelling.

### B — Presentation derivation only (safe, deterministic)

- Formatting `scheduled` → "September 18 · 9:30 AM" (or use
  `scheduledServiceDisplay`, already pre-formatted).
- Truncating `sha256:…` for display; truncating opaque base64 version ids.
- Mapping `availableTools` → the healthcare labels in §3.2.
- Deriving the context-band status string from `act2.phase` → `submission` →
  `state` precedence.
- MET/OPEN per requirement = "does a binding exist for this id".
- Building the Activity list per §5.
- Rendering `exclusionPolicy.excludes` as prose.

### C — Small backend projection needed (truth exists, not cleanly exposed)

**C-1 · Patient demographics are absent from the snapshot.**
The context band calls for a patient identity, and the locked IA lists
"synthetic patient". The snapshot exposes **no** patient name, DOB, MRN, or sex
— only `patientContextRef: "Patient/wellauth-patient-001"` inside the disclosure.
The current smoke UI **hardcodes "J. Alvarez"** in `src/App.tsx`. A truthful
final UI needs a bounded `patient: {display, syntheticLabel}` projection read
from the FHIR `Patient` resource. *Not solved here.*

**C-2 · Bindings carry no evidence title or clinical date.**
The locked IA specifies `↳ evidence title · date · source · attached by
assistant`. `bindings[]` has `resourceType`, `sourceVersionId`, `boundAt` — but
no `title` and no `effectiveDate`. Those values **do** exist on the evidence
discovery route (§7.15) and are simply not carried onto the binding. The smoke
UI works around this with a hardcoded `resourceType → title` map. Options: (a)
persist `title`/`effectiveDate` on the binding at attach time; (b) add them to
the snapshot's binding projection. *Not solved here.*

**C-3 · Most Activity events have no durable per-event timestamp.**
Only `boundAt`, `approval.at`, and `remediation.approval.at` are real times.
"Discovered requirements", "Prepared submission", "Submitted", and the payer
events are derived from state presence and render with a blank time. A durable
transition ledger **already exists** in Firestore
(`workflowRef/transitions`, written by `appendTransition`) with `operation`,
`to`, `revision`, and `at` — it is simply **not exposed over HTTP**. A read-only
projection of that ledger would make the whole timeline properly stamped and
ordered. *Not solved here.*

**C-4 · Post-extension validity is not reflected in `authorization-status`.**
After a successful extension, `GET /authorization-status.authorizationPeriod`
still returns the **original** receipt window (`end: 2026-09-12`) while the true
current validity is `remediation.currentValidThrough` (`2026-10-03`). Any screen
reading validity from `authorization-status` will show a stale date. Workaround
available today: read from `remediation`. A cleaner projection would have
`authorization-status` reflect the effective current window. *Not solved here.*

**C-5 · Act II error codes are absent from the HTTP status map.**
`provider/index.js` `HTTP_STATUS` contains no entry for the ten Act II codes
(`REMEDIATION_APPROVAL_REQUIRED`, `REMEDIATION_STALE`, `REMEDIATION_IN_PROGRESS`,
`REMEDIATION_ALREADY_PREPARED`, `REMEDIATION_ALREADY_SUBMITTED`,
`REMEDIATION_HASH_MISMATCH`, `REMEDIATION_NOT_AVAILABLE`, `NO_COVERAGE_GAP`,
`UNKNOWN_REMEDIATION_OUTCOME`, `PAYER_REJECTED_REMEDIATION`). They fall through
to the `?? 400` default. Verified live: extension-submit before approval returns
**HTTP 400** carrying `REMEDIATION_APPROVAL_REQUIRED`, where Act I's equivalent
returns **409**. The body code is correct and bounded — only the HTTP status is
misleading. **Design should key off `code`, never the HTTP status.** *Not solved
here.*

### D — Unsupported (would require new product/backend behavior)

**D-1 · Worklist.** The locked IA has a thin Worklist above the workspace. The
backend supports exactly **one** canonical workflow (`wf-wellauth-001` in
`policy.js`); there is no list endpoint and no second workflow. A Worklist can
only be presentational scaffolding around the single real row. Anything richer
is new product behavior.

**D-2 · Per-tool-call activity feed.** Activity is derived from durable state,
so read-only calls (`get_order_context`, `find_supporting_evidence`,
`inspect_evidence`, `check_authorization_status`) leave **no trace** and cannot
appear on a reload-stable timeline. A design showing "Assistant searched the
record" as a persistent event is not supported. (`src/webmcp.ts` has an
in-memory `InvocationLog`, but it dies on reload and is explicitly not
authoritative.)

**D-3 · Denial / resubmission journey.** `payerStatus: "denied"` is a real
terminal state, but there is no appeal, correction, or resubmission flow behind
it. Design it as terminal or leave it out.

**D-4 · Real-time push.** External payer changes propagate by **5-second
polling**, and only while `submission.state === 'SUBMITTED_OR_PENDING'` or a
remediation outcome is pending. There is no SSE/WebSocket. A UI implying live
push is not backed.

---

## 9. Integration invariants

1. **The frontend must not infer workflow eligibility.** Whether an action is
   possible is answered by `availableTools`, never by reading `state` and
   applying rules.
2. **The frontend must not calculate whether submission is allowed.** No
   client-side "5/5 so we can prepare" logic. The server publishes the capability.
3. **The frontend must not maintain its own capability state machine.**
   `capabilitiesFor()` is a pure function of persisted state; the client mirrors
   its output.
4. **WebMCP and the Assistant UI derive from the same authoritative capability
   state.** Both read `availableTools` from the same snapshot. They cannot drift.
5. **Reload must reconstruct the current page.** All state comes from
   `GET /snapshot`; there is no React-held workflow state. A hard refresh at any
   beat reproduces the identical page **and** the identical browser tool
   inventory.
6. **Externally changing payer state must propagate without reload.** Bounded
   5s polling while an outcome is owed; a snapshot replacement re-syncs
   capabilities automatically.
7. **Clinical source truth must not be mutated by the UI.** The provider
   identity is `healthcare.fhirResourceReader` — read-only. No UI path writes
   FHIR. Attaching evidence is workflow bookkeeping, not a record change.
8. **Every mutating call must echo `expected_revision`** from the latest
   snapshot. A stale revision → `REVISION_CONFLICT`, by design.
9. **Smoke-test UI presentation is disposable.** `src/*.tsx` styling, copy,
   hardcoded titles, and the hardcoded patient name carry no authority.
10. **Existing backend/WebMCP integration plumbing is reusable.**
    `src/capabilities.ts` (tool registry, snapshot fetch, approval calls) and
    `src/webmcp.ts` (AbortSignal-based registration lifecycle, sync
    serialization) encode hard-won native-Chrome behavior and should be kept.
11. **Absence is the affordance, but not the security boundary.** Every route
    re-validates independently. Never render a disabled control where the
    product's point is that the capability does not exist.
12. **Simulation must stay labelled.** `simulated: true` is on every payer-touching
    object. "SIMULATED PAYER" must remain visible wherever a payer decision shows.

---

## 10. Verification

Contract claims were verified by executing the complete canonical demo against
the deployed provider, plus the in-repo suites.

| Check | Method | Result |
|---|---|---|
| Unit/integration suites | `npx vitest run` | **73/73 pass** (5 files) |
| Capability lifecycle | `capabilitiesFor()` over 18 reachable states | matches §3 exactly |
| Act I beats 1–6 | live HTTP against deployed provider | captured, §7.1–7.6 |
| 4/5 prepare refusal | live `POST /prepare` | `409 MISSING_REQUIRED_EVIDENCE` |
| Submit before approval | live `POST /submit` | `409 APPROVAL_REQUIRED`, 0 payer calls |
| Approval without workforce headers | live `POST /approval` | `401 APPROVER_IDENTITY_REQUIRED` |
| Approval does not transmit | live approval response | `submitted: false`, `submission: null` |
| Submission + payer decision | live `POST /submit` | `COMPLETE` / `approved` / `NS-40192` |
| Act II gap detection | live snapshot | `PAYER_APPROVED_COVERAGE_GAP`, `aligned: false` |
| Extension submit before 2nd approval | live | `REMEDIATION_APPROVAL_REQUIRED`, 0 payer calls |
| Act II through alignment | live | `AUTHORIZATION_ALIGNED`, validity `2026-10-03` |
| Reload reconstruction | every beat read via fresh `GET /snapshot` | identical state + tools |
| Demo reset | `POST /demo/reset` | back to `CONTEXT_READY` rev 1 |

The deployed workflow was reset to `CONTEXT_READY` after capture, so the demo is
in a clean filmable state.

---

## 11. Summary for Claude Design

1. **One read powers everything:** `GET /workflows/wf-wellauth-001/snapshot`.
   It carries state, clinical context, requirements, evidence, payer result,
   Act II posture, and the authoritative capability list.
2. **Never compute what the assistant can do.** Render `availableTools`. When a
   capability is absent it is genuinely unregistered in the browser — draw
   nothing, not a disabled button.
3. **Three axes, in this precedence:** `act2.phase` → `submission` → `state`.
   `state` stays `APPROVED` through all of Act II; that is correct.
4. **Two hero beats must not be compressed:** the 4/5 → 5/5 fifth-evidence beat
   (`bindingRule: alternate-document-path`), and the human-approval → submit-unlock
   beat. Both are backed by real state changes.
5. **The Act II gap is real data:** MRI `2026-09-18` vs validity `2026-09-12`,
   `aligned: false`. The payer's own response unlocked a new capability — nothing
   the browser did.
6. **Both approvals are workforce-only and neither transmits.** They approve an
   exact hash (`packetHash`, `remediation.hash`) at an exact revision.
7. **You can truthfully show:** exact disclosure contents with source versions,
   the exclusion policy, named approvers with timestamps, transmission counts,
   payer reference `NS-40192`, and the explicit "clinical intent unchanged" triple.
8. **Five things you will want that need backend work (§8, Category C/D):**
   patient name, evidence titles/dates on bindings, per-event Activity
   timestamps, post-extension validity in `authorization-status`, and a real
   Worklist. Do not design as if these exist — flag them.
9. **Key off bounded `code` values, never HTTP status** (Act II codes currently
   return 400 where Act I returns 409).
10. **Keep `src/capabilities.ts` and `src/webmcp.ts`.** Their WebMCP lifecycle
    handling is verified against native Chrome. Everything visual is disposable.
