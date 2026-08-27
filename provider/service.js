// Bounded domain operations. Everything the provider API can do lives here.
//
// Invariants:
//  - every FHIR call is issued with server-owned parameters (see policy.js);
//  - callers are identified only by opaque workflow/requirement/evidence ids;
//  - results are projections, never raw FHIR resources or whole bundles;
//  - reads only -- this module never issues a FHIR write.

import { createHash } from 'node:crypto'
import * as fhir from './fhir.js'
import { FhirError } from './fhir.js'
import { REQUIREMENTS, REQUIREMENTS_BY_ID, contextFor } from './policy.js'

/** Bounded, machine-readable failure. Never carries FHIR payloads or stacks. */
export class DomainError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

function workflow(workflowId) {
  const wf = contextFor(workflowId)
  if (!wf) throw new DomainError('WORKFLOW_NOT_FOUND', 'Unknown workflow')
  return wf
}

/**
 * Evidence handles are opaque and derived from (workflow, type, id). A handle
 * from one workflow cannot address a resource in another, and a handle cannot
 * be reversed into a FHIR id by the caller.
 */
function handleFor(workflowId, resourceType, id) {
  return (
    'ev_' +
    createHash('sha256').update(`${workflowId}|${resourceType}|${id}`).digest('hex').slice(0, 20)
  )
}

function codesOf(resource) {
  const codings = [
    ...(resource.code?.coding ?? []),
    ...(resource.type?.coding ?? []),
  ]
  return codings.map((c) => c.code).filter(Boolean)
}

export function titleOf(resource) {
  return (
    resource.code?.text ??
    resource.type?.text ??
    resource.content?.[0]?.attachment?.title ??
    resource.code?.coding?.[0]?.display ??
    resource.type?.coding?.[0]?.display ??
    // PractitionerRole carries its label on code/specialty rather than a title.
    resource.code?.[0]?.coding?.[0]?.display ??
    resource.specialty?.[0]?.coding?.[0]?.display ??
    null
  )
}

export function effectiveOf(resource) {
  return (
    resource.effectiveDateTime ??
    resource.recordedDate ??
    resource.date ??
    resource.period?.start ??
    resource.authoredOn ??
    null
  )
}

/**
 * What KIND of date effectiveOf returned (P1-3).
 *
 * Not every evidence resource carries a clinical date. A Coverage's
 * `period.start` is the start of an administrative benefit window, and a
 * PractitionerRole's is the start of a credentialing period -- neither is
 * "when this clinical event happened". Rendering them bare produced the
 * audit's ambiguous "Jan 1": a 2020 credentialing date shown exactly like a
 * clinical study date.
 *
 * The honest fix is to label the date rather than hide or fabricate one, so
 * the UI can say "effective from" instead of implying a clinical event date.
 * Returns null when there is no date at all.
 */
export function dateKindOf(resource) {
  if (resource.effectiveDateTime ?? resource.recordedDate ?? resource.date) return 'clinical'
  if (resource.period?.start) return 'coverage-period'
  if (resource.authoredOn) return 'authored'
  return null
}

function subjectRefOf(resource) {
  return (
    resource.subject?.reference ??
    resource.beneficiary?.reference ??
    resource.patient?.reference ??
    null
  )
}

/** P0.1 -- connection proof. No credentials, no tokens, no clinical content. */
export async function health() {
  try {
    const meta = await fhir.metadata()
    return {
      status: 'ok',
      project: fhir.CONFIG.projectId,
      location: fhir.CONFIG.location,
      dataset: fhir.CONFIG.dataset,
      fhirStore: fhir.CONFIG.fhirStore,
      fhirVersion: meta.fhirVersion ?? '4.0.1',
      declaredVersion: fhir.CONFIG.fhirVersion,
      storeReachable: true,
    }
  } catch (err) {
    throw new DomainError(
      err.code === 'FHIR_UNAVAILABLE' ? 'FHIR_UNAVAILABLE' : 'FHIR_RESPONSE_INVALID',
      'FHIR store not reachable',
      { retryable: true },
    )
  }
}

/** P0.2 + P0.3 -- bounded order summary with coverage and exact versions. */
export async function getOrder(workflowId) {
  const wf = workflow(workflowId)

  let order
  try {
    order = await fhir.read('ServiceRequest', wf.serviceRequestId)
  } catch (err) {
    if (err instanceof FhirError && err.code === 'FHIR_NOT_FOUND') {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not available for this workflow')
    }
    throw new DomainError('FHIR_UNAVAILABLE', 'FHIR store unavailable', { retryable: true })
  }

  const sr = order.resource
  // The order must belong to the workflow's bound patient. A fixture drift here
  // is a context violation, not a lookup miss.
  if (subjectRefOf(sr) !== `Patient/${wf.patientId}`) {
    throw new DomainError('CONTEXT_MISMATCH', 'Order is not bound to this workflow context')
  }

  // Coverage: exactly one active coverage must resolve.
  const coverages = await fhir.search('Coverage', {
    beneficiary: `Patient/${wf.patientId}`,
    status: 'active',
  })
  if (coverages.length === 0) {
    throw new DomainError('COVERAGE_NOT_FOUND', 'No active coverage for this workflow')
  }
  const bound = coverages.filter((c) => c.id === wf.coverageId)
  if (bound.length !== 1) {
    throw new DomainError('AMBIGUOUS_COVERAGE', 'Active coverage could not be resolved uniquely')
  }
  const coverage = bound[0]

  return {
    workflowId: wf.workflowId,
    orderHandle: handleFor(wf.workflowId, 'ServiceRequest', sr.id),
    service: {
      display: sr.code?.text ?? sr.code?.coding?.[0]?.display ?? null,
      code: sr.code?.coding?.[0]?.code ?? null,
      system: sr.code?.coding?.[0]?.system ?? null,
    },
    status: sr.status,
    intent: sr.intent,
    authoredOn: sr.authoredOn ?? null,
    scheduled: sr.occurrenceDateTime ?? null,
    coverage: {
      payer: 'Northstar Health Plan',
      status: coverage.status,
      periodStart: coverage.period?.start ?? null,
      periodEnd: coverage.period?.end ?? null,
      sourceVersionId: coverage.meta?.versionId ?? null,
    },
    sourceVersionId: sr.meta?.versionId ?? null,
    sourceLastUpdated: sr.meta?.lastUpdated ?? null,
    etag: order.etag ?? null,
  }
}

/**
 * C-1 -- bounded patient identity for the workspace context band.
 *
 * Deliberately minimal: a display name and a synthetic-data label, nothing
 * more. No DOB, MRN, gender or address -- the context band needs none of them,
 * and minimum-necessary applies to the UI just as it does to the payer packet.
 * Without this the page can only fabricate a patient name, which it previously
 * did.
 */
export async function getPatient(workflowId) {
  const wf = workflow(workflowId)
  const { resource } = await fhir.read('Patient', wf.patientId)
  const name = resource.name?.[0]
  const display =
    name?.text || [name?.given?.join(' '), name?.family].filter(Boolean).join(' ')
  return {
    display: display || null,
    // All hackathon clinical data is synthetic; the band says so out loud.
    syntheticLabel: 'Synthetic record',
  }
}

/** Deterministic fixture requirement set. Not CRD output. */
export function getRequirements(workflowId) {
  workflow(workflowId)
  return {
    workflowId,
    source: 'fixture (CRD-informed shape, not CRD conformant)',
    requirements: REQUIREMENTS.map((r) => ({
      id: r.id,
      label: r.label,
      expectedResourceType: r.resourceType,
      alternatePath: Boolean(r.alternatePath),
    })),
  }
}

/**
 * P0.4/P0.5/P0.7/P0.8 -- run the server-defined search for one requirement.
 *
 * The caller contributes nothing to the query. Every parameter comes from the
 * workflow context and the requirement's policy entry.
 */
export async function findEvidence(workflowId, requirementId) {
  const wf = workflow(workflowId)
  const req = REQUIREMENTS_BY_ID[requirementId]
  if (!req) throw new DomainError('REQUIREMENT_NOT_FOUND', 'Unknown requirement')

  const ctx = { ...wf }

  // req-004 needs the ordering practitioner, which is itself resolved from the
  // workflow-bound order rather than supplied by the caller.
  if (req.needsPractitioner) {
    const order = await fhir.read('ServiceRequest', wf.serviceRequestId)
    const ref = order.resource.requester?.reference ?? ''
    ctx.practitionerId = ref.split('/')[1] ?? null
    if (!ctx.practitionerId) {
      throw new DomainError('NO_ELIGIBLE_EVIDENCE', 'No ordering practitioner on the order')
    }
  }

  let found
  try {
    found = await fhir.search(req.resourceType, req.search(ctx))
  } catch (err) {
    throw new DomainError('FHIR_UNAVAILABLE', 'FHIR store unavailable', { retryable: true })
  }

  const candidates = found.filter((r) => {
    // Cross-patient guard: defence in depth behind the search parameter itself.
    const subject = subjectRefOf(r)
    if (subject && subject !== `Patient/${wf.patientId}`) return false

    if (req.allowedCodes && !codesOf(r).some((c) => req.allowedCodes.includes(c))) return false

    if (req.rejectVerificationStatus) {
      const vs = r.verificationStatus?.coding?.map((c) => c.code) ?? []
      if (vs.some((c) => req.rejectVerificationStatus.includes(c))) return false
    }

    if (req.titleMatch && !req.titleMatch.test(titleOf(r) ?? '')) return false

    // DocumentReference carries a second status axis; drafts are not evidence.
    if (r.resourceType === 'DocumentReference' && r.docStatus && r.docStatus !== 'final') {
      return false
    }
    return true
  })

  if (candidates.length === 0) {
    return {
      workflowId,
      requirementId,
      status: 'NO_ELIGIBLE_EVIDENCE',
      alternatePath: Boolean(req.alternatePath),
      candidates: [],
    }
  }

  return {
    workflowId,
    requirementId,
    status: 'OK',
    alternatePath: Boolean(req.alternatePath),
    candidates: candidates.map((r) => ({
      evidenceHandle: handleFor(workflowId, r.resourceType, r.id),
      // Internal only: stripped by the HTTP layer's projection. Gate 2 uses it
      // to register handle -> exact resource id once, so later operations can
      // do direct version-aware reads instead of replaying these searches.
      resourceId: r.id,
      resourceType: r.resourceType,
      title: titleOf(r),
      code: codesOf(r)[0] ?? null,
      effectiveDate: effectiveOf(r),
      status: r.status ?? r.clinicalStatus?.coding?.[0]?.code ?? null,
      source: `${fhir.CONFIG.dataset}/${fhir.CONFIG.fhirStore}`,
      sourceVersionId: r.meta?.versionId ?? null,
      sourceLastUpdated: r.meta?.lastUpdated ?? null,
      matchedBy: {
        requirementId,
        resourceType: req.resourceType,
        policy: req.alternatePath ? 'alternate-document-path' : 'structured-resource-path',
      },
    })),
  }
}

/**
 * P0.9 -- bounded detail. Resolves an opaque handle back to a resource only if
 * that handle belongs to this workflow. A handle minted for another workflow
 * yields CONTEXT_MISMATCH without revealing whether the resource exists.
 */
export async function getEvidenceDetail(workflowId, evidenceHandle) {
  const wf = workflow(workflowId)

  // Rebuild candidate handles from the workflow's own allowed searches; only a
  // handle we ourselves minted for THIS workflow can resolve.
  for (const req of REQUIREMENTS) {
    let result
    try {
      result = await findEvidence(workflowId, req.id)
    } catch {
      continue
    }
    const hit = result.candidates.find((c) => c.evidenceHandle === evidenceHandle)
    if (hit) {
      return { workflowId, requirementId: req.id, evidence: hit }
    }
  }
  throw new DomainError('CONTEXT_MISMATCH', 'Evidence is not available in this workflow context')
}

/** Read-only snapshot used by the smoke to prove nothing mutated. */
export async function snapshotResource(resourceType, id) {
  const { resource } = await fhir.read(resourceType, id)
  return {
    resourceType,
    id,
    versionId: resource.meta?.versionId ?? null,
    lastUpdated: resource.meta?.lastUpdated ?? null,
    hash: createHash('sha256')
      .update(JSON.stringify(resource, Object.keys(resource).sort()))
      .digest('hex'),
  }
}
