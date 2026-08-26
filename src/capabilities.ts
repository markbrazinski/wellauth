// Client-side WebMCP tool definitions.
//
// Every tool is a thin proxy to the authoritative backend. No tool computes
// workflow state locally, and the set of tools registered at any moment comes
// from the server's `availableTools`, never from a client-side guess. That is
// what makes UI state and WebMCP state structurally unable to drift.

export type WorkflowState =
  | 'CONTEXT_READY'
  | 'REQUIREMENTS_RESOLVED'
  | 'PACKET_COMPLETE'
  | 'PREPARED_AWAITING_APPROVAL'
  | 'APPROVED'

export const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? 'http://localhost:8787'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint: boolean
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false }

/**
 * All tools this application can ever expose, keyed by name. Which subset is
 * live at any moment is decided by the server.
 */
export const TOOL_REGISTRY: Record<string, ToolDef> = {
  get_order_context: {
    name: 'get_order_context',
    description:
      'Return the clinical service order under review, including whether prior authorization is required.',
    inputSchema: EMPTY_INPUT,
    readOnlyHint: true,
    execute: () => post('/api/order-context'),
  },

  // Not read-only: this commits REQUIREMENTS_RESOLVED and visibly populates the page.
  discover_coverage_requirements: {
    name: 'discover_coverage_requirements',
    description:
      'Discover the payer coverage requirements for this order and record them against the authorization workflow. Advances the workflow to REQUIREMENTS_RESOLVED.',
    inputSchema: EMPTY_INPUT,
    readOnlyHint: false,
    execute: () => post('/api/discover-requirements'),
  },

  find_supporting_evidence: {
    name: 'find_supporting_evidence',
    description:
      'Locate existing authoritative evidence records that may satisfy the resolved coverage requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        requirementId: { type: 'string', description: 'Optional requirement id, e.g. "req-001".' },
      },
      additionalProperties: false,
    },
    readOnlyHint: true,
    execute: (input) => post('/api/find-evidence', { requirementId: input.requirementId }),
  },

  inspect_evidence: {
    name: 'inspect_evidence',
    description: 'Return the detail of a single evidence record by id.',
    inputSchema: {
      type: 'object',
      properties: { evidenceId: { type: 'string', description: 'Evidence id, e.g. "ev-100".' } },
      required: ['evidenceId'],
      additionalProperties: false,
    },
    readOnlyHint: true,
    execute: (input) => post('/api/inspect-evidence', { evidenceId: input.evidenceId }),
  },

  bind_evidence: {
    name: 'bind_evidence',
    description:
      'Bind an evidence record to a coverage requirement. The server validates the binding and may refuse it.',
    inputSchema: {
      type: 'object',
      properties: {
        requirementId: { type: 'string' },
        evidenceId: { type: 'string' },
      },
      required: ['requirementId', 'evidenceId'],
      additionalProperties: false,
    },
    readOnlyHint: false,
    execute: (input) =>
      post('/api/bind-evidence', {
        requirementId: input.requirementId,
        evidenceId: input.evidenceId,
      }),
  },

  prepare_prior_authorization: {
    name: 'prepare_prior_authorization',
    description:
      'Assemble the minimum-necessary prior authorization packet and present it for human approval. Does not submit.',
    inputSchema: EMPTY_INPUT,
    readOnlyHint: false,
    execute: () => post('/api/prepare'),
  },

  // Registered only in APPROVED. Gate 0 stub: proves the capability transition,
  // does not perform submission.
  submit_prior_authorization: {
    name: 'submit_prior_authorization',
    description:
      'Submit the human-approved prior authorization packet to the payer. Available only after explicit human approval.',
    inputSchema: EMPTY_INPUT,
    readOnlyHint: false,
    execute: () => post('/api/submit'),
  },
}

/**
 * Names the agent must never be able to call. `approve` is a human-only action
 * exposed as a UI control and an HTTP route -- deliberately never a WebMCP tool.
 */
export const HUMAN_ONLY_ACTIONS = ['approve', 'approve_submission', 'approve_prior_authorization']

export interface ServerSnapshot {
  workflowState: WorkflowState
  revision: number
  order: {
    patientId: string
    orderId: string
    orderedService: string
    serviceCode: string
    status: string
    priorAuthorizationRequired: boolean
  }
  requirements: Array<{
    id: string
    label: string
    evidenceType: string
    satisfied: boolean
    boundEvidenceId: string | null
  }>
  requirementsResolved: boolean
  satisfiedCount: number
  requirementCount: number
  preparedPacket: {
    packetHash: string
    preparedAtRevision: number
    destinationPayer: string
    proposedDisclosure: Array<{
      requirementId: string
      requirementLabel: string
      evidenceId: string
      evidenceTitle: string | null
    }>
    complete: boolean
  } | null
  approval: {
    approvedPacketHash: string
    approvedAtRevision: number
    approvedBy: string
  } | null
  availableTools: string[]
}

export async function fetchState(): Promise<ServerSnapshot> {
  const res = await fetch(`${API_BASE}/api/state`)
  return res.json()
}

export async function resetWorkflow(): Promise<ServerSnapshot> {
  return post('/api/reset') as Promise<ServerSnapshot>
}

export async function approvePacket(packetHash: string): Promise<unknown> {
  return post('/api/approve', { packetHash })
}
