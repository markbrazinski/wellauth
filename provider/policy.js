// Server-defined workflow bindings and evidence search policy.
//
// This file is the reason a browser agent can never issue an arbitrary FHIR
// query. Callers supply an opaque workflowId and requirementId; every other
// input to a FHIR search -- patient, resource type, status, date window, code
// filter -- is read from here. There is no code path that turns caller data
// into a search parameter.

/** Workflow -> the clinical context it is permanently bound to. */
/**
 * Per-judge session prefix (P0-1).
 *
 * Every judge/demo session gets its own workflow id so two judges never share
 * workflow state. All of them are bound to the SAME synthetic clinical context
 * -- there is exactly one canonical patient, order and coverage -- so the id
 * partitions WORKFLOW state only. It never selects a patient: the clinical
 * binding below is server policy, and a caller-supplied id can never widen it.
 */
export const SESSION_PREFIX = 'wf-wellauth-s-'

/** ids are opaque and bounded; nothing here reaches a FHIR search parameter. */
const SESSION_ID = new RegExp(`^${SESSION_PREFIX}[A-Za-z0-9_-]{1,32}$`)

export function isSessionWorkflowId(workflowId) {
  return SESSION_ID.test(String(workflowId ?? ''))
}

export const WORKFLOWS = {
  'wf-wellauth-001': {
    workflowId: 'wf-wellauth-001',
    patientId: 'wellauth-patient-001',
    serviceRequestId: 'wellauth-order-001',
    coverageId: 'wellauth-coverage-001',
    // Requirement date windows are measured from the order's authoredOn.
    evidenceWindowStart: '2026-02-10',
    evidenceWindowEnd: '2026-08-26',
  },
}

/**
 * Five synthetic payer requirements.
 *
 * NOT real Northstar criteria and not CRD output -- Northstar is fictional and
 * these are fixture/config data for Gate 1. `search` is the bounded policy the
 * provider executes; `postFilter` narrows further on fields FHIR search cannot
 * express precisely enough for the proof.
 */
export const REQUIREMENTS = [
  {
    id: 'req-001',
    label: 'Documented cardiac symptoms within the relevant window',
    // Discrete structured resource, straightforward search.
    resourceType: 'Condition',
    search: (ctx) => ({
      subject: `Patient/${ctx.patientId}`,
      'clinical-status': 'active',
      'recorded-date': [`ge${ctx.evidenceWindowStart}`, `le${ctx.evidenceWindowEnd}`],
    }),
    // Cardiac symptom codes only -- the ankle sprain shares every other filter.
    allowedCodes: ['29857009', '267036007'],
    rejectVerificationStatus: ['entered-in-error', 'refuted'],
  },
  {
    id: 'req-002',
    label: 'Prior echocardiogram result',
    resourceType: 'DiagnosticReport',
    search: (ctx) => ({
      subject: `Patient/${ctx.patientId}`,
      status: 'final',
      date: [`ge${ctx.evidenceWindowStart}`, `le${ctx.evidenceWindowEnd}`],
    }),
    allowedCodes: ['34552-0'],
  },
  {
    id: 'req-003',
    label: 'Failed or contraindicated conservative therapy',
    // THE FIFTH BEAT. This fact exists only as a narrative DocumentReference,
    // not as a discrete Condition/Observation/DiagnosticReport. Satisfying it
    // requires a different bounded search path than req-001/002/004/005 -- the
    // difference is structural, not an artificial delay.
    resourceType: 'DocumentReference',
    alternatePath: true,
    search: (ctx) => ({
      subject: `Patient/${ctx.patientId}`,
      status: 'current',
      date: [`ge${ctx.evidenceWindowStart}`, `le${ctx.evidenceWindowEnd}`],
    }),
    allowedCodes: ['11488-4'],
    // Both the real note and the orthopedic decoy are LOINC 11488-4 consult
    // notes; only the title distinguishes conservative-therapy documentation.
    titleMatch: /conservative therapy/i,
  },
  {
    id: 'req-004',
    label: 'Ordering physician identity / attestation requirement',
    resourceType: 'PractitionerRole',
    search: (ctx) => ({
      practitioner: `Practitioner/${ctx.practitionerId}`,
      active: 'true',
    }),
    needsPractitioner: true,
  },
  {
    id: 'req-005',
    label: 'Active payer-member eligibility / coverage requirement',
    resourceType: 'Coverage',
    search: (ctx) => ({
      beneficiary: `Patient/${ctx.patientId}`,
      status: 'active',
    }),
  },
]

export const REQUIREMENTS_BY_ID = Object.fromEntries(REQUIREMENTS.map((r) => [r.id, r]))

/**
 * Resolves ANY workflow id to its bound clinical context.
 *
 * A per-session id resolves to the one canonical context. This is deliberately
 * a lookup, not a merge: the returned policy still owns patient, order,
 * coverage, date windows and code filters, so a session id changes WHICH
 * workflow document is written, never WHAT clinical data is reachable.
 */
export function contextFor(workflowId) {
  const exact = WORKFLOWS[workflowId]
  if (exact) return exact
  if (isSessionWorkflowId(workflowId)) {
    return { ...WORKFLOWS[CANONICAL_CONTEXT_ID], workflowId }
  }
  return undefined
}

export const CANONICAL_CONTEXT_ID = 'wf-wellauth-001'
