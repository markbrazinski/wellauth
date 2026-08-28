// Deterministic synthetic fixtures. No real PHI. Every value is invented.

export const ORDER_CONTEXT = {
  patientId: 'synthetic-patient-0001',
  orderId: 'synthetic-order-7731',
  orderedService: 'Cardiac MRI',
  serviceCode: '75561',
  status: 'ordered',
  priorAuthorizationRequired: true,
}

export const COVERAGE_REQUIREMENTS = [
  { id: 'req-001', label: 'Documented cardiac symptoms within 90 days', evidenceType: 'clinical-note' },
  { id: 'req-002', label: 'Prior echocardiogram result', evidenceType: 'diagnostic-report' },
  { id: 'req-004', label: 'Ordering physician NPI and attestation', evidenceType: 'practitioner-attestation' },
  { id: 'req-005', label: 'Payer member eligibility active on date of service', evidenceType: 'coverage-record' },
  { id: 'req-003', label: 'Failed or contraindicated conservative therapy', evidenceType: 'medication-history' },
]

export const EVIDENCE_ITEMS = [
  { evidenceId: 'ev-100', requirementId: 'req-001', title: 'Cardiology consult note', recordedDate: '2026-06-14' },
  { evidenceId: 'ev-101', requirementId: 'req-002', title: 'Transthoracic echocardiogram report', recordedDate: '2026-05-30' },
  { evidenceId: 'ev-102', requirementId: 'req-003', title: 'Beta-blocker trial summary', recordedDate: '2026-04-02' },
  { evidenceId: 'ev-103', requirementId: 'req-004', title: 'Attestation of medical necessity', recordedDate: '2026-06-20' },
  { evidenceId: 'ev-104', requirementId: 'req-005', title: 'Eligibility verification record', recordedDate: '2026-06-21' },
]
