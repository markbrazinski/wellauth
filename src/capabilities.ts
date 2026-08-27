// Client-side WebMCP tool definitions.
//
// Every tool is a thin proxy to the authoritative provider. No tool computes
// workflow state locally, and the set registered at any moment comes from the
// server's `availableTools`, never from a client-side guess -- which is what
// makes UI state and browser tool inventory structurally unable to drift.
//
// Same-origin by default: the provider serves this page, so there is no CORS,
// no cross-origin cookie question, and one URL for a judge.

export const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? ''

/**
 * JUDGE SESSION IDENTITY (P0-1).
 *
 * Every judge/demo session gets its own workflow id, so one judge can never
 * open WellAuth onto another judge's approved, submitted or aligned workflow.
 *
 *   new tab / new judge  -> no sessionStorage entry -> new id -> CONTEXT_READY
 *   reload during a run  -> sessionStorage survives  -> same id -> state kept
 *   new window / browser -> fresh sessionStorage     -> new id -> CONTEXT_READY
 *
 * sessionStorage is the right store precisely because it is per-tab and
 * survives reload but not a new tab -- which is exactly the distinction the
 * server cannot make from an HTTP request alone.
 *
 * This is NOT a frontend state machine. The browser contributes an OPAQUE
 * IDENTITY and nothing else: it cannot name a state, a patient, a payer or a
 * transition. The server binds that id to the one canonical clinical context
 * (provider/policy.js contextFor) and remains the sole authority on what state
 * the workflow is in. A forged or unknown id is refused, not honoured.
 *
 * VITE_WORKFLOW_ID pins a fixed id for automated suites, which need a stable,
 * resettable target rather than a per-tab one.
 */
const SESSION_KEY = 'wellauth.session.workflow'
const SESSION_PREFIX = 'wf-wellauth-s-'

function newSessionId(): string {
  const rand =
    (crypto as { randomUUID?: () => string }).randomUUID?.().replace(/-/g, '').slice(0, 20) ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `${SESSION_PREFIX}${rand}`
}

function resolveWorkflowId(): string {
  const pinned = (import.meta as { env?: Record<string, string> }).env?.VITE_WORKFLOW_ID
  if (pinned) return pinned
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing && existing.startsWith(SESSION_PREFIX)) return existing
    const fresh = newSessionId()
    sessionStorage.setItem(SESSION_KEY, fresh)
    return fresh
  } catch {
    // Private mode / storage disabled: still isolate this page load rather
    // than silently falling back onto a shared workflow another judge holds.
    return newSessionId()
  }
}

export const WORKFLOW_ID = resolveWorkflowId()

const wf = (path = '') => `${API_BASE}/workflows/${WORKFLOW_ID}${path}`

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint: boolean
  execute: (input: Record<string, unknown>, snap: Snapshot) => Promise<unknown>
}

async function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { code: 'UNREADABLE_RESPONSE', message: 'Provider returned an unreadable response' }
  }
  // A refusal is a legitimate, meaningful result for an agent -- it is
  // returned as structured data rather than thrown, so the model can read the
  // bounded error code and stop rather than retry blindly.
  if (!res.ok) return { ok: false, status: res.status, ...json }
  return json
}

const post = (path: string, body?: unknown, headers?: Record<string, string>) =>
  req(path, { method: 'POST', body: body ?? {}, headers })

/**
 * A no-argument input schema.
 *
 * This is a FUNCTION, not a shared constant. Seven tools take no arguments,
 * and a single shared object literal meant seven live registrations handed the
 * browser the *same* schema object identity. The polyfill serializes each
 * registration independently so it never noticed, but a native WebMCP
 * implementation is free to key, cache or de-duplicate page configuration by
 * schema identity -- and sharing one object across seven tools is exactly the
 * kind of aliasing that makes a page's declared configuration look malformed
 * or oversized. Each tool now owns its own schema object.
 */
const noInput = () => ({ type: 'object', properties: {}, additionalProperties: false })

/**
 * Every tool this application can expose, keyed by name. Which subset is live
 * is decided entirely by the server.
 *
 * Descriptions are written for a real browser agent: each mutating tool states
 * plainly what it changes, what it does NOT change, and that it does not
 * transmit or approve. Nothing is mislabelled read-only to suppress client
 * confirmations -- a mutation that says it is read-only is a lie to the user.
 */
export const TOOL_REGISTRY: Record<string, ToolDef> = {
  get_order_context: {
    name: 'get_order_context',
    description:
      'Return the clinical service order under review — the ordered service, the ' +
      'scheduled date, the payer, and whether prior authorization is required. ' +
      'Read-only: changes nothing.',
    inputSchema: noInput(),
    readOnlyHint: true,
    execute: () => req(wf('/order')),
  },

  discover_coverage_requirements: {
    name: 'discover_coverage_requirements',
    description:
      "Discover the payer's coverage requirements for this order and record them " +
      'against the authorization workflow. This advances workflow state and makes ' +
      'the requirements visible on the page. It does not change the medical record ' +
      'and does not contact the payer.',
    inputSchema: noInput(),
    readOnlyHint: false,
    execute: () => post(wf('/requirements')),
  },

  find_supporting_evidence: {
    name: 'find_supporting_evidence',
    description:
      'Search the authorized clinical record for existing evidence that may satisfy ' +
      'one coverage requirement. Returns candidate references only. Read-only: it ' +
      'creates no clinical data and attaches nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_id: { type: 'string', description: 'Requirement id, e.g. "req-001".' },
      },
      required: ['requirement_id'],
      additionalProperties: false,
    },
    readOnlyHint: true,
    execute: (i) => req(wf(`/requirements/${encodeURIComponent(String(i.requirement_id))}/evidence`)),
  },

  inspect_evidence: {
    name: 'inspect_evidence',
    description:
      'Return the detail of one candidate evidence record by its opaque handle. ' +
      'Read-only: changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        evidence_handle: { type: 'string', description: 'Opaque handle from find_supporting_evidence.' },
      },
      required: ['evidence_handle'],
      additionalProperties: false,
    },
    readOnlyHint: true,
    execute: (i) => req(wf(`/evidence/${encodeURIComponent(String(i.evidence_handle))}`)),
  },

  attach_evidence: {
    name: 'attach_evidence',
    description:
      'Attach a reference to an existing, already-authoritative evidence record so it ' +
      'satisfies one coverage requirement. This is reversible workflow bookkeeping: it ' +
      'records which existing record supports which requirement. It does NOT alter the ' +
      'source medical record, does NOT create clinical information, does NOT transmit ' +
      'anything to the payer, and does NOT approve submission.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_id: { type: 'string' },
        evidence_handle: { type: 'string' },
      },
      required: ['requirement_id', 'evidence_handle'],
      additionalProperties: false,
    },
    readOnlyHint: false,
    execute: (i, s) =>
      post(wf('/evidence/attach'), {
        requirement_id: i.requirement_id,
        evidence_handle: i.evidence_handle,
        expected_revision: s.revision,
      }),
  },

  remove_evidence: {
    name: 'remove_evidence',
    description:
      'Detach the evidence reference currently satisfying one requirement. Reversible ' +
      'workflow bookkeeping; the source medical record is untouched and nothing is sent ' +
      'to the payer.',
    inputSchema: {
      type: 'object',
      properties: { requirement_id: { type: 'string' } },
      required: ['requirement_id'],
      additionalProperties: false,
    },
    readOnlyHint: false,
    execute: (i, s) =>
      post(wf('/evidence/remove'), {
        requirement_id: i.requirement_id,
        expected_revision: s.revision,
      }),
  },

  prepare_prior_authorization: {
    name: 'prepare_prior_authorization',
    description:
      'Assemble the minimum-necessary prior authorization packet from the attached ' +
      'evidence and freeze it for human review. Available only when every requirement ' +
      'is satisfied. This does NOT submit: a workforce user must review and approve the ' +
      'exact prepared disclosure before any submission capability exists.',
    inputSchema: noInput(),
    readOnlyHint: false,
    execute: (_i, s) => post(wf('/prepare'), { expected_revision: s.revision }),
  },

  submit_prior_authorization: {
    name: 'submit_prior_authorization',
    description:
      'Transmit the human-approved prior authorization request to the payer. This ' +
      'capability exists only after a workforce user has explicitly approved the exact ' +
      'prepared disclosure. Sends exactly one request to a clearly labelled SIMULATED ' +
      'payer.',
    inputSchema: noInput(),
    readOnlyHint: false,
    execute: (_i, s) => post(wf('/submit'), { expected_revision: s.revision }),
  },

  check_authorization_status: {
    name: 'check_authorization_status',
    description:
      'Return the current authorization status for this workflow, including the ' +
      "simulated payer's decision and whether the authorization covers the scheduled " +
      'service date. Read-only.',
    inputSchema: noInput(),
    readOnlyHint: true,
    execute: () => req(wf('/authorization-status')),
  },

  // --- Act II -------------------------------------------------------------
  resolve_authorization_window: {
    name: 'resolve_authorization_window',
    description:
      'Prepare a bounded administrative request to align the existing authorization ' +
      'validity window with the already-scheduled service date. Available only because ' +
      'the payer approved an authorization that ends before the scheduled service. ' +
      'This changes NO clinical data — not the ordered service, the diagnosis, the ' +
      'evidence, or the medical intent — and only the administrative validity window is ' +
      'at issue. It does NOT transmit and does NOT approve itself: a workforce user must ' +
      'approve the exact request first.',
    inputSchema: noInput(),
    readOnlyHint: false,
    execute: (_i, s) => post(wf('/remediation/resolve'), { expected_revision: s.revision }),
  },

  submit_authorization_extension: {
    name: 'submit_authorization_extension',
    description:
      'Transmit the workforce-approved authorization-window extension to the payer. ' +
      'Available only after explicit human approval of the exact request. Sends exactly ' +
      'one request to the clearly labelled SIMULATED payer and changes no clinical data.',
    inputSchema: noInput(),
    readOnlyHint: false,
    execute: (_i, s) => post(wf('/remediation/submit'), { expected_revision: s.revision }),
  },
}

/**
 * Names the agent must never be able to call. Both approvals are workforce
 * actions exposed as UI controls and workforce-gated HTTP routes -- they are
 * deliberately never WebMCP tools.
 */
export const HUMAN_ONLY_ACTIONS = [
  'approve',
  'approve_submission',
  'approve_prior_authorization',
  'approve_remediation',
  'approve_extension_request',
]

// --- server-authoritative snapshot -----------------------------------------

export interface Requirement {
  id: string
  label: string
  expectedResourceType: string
  alternatePath: boolean
}

export interface Binding {
  requirementId: string
  resourceType: string
  // Stripped from the /snapshot projection by the HTTP layer's stripHandleIds,
  // so it is genuinely absent on the read the workspace performs.
  resourceId?: string
  sourceVersionId: string
  bindingRule: string
  // C-2: presentation metadata carried from the exact attached source version.
  // Nullable -- a resource may legitimately have no title or clinical date, and
  // the UI must show that honestly rather than invent one.
  title: string | null
  effectiveDate: string | null
  // P1-3: what `effectiveDate` actually is. 'clinical' is a real clinical
  // event date; 'coverage-period' is an administrative window start and must
  // be labelled as such rather than shown as a bare date.
  dateKind: 'clinical' | 'coverage-period' | 'authored' | null
  boundAt: string
}

export interface Snapshot {
  workflowId: string
  state: string
  revision: number
  payer: string
  completeness: { satisfied: number; required: number; complete: boolean; missing?: string[] }
  order: {
    service?: { display: string; code: string }
    status?: string
    scheduled?: string | null
    coverage?: { payer: string; status: string }
  } | null
  // C-1: bounded patient identity. Null when FHIR could not be reached -- the
  // context band then shows the identity as unavailable, never a placeholder name.
  patient: { display: string | null; syntheticLabel: string } | null
  scheduledServiceDate: string | null
  scheduledServiceDisplay: string
  requirements: Requirement[]
  bindings: Binding[]
  packetHash: string | null
  approval: {
    approvedBy: string
    role: string
    at: string
    packetHash: string
    manifestRevision: number
    workflowRevision: number
    outcome: string
  } | null
  submission: {
    state: string
    payerStatus: string | null
    claimIdentifier: string
    destination: string
    attempts: number
    // The validity window the payer granted, and its reference. Act II's gap
    // is derived from authorizationPeriod.end vs the scheduled service date.
    authorizationPeriod: { start: string; end: string } | null
    payerReference: string | null
    // P2-2: durable event times from the submission record.
    startedAt?: string | null
    completedAt?: string | null
    receivedAt?: string | null
    simulated: boolean
  } | null
  act2: {
    phase: string | null
    alignment: { aligned: boolean | null; scheduledServiceDate: string; validThrough: string } | null
  }
  remediation: {
    state: string
    payerAuthorizationReference: string
    currentValidThrough: string
    scheduledServiceDate: string
    requestedValidThrough: string
    reasonDisplay: string
    hash: string
    approval: { approvedBy: string; role: string; at: string } | null
    submission: {
      extensionReceiptId: string | null
      outcome: string | null
      startedAt?: string | null
      completedAt?: string | null
    } | null
    preparedAt?: string | null
  } | null
  availableTools: string[]
}

export async function fetchSnapshot(): Promise<Snapshot> {
  return req(wf('/snapshot')) as unknown as Promise<Snapshot>
}

/** Creates the canonical workflow if it does not exist yet. */
export async function ensureWorkflow(): Promise<void> {
  await post(wf(''))
}

export interface Disclosure {
  destination: string
  purpose: string
  items: Array<{
    requirementId: string
    resourceType: string
    sourceVersionId: string
    inclusionReason: string
  }>
  exclusionPolicy: { version: string; excludes: string[] }
  packetHash: string
  preparedAt: string
}

export async function fetchDisclosure(): Promise<Disclosure | null> {
  const d = (await req(wf('/disclosure'))) as Record<string, unknown>
  return d.code ? null : (d as unknown as Disclosure)
}

/**
 * The workforce approval. Carries workforce identity headers a browser agent
 * does not hold, and is never exposed as a WebMCP tool.
 */
const WORKFORCE = { 'X-WellAuth-User': 'A. Reyes', 'X-WellAuth-Role': 'prior-auth-coordinator' }

const nonce = () =>
  (crypto as { randomUUID?: () => string }).randomUUID?.() ?? String(Date.now())

export function approveSubmission(revision: number, packetHash: string) {
  return post(
    wf('/approval'),
    { expected_revision: revision, nonce: nonce(), acknowledged_packet_hash: packetHash },
    WORKFORCE,
  )
}

export function approveRemediation(revision: number, hash: string) {
  return post(
    wf('/remediation/approval'),
    { expected_revision: revision, nonce: nonce(), acknowledged_hash: hash },
    WORKFORCE,
  )
}
