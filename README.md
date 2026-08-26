# WellAuth — WebMCP capability-lifecycle probe (Gate 0)

A minimal probe proving one thing: **a browser agent can discover and invoke a
web page's WebMCP capabilities, and the page can reliably add and remove those
capabilities as server-authoritative workflow state changes.**

This is not the product. There is no FHIR, no cloud healthcare API, no real
payer, no LLM, no database, and no authentication. All data is deterministic
synthetic fixtures. No PHI.

## What it demonstrates

A prior-authorization workflow where the agent's available tools change as the
workflow advances, and where **the page itself visibly advances** as a result of
agent tool calls — not just the chat transcript.

| Workflow state | Registered capabilities |
| --- | --- |
| `CONTEXT_READY` | 2 — `get_order_context`, `discover_coverage_requirements` |
| `REQUIREMENTS_RESOLVED` | 5 — adds `find_supporting_evidence`, `inspect_evidence`, `bind_evidence` |
| `PACKET_COMPLETE` | 6 — adds `prepare_prior_authorization` |
| `PREPARED_AWAITING_APPROVAL` | 5 — **no** agent capability advances the workflow |
| `APPROVED` | 6 — adds `submit_prior_authorization` |

Two properties are the point:

1. **`PREPARED_AWAITING_APPROVAL` has no forward capability.** A prepared packet
   can only be advanced by a human clicking *Approve submission*. No WebMCP tool
   in any state can perform the approval.
2. **Capability changes are real.** Removal aborts the registration, so removed
   tools disappear from `document.modelContext.getTools()` and stale handles
   throw on invocation. Nothing here is a UI label.

## Architecture

The browser holds **no** workflow state. A separate Node process is the
authority; the page renders whatever `GET /api/state` returns and registers
exactly the tools that response lists.

```
browser ──WebMCP tool call──▶ tool proxies to HTTP ──▶ node server (authority)
   ▲                                                          │
   └───────── re-reads /api/state, re-syncs registrations ◀────┘
```

Because the registered set and the displayed set both derive from the same
server field, UI state and WebMCP state cannot drift. A reload reconstructs
everything from the server.

The server refuses invalid operations (mismatched evidence, stale packet hash,
incomplete packet) without advancing its revision counter, so the page cannot
show progress that did not happen.

## Running it

```bash
npm install
npm run server   # authority on :8787
npm run dev      # page on :5173
```

Open the page in a browser with WebMCP support (see below).

## Tests

```bash
npm test         # 46 deterministic tests
```

- `test/state.test.js` — state machine, capability inventories, refusal paths
- `test/http.test.js` — end-to-end over real HTTP, including reload recovery
- `test/webmcp.test.js` — registration lifecycle against the real
  `@mcp-b/webmcp-polyfill`, asserting on the browser's own `getTools()`

A browser smoke test driving real Chrome over CDP is described in
[`docs/GATE-0-REPORT.md`](docs/GATE-0-REPORT.md).

## WebMCP notes

Verified against the spec and a real implementation, August 2026:

- the entry point is `document.modelContext` — **not** `navigator.modelContext`
  (deprecated alias) and not `window.agent` (dead);
- there is no `unregisterTool()`, `provideContext()`, or `clearContext()`.
  Removal is **only** via aborting an `AbortSignal` passed at register time;
- there is no `outputSchema`; result shapes are validated by the application;
- `execute` returns a plain JSON-serializable value, not MCP content blocks;
- `executeTool(handle, input)` takes the input as a **JSON string**, not an object;
- the browser fires `toolchange` automatically — pages do not notify.

## License

Apache-2.0. See [LICENSE](LICENSE).
