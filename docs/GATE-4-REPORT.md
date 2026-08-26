# Gate 4 — the integrated product

The proven gates assembled into the judgeable WellAuth application: one
same-origin Cloud Run service serving the Clinical Instrument workspace over
real FHIR R4 clinical truth, server-authoritative Firestore workflow state, and
a distinct simulated payer — with Act II's external-state remediation.

**All clinical data is synthetic. Northstar Health Plan is fictional and every
payer interaction is with a clearly labelled simulator.**

## Verdict

**PASS**

Act I and Act II both operate end-to-end against the deployed public URL. Every
P0 passes in-process and deployed, in a real browser, with no prior-gate
regressions.

One inherited limitation carries forward unchanged from Gate 3: full Da Vinci
PAS IG validation never produced a verdict (`GATE-3-PAS-VALIDATION.md`). It is
scoped to a standards *claim*, not to any Gate 4 mechanism, and the claim
language is bounded accordingly.

## Repository

| | |
|---|---|
| Starting SHA | `f7a5c6d` (accepted Gate 3 end) |
| Ending SHA | `7d36687` + this report |
| Working tree | clean |

New: `provider/remediation.js`, `provider/capabilities.js`, `provider/fixture.js`,
`provider/gate4.js`, `payer/fixture.js`, `src/{Requirements,Assistant,Activity,LowerRegion}.tsx`,
`src/styles.css`, `test/{capabilities,alignment}.test.js`, `browser-acceptance.mjs`.

Modified: `provider/{index,workflow,submission}.js`, `payer/{index,store}.js`,
`src/{App.tsx,capabilities.ts,webmcp.ts,main.tsx}`, `Dockerfile`,
`provider/fixtures/seed.json`, `index.html`, `package.json`, `.gcloudignore`.

## Deployment

| Resource | Value |
|---|---|
| Judge URL | https://wellauth-provider-qxqdngmwjq-uc.a.run.app |
| Provider | `wellauth-provider-00013-qj8`, **`--allow-unauthenticated`** |
| Payer | `wellauth-payer-simulator-00006-pvp`, `--no-allow-unauthenticated` |
| Provider SA | `wellauth-provider-sa` — `healthcare.fhirResourceReader` (read-only) |
| Payer SA | `wellauth-payer-sa` — no Healthcare API access of any kind |

**Deviation from the Gate 3 posture, explicitly approved:** the provider is now
public. A judge cannot open an invoker-locked URL in a browser, and the
commission forbids hidden terminal steps. All data is synthetic and every route
is bounded. The payer stays invoker-locked and the provider→payer hop still
carries a Cloud Run ID token, so the trust boundary Gate 3 proved is untouched.

### Topology

The provider **serves the built UI itself**. Same origin means no CORS, no
cross-origin cookie or WebMCP question, and one URL. Domain routes match before
the static fallback, so serving can never shadow an API route.

## Canonical journey (verified on the deployed URL)

| # | Actor | Action | Backend | Browser tools |
|---|---|---|---|---|
| 1 | — | load | `CONTEXT_READY` | `get_order_context`, `discover_coverage_requirements` |
| 2 | agent | discover requirements | `REQUIREMENTS_RESOLVED` rev 2 | +evidence tools (5 total) |
| 3 | agent | attach ×4 | 4/5 | +`remove_evidence` |
| 4 | agent | fifth via alternate document path | `PACKET_COMPLETE` 5/5 | +`prepare_prior_authorization` |
| 5 | agent | prepare | `PREPARED_AWAITING_APPROVAL` | **−prepare, no submit** |
| 6 | **human** | Approve submission | `APPROVED` | **+`submit_prior_authorization`** |
| 7 | agent | submit | payer `approved`, `NS-40192` | −submit, +status |
| 8 | WellAuth | evaluate coverage | `PAYER_APPROVED_COVERAGE_GAP` | **+`resolve_authorization_window`** |
| 9 | agent | resolve window | `REMEDIATION_PREPARED` | **no submission capability** |
| 10 | **human** | Approve extension request | `REMEDIATION_APPROVED` | **+`submit_authorization_extension`** |
| 11 | agent | submit extension | `AUTHORIZATION_ALIGNED` | status/read only |

Step 8 is the Act II thesis: **an external payer response changed what the agent
could do.** The payer approved with validity through Sep 12; the MRI is Sep 18;
`2026-09-18 > 2026-09-12`, so the care stayed administratively blocked and a new
bounded capability became valid. Nothing the browser did caused it.

## The two human gates

Both are enforced twice over, and neither is a disabled button:

1. **The capability is absent.** `getTools()` in the real browser does not
   contain a submission tool at `PREPARED_AWAITING_APPROVAL` or at
   `REMEDIATION_PREPARED`.
2. **The backend refuses independently.** Direct HTTP submit returns
   `APPROVAL_REQUIRED`; direct extension submit returns
   `REMEDIATION_APPROVAL_REQUIRED`. Zero payer calls in both cases.

Approval itself never transmits: after each approval the submission record is
still absent. Both approval routes require workforce headers a browser agent
does not hold (401 `APPROVER_IDENTITY_REQUIRED` without them), and neither is
exposed as a WebMCP tool in any state.

## Act II mechanics

`WellAuthAuthorizationWindowRemediation/1` — bounded, deterministic, and
hashed over semantic fields only (`preparedAt` excluded, so an identical
remediation hashes identically). The artifact carries
`clinicalIntentChanged: false`, `evidenceChanged: false`, `orderChanged: false`
explicitly, so the scope of what a human approves is legible rather than
implied.

The caller supplies **only** a workflow id and an expected revision. The payer,
the authorization reference, the current validity, and the requested validity
are all resolved from durable state and server policy — the model cannot name a
date, an endpoint, or a justification.

Exactly-once reuses the Gate 3 construction: preconditions before the claim,
a transactional `APPROVED → SUBMITTING` CAS, a deterministic hash the payer
collapses duplicates on, and **no retry loop**. A replay is refused with
`REMEDIATION_ALREADY_SUBMITTED` and the receipt does not change.

`AUTHORIZATION_ALIGNED` is reached **only** when the persisted payer validity
actually covers the authoritative scheduled date. It is never asserted from an
HTTP status.

## Two real bugs found and fixed

1. **The coverage gap was invisible over HTTP.** `getWorkflow`'s bounded
   submission projection omitted the payer's validity window, so alignment
   evaluation over the API always concluded "no gap" — the deployed UI would
   never have shown the mismatch that Act II exists to demonstrate. The window
   and payer reference now survive the projection; the rest of the receipt
   deliberately does not. Found because the suite asserted against HTTP rather
   than in-process state only.

2. **The demo was not repeatable.** The payer's duplicate-collapse is permanent
   by design, so re-running the canonical demo replayed the prior decision
   instead of minting a fresh one. Demo reset now also clears the payer's record
   for the workflow's claim identifier.

A third, smaller correction: the snapshot returned the static requirement list
at `CONTEXT_READY`, so the page and the Activity timeline claimed a discovery
that had not happened. Both now key on real workflow state.

## Test results

| Suite | Result |
|---|---|
| Unit (`npm test`) | **69/69** — includes 23 new capability + alignment tests |
| Gate 2 workflow | **147/147** |
| Gate 3 submission (live payer) | **188/188** |
| Gate 4 integrated, in-process | **99/99** |
| Gate 4 integrated, **deployed URL** | **99/99** |
| Browser acceptance (Chromium) | **12/12** |

No prior-gate regressions after the `transmit` generalization, the projection
change, or the seed update.

## Browser evidence

Chromium 1234 (Playwright), viewport 1600×900, against the deployed URL:

- `document.modelContext.registerTool` present; the page registered into it.
- Browser `getTools()` **exactly matched** the server's `availableTools`.
- One agent tool call advanced the backend to `REQUIREMENTS_RESOLVED` **and**
  the page visibly populated 0 → 5 requirement rows.
- The inventory changed 2 → 5 tools **with no reload**.
- After a hard reload the inventory and the page reconstructed identically.
- No uncaught page errors; no horizontal scroll at 1600×900.

Native `executeTool` takes the `RegisteredTool` descriptor and parses arguments
from a **JSON string**, not an object — consistent with the Gate 0 finding that
native behavior differs from the assumed spec. Recorded here so it is not
rediscovered.

**Not yet run:** a live ChatGPT Desktop journey. See Blockers.

## UI implementation audit

Clinical Instrument, as locked. IBM Plex Sans/Mono, cool neutral palette,
hairline borders, 3px radii, flat surfaces, no shadows. Locked IA respected —
worklist omitted (the demo deep-links), one workspace, Activity embedded, no
new surfaces.

- **Context band** — service, synthetic patient, schedule, payer, status.
- **Requirements** — five rows, evidence provenance directly beneath the exact
  requirement (`↳ title · type · version · attached by assistant`).
- **Assistant** — healthcare language ("Attach existing evidence", not
  `attach_evidence`); raw names appear only in the transient unlock cue.
- **Activity** — one honest timeline derived from durable state, not tool logs.
- **Lower region** — one region transforming by authoritative state; no
  future-state component is ever rendered alongside another.

Both approval controls are real `<button>` elements and sit **above the fold**
at 1600×900 (submission bottom 851px, extension 756px). Status is never
color-only — every chip carries a text label. `:focus-visible` outlines and
`prefers-reduced-motion` are honored.

## Refusal case

`P0.23` covers the no-mismatch path deterministically: when the persisted
validity already covers the scheduled service, alignment evaluates `true`, no
gap is detected, and `resolve_authorization_window` **is not offered**. The
same workspace is used; no second page exists.

Gate 2's `MISSING_REQUIRED_EVIDENCE` refusal (prepare blocked below 5/5) is
unchanged and still covered by that suite.

## Source immutability / IAM

- `P0.24`: scheduled service, ordered service, and order status unchanged after
  a full Act II run.
- `provider/remediation.js` imports **no FHIR client** and contains no write
  verb — it cannot mutate clinical truth even by accident.
- Gate 3 `P0.23` (still passing): the provider runtime identity is **denied**
  (403) a clinical FHIR write while reads succeed.
- The MRI reschedule to the canonical `2026-09-18T09:30Z` is clinical truth, so
  it changed in the FHIR **seed** and was applied with the separate
  write-capable fixture identity — never the provider runtime.

## Logging review

`P0.26` scans captured logs: no patient id, no bearer credential, no approval
nonce. Both services log correlation id, route, outcome, and bounded metadata
only. The payer never logs the claim or bundle.

## Reset / reseed

`POST /demo/reset` (env-gated by `WELLAUTH_DEMO_RESET`, **not** a WebMCP tool)
purges the Firestore workflow, recreates it at `CONTEXT_READY`, and clears the
payer's record for the prior claim identifier. Verified repeatable: the full
canonical journey was driven twice, minting a fresh `NS-40192` each time.
`npm run fhir:seed` restores the FHIR fixture with the fixture identity.

## Deviations from the commission

1. **Provider is public.** Approved. Rationale and mitigations above.
2. **Act II implemented.** The commission's default was to stop at the first
   payer result unless a domain review approved the transaction semantics. That
   specification was supplied and is implemented as written — fixture dates,
   state names, artifact fields, tool contracts, UI copy, and claim boundaries.
3. **The Gate 0 `server/` stub remains** as an isolated Gate 0 fixture so that
   suite keeps passing. It is not reachable from the product and is not
   deployed.
4. **`docs/gate3/outgoing-pas-request.json` regenerated** by the Gate 3 suite,
   now reflecting the canonical schedule. Content, not conclusions, changed.

## Blockers

None for the demo itself.

**One acceptance item is genuinely outstanding:** a live ChatGPT Desktop
journey (P0.18/P0.19 in the commission's numbering) has **not** been run — it
requires a human driving the desktop client and cannot be automated here. The
underlying mechanism it would exercise is proven: real tool registration, real
invocation, dynamic inventory changes, and visible page changes are all verified
in a real browser. What remains unverified is whether that specific client
auto-resumes after the human approval or requires a second prompt. **Do not
claim a ChatGPT Desktop result until it is observed.**

## Recommendation

**WellAuth is ready to enter final demo/submission hardening. No further
engineering gate is required.**

The product thesis is demonstrated end-to-end on a live URL: a real browser
agent discovers state-specific capabilities, operates the workspace against real
synthetic FHIR R4 truth and server-authoritative workflow state, visibly
advances the page, stops at the human gate, gains submission only after explicit
approval, sends exactly one request across a real service boundary, and — in Act
II — has its available capabilities changed by an external payer response before
stopping at a second human gate.

Hardening work, in priority order:

1. **Run the ChatGPT Desktop journey** and record the exact environment and
   whether continuation needs a second prompt.
2. Rehearse the reset-to-demo loop on the machine used for filming.
3. Optionally revisit PAS IG validation on an LTS JDK with a clean package
   cache — the one inherited limitation, and a standards-claim matter rather
   than a product one.
