# Gate 0 — WebMCP capability-lifecycle probe

## Verdict

**PASS WITH LIMITATIONS.**

The mechanism works. In real Chrome with native WebMCP, a browser agent
discovers this page's capabilities, invokes them, receives structured results,
and those invocations cause the page itself to visibly advance through
server-authoritative workflow state. Capabilities appear and disappear as state
changes, removal is real, and stale handles cannot be invoked.

The limitations are environmental, not mechanical — see
[Limitations](#limitations). Nothing in the Failure Conditions list was
observed after the defect below was fixed.

## Environment

| | |
| --- | --- |
| Browser | Google Chrome **152.0.7977.64** (macOS, arm64, Darwin 24.3.0) |
| WebMCP | **Native**, not the polyfill. `document.modelContext` is a `ModelContext` instance with `registerTool`, `getTools`, `executeTool`, `ontoolchange`. |
| Launch flags | `--headless=new --enable-features=WebMCP,WebMCPTesting --enable-blink-features=WebMCP --remote-debugging-port=9333` |
| Driver | Chrome DevTools Protocol (`Runtime.evaluate`) — see `docs/browser-smoke.js` |
| App | Vite dev server; authority on `:8787` |
| Node | v25.2.1 |

`document.modelContext` is correctly **absent** on `about:blank`, consistent with
the spec's `[SecureContext]` page-scoped exposure.

The unit suite additionally exercises `@mcp-b/webmcp-polyfill@5.0.1` under jsdom,
so the lifecycle is proven against both a native implementation and the polyfill.

## Capability transitions (observed)

Read back from the browser's own `document.modelContext.getTools()`, not from
application bookkeeping.

| State | Count | Tools |
| --- | --- | --- |
| `CONTEXT_READY` | 2 | `discover_coverage_requirements`, `get_order_context` |
| `REQUIREMENTS_RESOLVED` | 5 | + `bind_evidence`, `find_supporting_evidence`, `inspect_evidence` |
| `PACKET_COMPLETE` | 6 | + `prepare_prior_authorization` |
| `PREPARED_AWAITING_APPROVAL` | 5 | − `prepare_prior_authorization`; **no** `submit_*`, **no** `approve_*` |
| `APPROVED` | 6 | + `submit_prior_authorization` |
| after reset | 2 | back to the `CONTEXT_READY` pair |

## Test evidence

### Deterministic — `npm test` → **46 passed**

```
✓ test/state.test.js  (24 tests)
✓ test/http.test.js   (10 tests)
✓ test/webmcp.test.js (12 tests)
Test Files  3 passed (3)
     Tests  46 passed (46)
```

Covering the seven required proofs:

1. initial state registers exactly 2 — `state.test.js`
2. requirements-resolved registers exactly 5 — `state.test.js`
3. reset returns to exactly 2 — `state.test.js`
4. packet-complete adds `prepare_prior_authorization` — `state.test.js`
5. incomplete state never exposes it (checked at 0/5 and 4/5) — `state.test.js`
6. tools return schema-valid deterministic results — `state.test.js`
7. UI state and WebMCP state cannot drift — `availableTools` is asserted equal to
   `TOOLS_BY_STATE[workflowState]` at every checkpoint of a full workflow run

### Browser smoke — `node docs/browser-smoke.js` → **30/30 passed**

```
PASS  1. agent discovers initial 2 tools
PASS  2. agent invokes get_order_context            -- returned Cardiac MRI order
PASS  3. discover_coverage_requirements executed    -- returned 5 requirements
PASS  0A. page advanced to REQUIREMENTS_RESOLVED without reload
PASS  0A. five requirements visibly populated
PASS  4. agent observes 5 capabilities
PASS  0B. page shows 4 / 5 satisfied
PASS  0C. backend refused mismatched evidence
PASS  0C. page still 4 / 5 after refusal
PASS  0C. prepare_prior_authorization still absent
PASS  0B. page shows 5 / 5 satisfied
PASS  0B. prepare_prior_authorization now registered
PASS  0D. page shows PREPARED_AWAITING_APPROVAL
PASS  0D. disclosure + payer visible
PASS  0D. agent has NO submit capability while awaiting approval
PASS  0D. no approve tool exists for the agent
PASS  0E. human Approve control present and clicked
PASS  0E. page shows APPROVED
PASS  0E. submit_prior_authorization appeared without reload
PASS  Gate 0 submit returns NOT_IMPLEMENTED_GATE_0
PASS  5. reset returns page to CONTEXT_READY
PASS  5. reset removes evidence tools (back to 2)
PASS  6. removed tool cannot subsequently be invoked  -- REJECTED: UnknownError
PASS  reload reconstructs REQUIREMENTS_RESOLVED from server
PASS  reload registers the correct 5 tools for recovered state
```

Notably: **no reload was required** for any capability change, and the page
advanced purely from agent tool calls with no conventional UI interaction — the
sole exception being the human approval click, which is the point of test 0E.

## Defect found and fixed

The probe caught a real bug, which is the main argument for having run it.

**Symptom.** After a page reload the page rendered only an error banner while
`getTools()` reported 5 correctly registered tools — the exact UI/WebMCP
divergence this gate exists to detect.

**Root cause.** `registerTool` is async. The registrar added a name to its live
map *after* awaiting, so React 19 StrictMode's double-invoked effect produced two
concurrent syncs that both saw the name as free; the second threw
`Duplicate tool name`.

**Fix.** Claim the name before awaiting (releasing it if registration fails), and
serialize overlapping syncs through a promise chain. Regression tests in
`test/webmcp.test.js` cover both the race and the underlying browser behaviour.

**Contributing factor worth recording:** the original error handling wrapped the
state fetch and the tool sync in one `try/catch` that reported every failure as
"Cannot reach backend". That misdiagnosis hid the real error for several test
cycles. The paths are now caught separately.

## Deviations from the assumed specification

The commission's assumed API differs materially from the shipped one. Verified
against `webmachinelearning/webmcp` and both implementations:

| Assumed | Actual |
| --- | --- |
| `navigator.modelContext` / `window.agent` | **`document.modelContext`**. `navigator.modelContext` is a deprecated alias; `window.agent` is dead. |
| `unregisterTool(name)` or a handle with `.unregister()` | Neither exists. Removal is **only** via aborting an `AbortSignal` passed to `registerTool`. |
| `outputSchema` on the tool descriptor | Not supported (open issue #9). Output shapes are validated by the application. |
| `execute` returns MCP content blocks | Returns a **plain JSON-serializable value**. Returning `{content:[...]}` would just be stringified as-is. |
| Page notifies `listChanged` | Automatic. The browser fires **`toolchange`**; pages do nothing. |
| `executeTool(handle, inputObject)` | Chrome parses input with `JSON.parse`, so it takes a **JSON string**. Passing an object throws `Failed to parse input arguments`. This diverges from the spec IDL (`optional object inputObject`) and is the one place the implementation contradicts its own specification. |

Two further implementation notes:

- `readOnlyHint` is supported via `annotations`, alongside a WebMCP-specific
  `untrustedContentHint` with no MCP equivalent;
- rejections from `execute` reach the caller without detail, so this
  implementation returns failures as successful values carrying a `reason`
  field rather than throwing.

## Deviations from the commission

- **`discover_coverage_requirements` is not `readOnlyHint: true`.** Test 0A
  requires the page to visibly change when the agent calls it, so it commits a
  state transition and is therefore not read-only. Only genuinely read-only
  tools (`get_order_context`, `find_supporting_evidence`, `inspect_evidence`)
  carry the hint.
- **Backend is `node:http`, not Express.** Six routes did not justify a
  dependency. The client/server boundary is real either way.
- **`submit_prior_authorization` is a stub.** Per instruction it appears on
  approval — proving the capability transition — but returns
  `NOT_IMPLEMENTED_GATE_0`. Tests 0F (submission) and 0G (payer `ClaimResponse`)
  are **out of scope** and were not run; they belong to the payer-boundary smoke
  test.
- **State names follow the revised model** (`CONTEXT_READY` …  `APPROVED`) rather
  than Steps 1–5's `REQUIREMENTS_UNKNOWN`/`REQUIREMENTS_KNOWN`.

## Limitations

1. **ChatGPT in-app browser was not tested.** The ChatGPT desktop app is not
   installed on this machine and its WebMCP support is gated to specific model
   tiers on desktop/Work accounts. This leg of the browser matrix is
   **unverified** and must be run before relying on judge-path behaviour.
2. **The judge-path smoke was not run end-to-end through a real agent.** Tool
   calls were driven programmatically over CDP. That proves the capability
   surface and the page's response to it, but not an LLM's ability to sequence
   the workflow unaided from a single instruction.
3. **Chrome was driven headless.** Behaviour was consistent across reloads, but a
   headed run in front of a human is worth doing before a demo.
4. **The authority is in-memory.** Restarting the server resets the workflow;
   there is no persistence, and it is single-tenant with no concurrency control.
5. The registrar adopts (rather than re-registers) a pre-existing tool name if it
   ever encounters one. Testing showed registrations do **not** survive
   navigation, so this path is defensive and unexercised.

## Recommendation

**Proceed to the FHIR/Google Cloud smoke test**, with one gate first.

The WebMCP interaction model is sound: dynamic registration and removal are real,
server-authoritative state prevents drift, refusals do not produce fake UI
progress, and the human-approval gate genuinely withholds capability from the
agent. That is the thesis this commission set out to prove, and it holds.

Before the FHIR work, run **the ChatGPT in-app browser leg and one headed,
agent-driven judge-path run**. Those are the two unverified assumptions standing
between this result and a demo, and both are cheap. If ChatGPT cannot observe the
capability changes reliably, that is a product blocker that should be found now
rather than after FHIR integration.
