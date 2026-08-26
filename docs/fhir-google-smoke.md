# Gate 1 Runbook — Google Cloud + FHIR truth layer

Proves: a bounded provider service reads one existing synthetic cardiac-MRI
order and its supporting evidence from a real Cloud Healthcare API FHIR R4
store, returns exact source versions, deterministically excludes irrelevant or
invalid evidence, prevents cross-context lookup, and does not mutate clinical
truth.

Gate 1 contains **no** WebMCP, no Firestore, no approval, no packet hashing, no
payer submission. Those belong to later gates.

## Architecture

```
test client / curl
      │  HTTPS + Google ID token (Cloud Run IAM)
      ▼
WellAuth Provider Service          Cloud Run: wellauth-provider
      │  bounded domain endpoints only
      │  FHIR R4 reads (no writes)
      ▼
Cloud Healthcare API               dataset wellauth / store wellauth-r4 (R4)
```

The provider never accepts a FHIR query. Callers pass opaque workflow,
requirement, and evidence identifiers; every FHIR search parameter is chosen
server-side in `provider/policy.js`.

## Google Cloud state

| Item | Value |
|---|---|
| Project | `preflight-hackathon` |
| Region / location | `us-central1` |
| Healthcare dataset | `wellauth` |
| FHIR store | `wellauth-r4` |
| FHIR version | R4, `4.0.1` (confirmed via store CapabilityStatement) |
| Cloud Run service | `wellauth-provider` |
| Service account | `wellauth-provider-sa@preflight-hackathon.iam.gserviceaccount.com` |
| IAM granted | `roles/healthcare.fhirResourceReader`, scoped to the FHIR store only |
| Ingress auth | `--no-allow-unauthenticated`; anonymous requests receive 403 |

All GCP resources are `wellauth`-prefixed so they can be identified and removed
without touching unrelated project resources.

The runtime identity holds **no** write role. The read-only invariant is
enforced by IAM, not only by application code.

## Files

| File | Purpose |
|---|---|
| `provider/fhir.js` | Minimal FHIR R4 read client (read/search/metadata) |
| `provider/policy.js` | Workflow bindings + server-defined search policy |
| `provider/service.js` | Bounded domain operations and projections |
| `provider/index.js` | HTTP layer, error semantics, correlation IDs |
| `provider/seed.js` | Fixture loader (requires separate write credentials) |
| `provider/smoke.js` | P0.1–P0.13 smoke suite |
| `provider/fixtures/seed.json` | 22 synthetic R4 resources |
| `Dockerfile` | Cloud Run container |

## Fixture inventory

Synthetic hero case, workflow `wf-wellauth-001`.

Supporting: `Patient/wellauth-patient-001`, `Practitioner/wellauth-practitioner-001`,
`PractitionerRole/wellauth-practrole-001`, `Organization/wellauth-org-northstar`,
`Organization/wellauth-org-clinic`, `ServiceRequest/wellauth-order-001` (CPT
75561, status `active`, intent `order`), `Coverage/wellauth-coverage-001`,
`Condition/wellauth-condition-001`, `Condition/wellauth-condition-002`,
`DiagnosticReport/wellauth-echo-001`, `Observation/wellauth-obs-lvef-001`,
`DocumentReference/wellauth-doc-conservative-therapy`.

Decoys: `Condition/wellauth-condition-decoy-stale` (2019, out of window),
`Condition/wellauth-condition-decoy-erroneous` (entered-in-error),
`Condition/wellauth-condition-decoy-ortho` (unrelated ankle sprain),
`Condition/wellauth-condition-crosspatient` (patient 002),
`DiagnosticReport/wellauth-echo-decoy-prelim` (preliminary),
`DiagnosticReport/wellauth-lab-decoy` (unrelated CBC),
`DocumentReference/wellauth-doc-decoy-superseded` (superseded),
`DocumentReference/wellauth-doc-decoy-ortho` (unrelated ortho note),
`Coverage/wellauth-coverage-decoy-cancelled` (cancelled),
`Patient/wellauth-patient-002` (second patient).

Northstar Health Plan is fictional. The five requirements are fixture data with
a CRD-informed *shape*; they are not CRD output and not real payer criteria.

## The fifth evidence beat

Requirements 1, 2, 4, 5 resolve from discrete structured resources (Condition,
DiagnosticReport, PractitionerRole, Coverage). Requirement 3 ("failed or
contraindicated conservative therapy") exists **only** as a `DocumentReference`
narrative note, so it requires a different bounded search path. The difference
is structural — no artificial delay — which supports the eventual "4 of 5 →
searching authorized record → found" product beat.

## Running the smoke

Local (in-process, uses your ADC):

```bash
npm run test:fhir-smoke
```

Against the deployed Cloud Run service:

```bash
SMOKE_BASE_URL=https://wellauth-provider-620464070103.us-central1.run.app \
  npm run test:fhir-smoke
```

Expected final line: `ALL P0 CHECKS PASSED` (94 checks against Cloud Run, 93
in-process; the extra check is the deployed health re-query).

The smoke requires an authenticated identity. It reads `SMOKE_ID_TOKEN` if set,
otherwise shells out to `gcloud auth print-identity-token`.

## Reseeding

Requires write-capable credentials — deliberately **not** the provider service
account:

```bash
npm run fhir:seed
```

Idempotent: resources are PUT by id in dependency order. Note the store has
`enableUpdateCreate: true` (needed for PUT-as-create) and enforces referential
integrity, so seeding cannot use a transaction Bundle with forward references.

## Cleanup

Removes every Gate 1 GCP resource:

```bash
gcloud run services delete wellauth-provider --region=us-central1 --quiet
gcloud healthcare datasets delete wellauth --location=us-central1 --quiet
gcloud iam service-accounts delete \
  wellauth-provider-sa@preflight-hackathon.iam.gserviceaccount.com --quiet
```

## Cost

Healthcare API storage for this fixture is a few KB; the smoke issues a few
hundred API calls. Expected cost is well under $0.05 for the gate. The standing
cost of leaving the dataset in place is effectively zero, but delete it when the
project ends.

## Limitations

- The requirement set is fixture data, not CRD/DTR output.
- No FHIR profile validation is run in CI. The store enforces base R4
  invariants at write time (it rejected a `con-5` violation during seeding), but
  no named profile conformance is claimed.
- P0.6 toggles one fixture using separate write credentials and restores it.
  Content is restored byte-identically, but Cloud Healthcare assigns a new
  `versionId` on every write, so that resource's version advances. P0.11
  asserts content equality for all watched resources and version equality for
  every resource the toggle did not touch.
- Cloud Healthcare FHIR **search is not read-after-write consistent**: a write
  lands immediately for `read`, but the search index catches up asynchronously
  (observed lag under ~1s). P0.6 polls the bounded endpoint for up to 10s after
  toggling a fixture. This affects the test harness only; the provider itself
  issues no writes. It matters for Gate 2: any read-modify-write workflow state
  must not rely on FHIR search to observe its own writes.
- Stale-state *protection* is not built. Gate 1 only proves the version
  primitive (`meta.versionId` + ETag) is retrievable.
- Evidence detail resolution replays the workflow's allowed searches to
  validate a handle. Correct and safely bounded, but O(requirements) FHIR calls.

## Claims language

Safe: "WellAuth reads synthetic FHIR R4 resources from Google Cloud Healthcare
API through a bounded provider service."

Not claimed: FHIR compliant, SMART on FHIR, CRD/DTR/PAS conformant, HIPAA
compliant, production ready.
