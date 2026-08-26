// Server-defined workflow bindings and evidence search policy.
//
// This file is the reason a browser agent can never issue an arbitrary FHIR
// query. Callers supply an opaque workflowId and requirementId; every other
// input to a FHIR search -- patient, resource type, status, date window, code
// filter -- is read from here. There is no code path that turns caller data
// into a search parameter.

/** Workflow -> the clinical context it is permanently bound to. */
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
