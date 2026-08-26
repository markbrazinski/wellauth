# Gate 2 — Server-authoritative workflow state

Durable, concurrency-safe workflow state binding exact versioned FHIR evidence
to explicit payer requirements, with human-only approval of a frozen packet.

**No payer submission exists in Gate 2.** `APPROVED` is terminal.

## Authority model

| Layer | Authoritative for | Access |
|---|---|---|
| FHIR R4 (Cloud Healthcare) | clinical source truth | provider reads only (`fhirResourceReader`) |
| Firestore `wellauth-workflow` | workflow truth | provider read/write, scoped by IAM condition |
| Browser / WebMCP agent | nothing | supplies intent + `expected_revision` only |

Gate 1 established that Cloud Healthcare FHIR **search is not read-after-write
consistent** (direct reads are; the search index lags). Consequently no workflow
transition is written to FHIR, and no correctness check depends on search.
Freshness is proven exclusively by direct version-aware reads
(`GET /{type}/{id}` → `meta.versionId`).

## State machine

| State | Allowed domain operations | Invariant |
|---|---|---|
| `CONTEXT_READY` | `resolve_requirements` | order + coverage read at exact versions and bound to the workflow patient |
| `REQUIREMENTS_RESOLVED` | `attach_evidence`, `remove_evidence` | requirement-set version pinned; completeness < 5/5 |
| `PACKET_COMPLETE` | `attach_evidence`, `remove_evidence`, `prepare` | server recomputed 5/5 from its own bindings |
| `PREPARED_AWAITING_APPROVAL` | `record_submission_approval`, `attach_evidence`, `remove_evidence` | frozen immutable manifest + deterministic hash exist; the agent has **no** operation that advances this state |
| `APPROVED` | (terminal in Gate 2) | approval bound to exact manifest revision, packet hash, workflow revision, identity and role |

There is no state setter. A caller names an **operation**, never a target
state; `state` in a request body is ignored. Any binding change or source
version change drops the workflow back to `PACKET_COMPLETE`/`REQUIREMENTS_RESOLVED`
and clears manifest, hash and approval atomically.

## Firestore model

Database `wellauth-workflow` (nam5, free tier), collection `wellauth_workflows`.

```
wellauth_workflows/{workflowId}
  workflowId, state, revision, patientId, payer
  order:    { resourceType, id, versionId }
  coverage: { resourceType, id, versionId }
  requirementSetVersion, requirementsResolved
  completeness: { satisfied, required, complete, missing[] }
  manifestRevision            # current, cleared on invalidation
  lastManifestRevision        # monotonic; manifests are append-only
  preparedRevision, packetHash
  approval: { approvalId, approvedBy, role, manifestRevision,
              packetHash, workflowRevision, nonce, at, outcome }
  consumedNonces[]            # one-time approval nonces
  createdAt, updatedAt

  bindings/{requirementId}    # one doc per requirement
    requirementId, evidenceHandle, resourceType, resourceId,
    sourceVersionId, bindingRule, boundAt, boundAtRevision

  manifests/{manifestRevision}   # immutable, append-only
    artifact, workflowId, requirementSetVersion, destination, purpose,
    order, coverage, patientContextRef, items[], exclusionPolicy,
    packetHash, preparedAt, preparedAtRevision

  handles/{evidenceHandle}    # bounded handle -> exact scoped source
    requirementId, resourceType, resourceId, observedVersionId, registeredAt

  idempotency/{key}           # prepare + approve replay protection
    operation, status, result, at, completedAt

  transitions/{auto}          # append-only transition ledger
    operation, from, to, revision, at, ...
```

No raw clinical resource is copied into Firestore — only
`resourceType/id/versionId` triples. No indexes beyond Firestore's automatic
single-field indexes were created (all reads are by document path).

### Handle registry (Gate 1 improvement)

Gate 1 validated an evidence handle by replaying all five bounded searches.
Gate 2 runs those searches **once**, at `resolve_requirements`, and persists
`handle → {requirementId, resourceType, resourceId, versionId}`. Attach and
prepare then use direct version-aware reads against that stored scope.
Context checks are unchanged: a handle stays bound to workflow, patient,
requirement and source version, and a foreign handle is refused identically to
an unknown one (no existence oracle).

## Packet hash

- **Serialization**: `canonicalize()` in `provider/canonical.js` — JSON with
  object keys emitted in ascending code-unit order at every depth; `undefined`
  dropped, `null` preserved; arrays pre-sorted on `requirementId`.
- **Algorithm**: SHA-256 over the UTF-8 bytes, lowercase hex, `sha256:` prefix.
- **Scope**: disclosure **content** only. Revision counters, timestamps and
  transport fields are excluded, so re-preparing an identical packet hashes
  identically; any change to a bound version, requirement-set version, order,
  coverage, destination or purpose changes the hash.

## Human approval

`POST /workflows/{id}/approval` — deliberately **not** a WebMCP tool and not
reachable by an agent. Requires `X-WellAuth-User` + `X-WellAuth-Role` headers
(role must be in `APPROVER_ROLES`); a missing identity is `401`, an `agent`
role is `403`. The server takes the packet hash from **its own** workflow
record; a client-supplied `acknowledged_packet_hash` is only ever compared.
Approval re-verifies completeness and full source freshness first, and a stale
preparation is torn down atomically rather than approved.

## Concurrency & idempotency

Every mutating operation requires `expected_revision` and commits inside a
Firestore transaction that re-asserts the revision. Two conflicting operations
at the same revision: exactly one commits, the other gets `REVISION_CONFLICT`
carrying the current revision. `prepare` and `approve` accept an
`Idempotency-Key`; a replay returns the original recorded result rather than
transitioning again, and approval nonces are one-time (`consumedNonces`).

## Cloud state

- Cloud Run: `wellauth-provider`, us-central1, revision `wellauth-provider-00005-hn5`, `--no-allow-unauthenticated`
- Runtime SA: `wellauth-provider-sa@preflight-hackathon.iam.gserviceaccount.com`
  - `roles/healthcare.fhirResourceReader` on FHIR store `wellauth-r4` (read-only)
  - `roles/datastore.user`, **IAM-conditioned** to
    `projects/preflight-hackathon/databases/wellauth-workflow`
- Fixture SA (tests only): `wellauth-fixture-sa@preflight-hackathon.iam.gserviceaccount.com`
  - `roles/healthcare.fhirResourceEditor` — the only identity permitted to
    mutate FHIR; used solely to advance source versions in P0.10/P0.12.
    The provider was **not** granted write access to make tests easier.
- No browser access to Firestore; no public rules; the service is not public.

## Cleanup

```sh
gcloud run services delete wellauth-provider --region us-central1
gcloud firestore databases delete --database=wellauth-workflow
gcloud iam service-accounts delete wellauth-fixture-sa@preflight-hackathon.iam.gserviceaccount.com
# Gate 1 Healthcare dataset/FHIR store are deliberately NOT deleted.
```

## Tests

```sh
npm test                                                     # Gate 0   46/46
npm run test:fhir-smoke                                      # Gate 1   93/93
SMOKE_BASE_URL=<url> npm run test:fhir-smoke                 # Gate 1   94/94
npm run test:gate2                                           # Gate 2  147/147
GATE2_BASE_URL=<url> npm run test:gate2                      # Gate 2  147/147
```

## Not claimed

Gate 2 does **not** claim: submitted to payer, PAS submission, `ClaimResponse`,
payer approval, end-to-end prior authorization, production ready, or HIPAA
compliant. The frozen artifact is explicitly named
`WellAuthPreparedSubmission/1` — an internal representation, **not** a FHIR PAS
Bundle. PAS compilation belongs to Gate 3.
