// Authoritative workflow state machine for WellAuth Gate 0.
//
// This module is the single source of truth. The browser holds no workflow
// state of its own: it renders what /api/state returns. WebMCP tools mutate
// state only by calling this server, so the agent, the page, and the backend
// cannot disagree.
//
// In-memory only -- no database. Restarting the server resets the workflow.

import { createHash } from 'node:crypto'
import { COVERAGE_REQUIREMENTS, EVIDENCE_ITEMS, ORDER_CONTEXT } from './fixtures.js'

export const STATES = [
  'CONTEXT_READY',
  'REQUIREMENTS_RESOLVED',
  'PACKET_COMPLETE',
  'PREPARED_AWAITING_APPROVAL',
  'APPROVED',
]

/**
 * Capability inventory per state. This is the authoritative mapping; the client
 * registers exactly what /api/state reports, and never computes its own list.
 *
 * Note PREPARED_AWAITING_APPROVAL deliberately drops prepare_prior_authorization
 * and does NOT add submit_prior_authorization: while a packet awaits a human,
 * the agent has no capability that advances it. That gap is the point of the gate.
 */
export const TOOLS_BY_STATE = {
  CONTEXT_READY: ['get_order_context', 'discover_coverage_requirements'],
  REQUIREMENTS_RESOLVED: [
    'get_order_context',
    'discover_coverage_requirements',
    'find_supporting_evidence',
    'inspect_evidence',
    'bind_evidence',
  ],
  PACKET_COMPLETE: [
    'get_order_context',
    'discover_coverage_requirements',
    'find_supporting_evidence',
    'inspect_evidence',
    'bind_evidence',
    'prepare_prior_authorization',
  ],
  PREPARED_AWAITING_APPROVAL: [
    'get_order_context',
    'discover_coverage_requirements',
    'find_supporting_evidence',
    'inspect_evidence',
    'bind_evidence',
  ],
  APPROVED: [
    'get_order_context',
    'discover_coverage_requirements',
    'find_supporting_evidence',
    'inspect_evidence',
    'bind_evidence',
    'submit_prior_authorization',
  ],
}

function initial() {
  return {
    workflowState: 'CONTEXT_READY',
    revision: 1,
    requirementsResolved: false,
    bindings: {}, // requirementId -> evidenceId
    preparedPacket: null,
    approval: null,
  }
}

let current = initial()

/** Stable hash of the packet contents, used to pin approval to a revision. */
function packetHash(bindings, revision) {
  const canonical = JSON.stringify({
    orderId: ORDER_CONTEXT.orderId,
    bindings: Object.keys(bindings)
      .sort()
      .map((k) => [k, bindings[k]]),
    revision,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** Derived state advances only from committed facts, never from a caller's claim. */
function recompute() {
  const satisfied = Object.keys(current.bindings).length
  const total = COVERAGE_REQUIREMENTS.length

  // Approval and preparation are sticky: they are not recomputed away here.
  if (current.approval) return 'APPROVED'
  if (current.preparedPacket) return 'PREPARED_AWAITING_APPROVAL'
  if (!current.requirementsResolved) return 'CONTEXT_READY'
  return satisfied === total ? 'PACKET_COMPLETE' : 'REQUIREMENTS_RESOLVED'
}

function commit() {
  const next = recompute()
  if (next !== current.workflowState) {
    current.workflowState = next
  }
  current.revision += 1
  return snapshot()
}

export function snapshot() {
  const satisfiedCount = Object.keys(current.bindings).length
  return {
    workflowState: current.workflowState,
    revision: current.revision,
    order: { ...ORDER_CONTEXT },
    requirements: current.requirementsResolved
      ? COVERAGE_REQUIREMENTS.map((r) => ({
          ...r,
          satisfied: Boolean(current.bindings[r.id]),
          boundEvidenceId: current.bindings[r.id] ?? null,
        }))
      : [],
    requirementsResolved: current.requirementsResolved,
    satisfiedCount,
    requirementCount: COVERAGE_REQUIREMENTS.length,
    preparedPacket: current.preparedPacket,
    approval: current.approval,
    availableTools: TOOLS_BY_STATE[current.workflowState],
  }
}

export function reset() {
  current = initial()
  return snapshot()
}

export function getOrderContext() {
  return { ...ORDER_CONTEXT }
}

/**
 * Test 0A: discovery is a state-advancing operation, not a read. It commits
 * REQUIREMENTS_RESOLVED so the page visibly populates when the agent calls it.
 */
export function discoverRequirements() {
  if (!current.requirementsResolved) {
    current.requirementsResolved = true
    commit()
  }
  return {
    requirements: COVERAGE_REQUIREMENTS.map((r) => ({ ...r })),
    workflowState: current.workflowState,
    revision: current.revision,
  }
}

export function findEvidence(requirementId) {
  const items = EVIDENCE_ITEMS.filter(
    (e) => !requirementId || e.requirementId === requirementId,
  ).map((e) => ({ ...e }))
  return { evidence: items, revision: current.revision }
}

export function inspectEvidence(evidenceId) {
  const match = EVIDENCE_ITEMS.find((e) => e.evidenceId === evidenceId)
  if (!match) {
    return { found: false, reason: 'UNKNOWN_EVIDENCE_ID', revision: current.revision }
  }
  return { found: true, evidence: { ...match }, revision: current.revision }
}

/**
 * Test 0B / 0C: the server validates and either commits or refuses. A refusal
 * leaves revision and workflowState untouched so the page cannot show progress
 * that did not happen.
 */
export function bindEvidence(requirementId, evidenceId) {
  if (!current.requirementsResolved) {
    return { ok: false, reason: 'REQUIREMENTS_NOT_RESOLVED', ...snapshot() }
  }
  const requirement = COVERAGE_REQUIREMENTS.find((r) => r.id === requirementId)
  if (!requirement) {
    return { ok: false, reason: 'UNKNOWN_REQUIREMENT_ID', ...snapshot() }
  }
  const evidence = EVIDENCE_ITEMS.find((e) => e.evidenceId === evidenceId)
  if (!evidence) {
    return { ok: false, reason: 'UNKNOWN_EVIDENCE_ID', ...snapshot() }
  }
  // Evidence must actually support the requirement it is being bound to.
  if (evidence.requirementId !== requirementId) {
    return { ok: false, reason: 'EVIDENCE_DOES_NOT_SATISFY_REQUIREMENT', ...snapshot() }
  }
  if (current.preparedPacket || current.approval) {
    return { ok: false, reason: 'PACKET_LOCKED', ...snapshot() }
  }

  current.bindings[requirementId] = evidenceId
  commit()
  return { ok: true, ...snapshot() }
}

export function preparePriorAuthorization() {
  if (Object.keys(current.bindings).length !== COVERAGE_REQUIREMENTS.length) {
    return { ok: false, reason: 'PACKET_INCOMPLETE', ...snapshot() }
  }
  if (current.approval) {
    return { ok: false, reason: 'ALREADY_APPROVED', ...snapshot() }
  }

  const revisionAtPrepare = current.revision + 1
  current.preparedPacket = {
    packetHash: packetHash(current.bindings, revisionAtPrepare),
    preparedAtRevision: revisionAtPrepare,
    destinationPayer: 'Synthetic Payer of Record (SPR-TEST)',
    proposedDisclosure: COVERAGE_REQUIREMENTS.map((r) => {
      const evidenceId = current.bindings[r.id]
      const evidence = EVIDENCE_ITEMS.find((e) => e.evidenceId === evidenceId)
      return {
        requirementId: r.id,
        requirementLabel: r.label,
        evidenceId,
        evidenceTitle: evidence ? evidence.title : null,
      }
    }),
    complete: true,
  }
  commit()
  return { ok: true, ...snapshot() }
}

/**
 * Test 0E: only a human can call this. It is exposed as an HTTP route the UI
 * button hits, and is deliberately NOT registered as a WebMCP tool in any state.
 */
export function approve(packetHashFromClient) {
  if (!current.preparedPacket) {
    return { ok: false, reason: 'NOTHING_PREPARED', ...snapshot() }
  }
  if (current.approval) {
    return { ok: false, reason: 'ALREADY_APPROVED', ...snapshot() }
  }
  // Approval is pinned to the exact packet revision the human saw.
  if (packetHashFromClient !== current.preparedPacket.packetHash) {
    return { ok: false, reason: 'STALE_PACKET_HASH', ...snapshot() }
  }

  current.approval = {
    approvedPacketHash: current.preparedPacket.packetHash,
    approvedAtRevision: current.revision + 1,
    approvedBy: 'human-operator (local test)',
  }
  commit()
  return { ok: true, ...snapshot() }
}

/**
 * Gate 0 stub. The capability must APPEAR on approval -- that transition is what
 * this gate proves -- but real submission belongs to the payer-boundary smoke
 * test and is not implemented here.
 */
export function submitPriorAuthorization() {
  if (!current.approval) {
    return { ok: false, reason: 'NOT_APPROVED', ...snapshot() }
  }
  return {
    ok: false,
    reason: 'NOT_IMPLEMENTED_GATE_0',
    detail:
      'Submission is out of scope for Gate 0. This capability exists to prove that human approval changes the agent capability inventory.',
    ...snapshot(),
  }
}
