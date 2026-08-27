# WellAuth

**A WebMCP-enabled prior-authorization application.**

> The healthcare application exposes exactly the capabilities an agent may use
> at each workflow state, while authoritative clinical truth, workflow policy,
> and human submission authority remain outside the model.

**Live demo:** https://wellauth-provider-qxqdngmwjq-uc.a.run.app

---

## Synthetic data statement

This demonstration uses entirely synthetic health data. Its authorization,
disclosure, audit, and infrastructure boundaries are designed around a credible
HIPAA-regulated deployment model, but **no claim of HIPAA compliance is made.**

**Northstar Health Plan is fictional.** Every payer interaction is with a
clearly labelled **simulated payer** running as a separate service. No real
payer, payer network, clearinghouse, or X12 transaction is involved.

---

## The demo in one paragraph

A cardiac MRI with contrast is already ordered and scheduled for September 18.
Prior authorization is blocking it. A browser agent uses WellAuth's
state-specific WebMCP capabilities to discover the payer's five requirements,
locate existing authoritative evidence in the FHIR record, attach that evidence
to exact requirements, and prepare the exact proposed disclosure — then
**stops**, because it has no capability to submit. A workforce user reviews the
disclosure and clicks **Approve submission**. Only then does
`submit_prior_authorization` appear in the browser's tool inventory. The agent
submits exactly one request to the simulated payer, which **approves** it — but
with a validity window ending September 12, six days before the scheduled MRI.
WellAuth detects that administrative mismatch and unlocks a new capability,
**Resolve authorization window**. The same human gate repeats for the extension,
and the workflow ends at `AUTHORIZATION_ALIGNED` with the MRI covered.

---

## Judge testing instructions

No account. No setup wizard. No terminal steps.

### 1. Open the app

https://wellauth-provider-qxqdngmwjq-uc.a.run.app

You should immediately see the authorization workspace: **Cardiac MRI with
contrast**, scheduled **September 18 at 9:30 AM**, payer **Northstar Health
Plan**, status **Prior authorization required**.

You do **not** need to reset anything, and you cannot be affected by a previous
visitor. Every browser tab gets its own authorization workflow, so the demo
always opens at `CONTEXT_READY`.

### Judge sessions and reloads

| What you do | What happens |
| --- | --- |
| Open the URL | A new session workflow is minted. Always `CONTEXT_READY`. |
| **Reload** mid-run | **Your run is preserved** — same state, same revision, same evidence. |
| Open a second tab | A separate judge session, independent of the first. |
| Someone else opens it | Their run cannot touch yours, and yours cannot touch theirs. |

How it works: the page mints an opaque session workflow id in `sessionStorage`
(per-tab; survives reload, absent in a new tab) and the server binds it to the
one canonical synthetic clinical context. The browser supplies an *identity*
only — it cannot name a state, a patient, or a transition, and the server stays
the sole authority on workflow state. There is no client state machine.

The token-gated `/demo/reset` still exists for the shared canonical workflow
(`wf-wellauth-001`) used by the automated suites. It is not needed for judging,
is **not** a WebMCP tool, and refuses without the operator token.

### 2. Point a browser agent at the page

Use ChatGPT Desktop's browser/site-tools capability, or a Chrome build with
native WebMCP. In native Chrome you can watch the tool inventory directly in
**DevTools → Application → WebMCP**.

### 3. Canonical prompt

> Get this MRI ready for prior authorization using the evidence already
> available. Do not create or infer missing clinical evidence, and do not submit
> anything unless the workflow is complete and a human has approved it. Stop
> when human approval is required.

Expected: the agent inspects the order, discovers requirements, searches and
attaches evidence, reaches 4 of 5, locates the fifth through a different
bounded search path, reaches 5 of 5, prepares the submission — and stops. The
page changes visibly at every step.

### 4. The human step

Click **Approve submission**. Watch `submit_prior_authorization` appear in the
browser's tool inventory without a reload.

If your client needs a new turn to continue:

> Continue now that I have approved the submission.

### 5. Act II

The simulated payer approves, but the authorization ends September 12 and the
MRI is September 18. A new capability, **Resolve authorization window**,
appears. Let the agent prepare the extension, click **Approve extension
request**, and let it submit. The workflow ends with the MRI covered.

### What to try breaking

- Ask the agent to submit before you approve — the tool does not exist, and the
  underlying route refuses with `APPROVAL_REQUIRED`.
- Ask it to change the ordered service or write a missing diagnosis — no such
  capability exists.
- Reload at any point — the page and the tool inventory rebuild from the
  backend.

---

## Architecture

```text
Human ──approval controls──┐
                           ▼
                  WellAuth React UI
                           │  native WebMCP (document.modelContext)
                           ▼
                    Browser agent
                           │  bounded domain operations
                           ▼
              wellauth-provider (Cloud Run)      ← serves the UI, same origin
                 ├── Cloud Healthcare API / FHIR R4   clinical source truth
                 ├── Firestore wellauth-workflow      workflow authority
                 └── authenticated submission (ID token)
                           ▼
          wellauth-payer-simulator (Cloud Run)   ← separate service + identity
                 └── Firestore wellauth-payer         payer truth
```

The UI is served **by the provider itself**, so the page, the agent, and the
workflow API share one origin: no CORS, no cross-origin cookie or WebMCP
complexity, and one URL for a judge. The payer boundary stays real — separate
service, separate service account, separate Firestore database, authenticated
with a Cloud Run ID token.

### Where truth lives

| Concern | Owner |
|---|---|
| Clinical facts | Cloud Healthcare FHIR R4 (provider identity is **read-only**) |
| Workflow state, approvals, hashes | Firestore, transactional |
| What the agent may do now | Provider capability document |
| Payer decisions and validity | The payer simulator's own database |
| Anything at all | **Never** React |

---

## WebMCP implementation

Entry point is `document.modelContext`. Tools are registered imperatively;
removal is via the `AbortSignal` passed at registration — there is no
`unregisterTool`. `execute` returns plain structured JSON.

The frontend never decides which tools exist. It synchronizes registrations
from the server's `availableTools`, so the browser's inventory and the backend's
state cannot drift.

### Capability lifecycle

| State | Browser-visible tools |
|---|---|
| `CONTEXT_READY` | `get_order_context`, `discover_coverage_requirements` |
| `REQUIREMENTS_RESOLVED` | + `find_supporting_evidence`, `inspect_evidence`, `attach_evidence`, `remove_evidence` |
| `PACKET_COMPLETE` | + `prepare_prior_authorization` |
| `PREPARED_AWAITING_APPROVAL` | **no submission capability** |
| `APPROVED` | + `submit_prior_authorization` |
| submitted | − submit, + `check_authorization_status` |
| `PAYER_APPROVED_COVERAGE_GAP` | + `resolve_authorization_window` |
| `REMEDIATION_PREPARED` | **no submission capability** |
| `REMEDIATION_APPROVED` | + `submit_authorization_extension` |
| `AUTHORIZATION_ALIGNED` | status/read only |

**A capability being absent is an affordance and an agent-safety signal, not a
security boundary.** Every route independently re-validates state, revision,
freshness, and authority. Both human approvals are workforce-gated HTTP routes
and are deliberately never WebMCP tools.

---

## Browser requirements

- A browser with WebMCP (`document.modelContext`), or ChatGPT Desktop's
  browser/site-tools capability.
- The page ships the `@mcp-b/webmcp-polyfill`, which defers to a native
  implementation when present.
- Desktop, optimized for **1600 × 900**.

---

## Test evidence

```sh
npm test                                                     # 110/110 unit
npm run test:gate2                                           # 147/147 workflow
PAYER_BASE_URL=<payer> npm run test:gate3                    # 191/191 submission
PAYER_BASE_URL=<payer> npm run test:gate4                    # 99/99   integrated
npm run test:gate5                                           # 41/41   sessions
GATE4_BASE_URL=<provider> PAYER_BASE_URL=<payer> \
  npm run test:gate4                                         # 99/99   deployed
npm run test:browser                                         # 12/12   real browser
node browser-journey.mjs <provider>                          # 90/90   full journey
```

`test:gate5` proves judge-session determinism and read-only non-mutation: a
fresh session starts at `CONTEXT_READY`, sessions are isolated, a reload
preserves state byte-for-byte, and every read-only tool leaves state, revision,
bindings, approvals and payer posture unchanged.

`browser-journey.mjs` drives the **complete Act I + Act II journey** in a real
anonymous browser with no reload, asserting after every capability transition
that the browser's own WebMCP inventory equals `snapshot.availableTools` — plus
both human gates, exactly-once submission, and final cross-surface agreement.

---

## Standards claims

WellAuth **uses FHIR R4 (4.0.1)** resources. Requirement discovery is
**informed by Da Vinci CRD concepts**; documentation assembly is
**DTR-inspired**; the outgoing artifact is a **PAS-shaped** FHIR R4
prior-authorization request that satisfies the cardinality and fixed-value
constraints of the PAS 2.2.1 `profile-claim` and `profile-pas-request-bundle`,
verified against the official package (`docs/GATE-3-PAS-VALIDATION.md`).

WellAuth does **not** claim: PAS/CRD/DTR conformance or certification, full IG
validation, terminology conformance, SMART on FHIR, real payer connectivity,
X12 278, clearinghouse integration, HIPAA compliance, or production readiness.

The Act II authorization-window remediation is the canonical workflow of the
**synthetic** Northstar simulator. It is **not** a claim that real payers expose
a standardized authorization-extension transaction, nor that this exchange is a
standardized Da Vinci PAS extension operation.

---

## Reset

Judges never need this: every tab is already a clean session (see *Judge
sessions and reloads*). It exists for the shared canonical workflow the
automated suites target.

```sh
curl -X POST <provider>/demo/reset -H "X-WellAuth-Demo-Token: $WELLAUTH_DEMO_RESET_TOKEN"
```

Restores the canonical initial state: purges the Firestore workflow, recreates
it at `CONTEXT_READY`, and clears the payer's record for the prior claim
identifier so a fresh decision is minted. It is gated behind
`WELLAUTH_DEMO_RESET`, **fails closed** without `WELLAUTH_DEMO_RESET_TOKEN`
(the provider is publicly invokable so a judge can open it), and is **not** a
WebMCP tool.

To restore the FHIR fixture (write-capable credentials, never the provider
identity):

```sh
npm run fhir:seed
```

---

## Repository

| Path | Purpose |
|---|---|
| `provider/` | Bounded domain API, workflow, submission, remediation, capabilities |
| `payer/` | Simulated payer: `Claim/$submit`, `authorization-extension` |
| `src/` | Authorization workspace + WebMCP registration |
| `docs/` | Gate reports and validation records |

Gate reports: [Gate 0](docs/GATE-0-REPORT.md) ·
[Gate 2](docs/GATE-2-REPORT.md) · [Gate 3](docs/GATE-3-REPORT.md) ·
[Gate 4](docs/GATE-4-REPORT.md)
