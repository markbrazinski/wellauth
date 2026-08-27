// Gate 2 -- server-authoritative workflow state machine.
//
// AUTHORITY MODEL
//   Clinical truth  : FHIR R4 (Cloud Healthcare API), read-only, exact reads.
//   Workflow truth  : Firestore, transactional, revision-guarded.
//   Client          : contributes intent + expected_revision. Nothing else.
//
// A client cannot name a target state. There is no state setter. Every state
// below is the RESULT of a domain operation whose preconditions the server
// recomputed inside a transaction.
//
// FRESHNESS
//   Source freshness is proven by direct version-aware FHIR reads
//   (GET /{type}/{id} -> meta.versionId), never by FHIR search, because search
//   indexing lags (Gate 1 finding). prepare and approve both re-read every
//   bound resource plus the order and coverage.

import { randomUUID } from 'node:crypto'
import { FieldValue } from '@google-cloud/firestore'
import * as fhir from './fhir.js'
import { FhirError } from './fhir.js'
import { REQUIREMENTS, REQUIREMENTS_BY_ID, contextFor } from './policy.js'
import { DomainError, dateKindOf, effectiveOf, findEvidence, titleOf } from './service.js'
import { packetHash } from './canonical.js'
import {
  bindingRef,
  bindingsCol,
  firestore,
  handleRef,
  idemRef,
  ledgerCol,
  manifestRef,
  workflowRef,
} from './store.js'

export const STATES = [
  'CONTEXT_READY',
  'REQUIREMENTS_RESOLVED',
  'PACKET_COMPLETE',
  'PREPARED_AWAITING_APPROVAL',
  'APPROVED',
]

/**
 * Gate 3 extends the machine past APPROVED. Submission states live on
 * `submission.state` rather than on `state`, because the workflow's own state
 * stays APPROVED for the whole submission lifecycle: the approval is the thing
 * being consumed, and collapsing both axes into one field would lose the
 * distinction between "approved and not yet sent" and "approved and in flight".
 * See provider/submission.js.
 */
export const SUBMISSION_STATES = [
  'SUBMITTING',
  'SUBMITTED_OR_PENDING',
  'COMPLETE',
  'FAILED',
  'UNKNOWN_SUBMISSION_OUTCOME',
]

/** Version of the deterministic payer requirement set. Bumping invalidates. */
export const REQUIREMENT_SET_VERSION =
  process.env.WELLAUTH_REQUIREMENT_SET_VERSION ?? 'northstar-cardiac-mri-v1'

export const DESTINATION = 'Northstar Health Plan'
export const PURPOSE = 'prior-authorization-review'
/** Named, tracked exclusion policy -- what is deliberately NOT disclosed. */
export const EXCLUSION_POLICY_VERSION = 'wellauth-minimum-necessary-v1'
export const EXCLUSION_POLICY = [
  'unrelated-conditions',
  'unrelated-encounters',
  'unrelated-documents',
  'other-patients',
  'raw-clinical-narrative',
]

const REQUIRED_IDS = REQUIREMENTS.map((r) => r.id)

/** Roles permitted to approve. The agent has no role and cannot obtain one. */
export const APPROVER_ROLES = ['prior-auth-coordinator', 'clinician', 'supervisor']


function policyFor(workflowId) {
  const wf = contextFor(workflowId)
  if (!wf) throw new DomainError('WORKFLOW_NOT_FOUND', 'Unknown workflow')
  return wf
}

const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Exact, version-aware source reads. Never search.
// ---------------------------------------------------------------------------

async function readExact(resourceType, id) {
  try {
    const { resource, etag } = await fhir.read(resourceType, id)
    return { resource, etag, versionId: resource.meta?.versionId ?? null }
  } catch (err) {
    if (err instanceof FhirError && err.code === 'FHIR_NOT_FOUND') {
      throw new DomainError('SOURCE_MISSING', 'A bound source resource no longer exists')
    }
    throw new DomainError('FHIR_UNAVAILABLE', 'FHIR store unavailable', { retryable: true })
  }
}

/**
 * Re-runs the requirement's deterministic eligibility predicate against a
 * resource we already hold. This is policy re-evaluation WITHOUT a search:
 * it answers "does this exact resource still satisfy this requirement".
 */
function satisfiesPolicy(req, resource, wf) {
  const subject =
    resource.subject?.reference ?? resource.beneficiary?.reference ?? resource.patient?.reference
  // PractitionerRole has no patient subject; its binding is checked at attach.
  if (subject && subject !== `Patient/${wf.patientId}`) return false

  if (resource.resourceType !== req.resourceType) return false

  const codes = [...(resource.code?.coding ?? []), ...(resource.type?.coding ?? [])]
    .map((c) => c.code)
    .filter(Boolean)
  if (req.allowedCodes && !codes.some((c) => req.allowedCodes.includes(c))) return false

  if (req.rejectVerificationStatus) {
    const vs = resource.verificationStatus?.coding?.map((c) => c.code) ?? []
    if (vs.some((c) => req.rejectVerificationStatus.includes(c))) return false
  }

  if (req.titleMatch) {
    const title =
      resource.code?.text ??
      resource.type?.text ??
      resource.content?.[0]?.attachment?.title ??
      resource.type?.coding?.[0]?.display ??
      ''
    if (!req.titleMatch.test(title)) return false
  }

  if (resource.resourceType === 'DocumentReference' && resource.docStatus &&
      resource.docStatus !== 'final') return false

  // Status axes that must remain valid for the resource to count as evidence.
  if (resource.resourceType === 'DiagnosticReport' && resource.status !== 'final') return false
  if (resource.resourceType === 'DocumentReference' && resource.status !== 'current') return false
  if (resource.resourceType === 'Coverage' && resource.status !== 'active') return false
  if (resource.resourceType === 'PractitionerRole' && resource.active === false) return false
  if (resource.resourceType === 'Condition') {
    const cs = resource.clinicalStatus?.coding?.map((c) => c.code) ?? []
    if (cs.length && !cs.includes('active')) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Workflow creation / read
// ---------------------------------------------------------------------------

/**
 * Establishes CONTEXT_READY from exact source reads. Idempotent: an existing
 * workflow is returned untouched rather than reset, so a restart or a repeated
 * call can never silently discard bindings or an approval.
 */
export async function createWorkflow(workflowId) {
  const wf = policyFor(workflowId)
  const ref = workflowRef(workflowId)

  const existing = await ref.get()
  if (existing.exists) return getWorkflow(workflowId)

  const order = await readExact('ServiceRequest', wf.serviceRequestId)
  if ((order.resource.subject?.reference ?? null) !== `Patient/${wf.patientId}`) {
    throw new DomainError('CONTEXT_MISMATCH', 'Order is not bound to this workflow context')
  }
  const coverage = await readExact('Coverage', wf.coverageId)
  if ((coverage.resource.beneficiary?.reference ?? null) !== `Patient/${wf.patientId}`) {
    throw new DomainError('CONTEXT_MISMATCH', 'Coverage is not bound to this workflow context')
  }

  const doc = {
    workflowId,
    state: 'CONTEXT_READY',
    revision: 1,
    patientId: wf.patientId,
    order: {
      resourceType: 'ServiceRequest',
      id: wf.serviceRequestId,
      versionId: order.versionId,
    },
    coverage: {
      resourceType: 'Coverage',
      id: wf.coverageId,
      versionId: coverage.versionId,
    },
    payer: DESTINATION,
    requirementSetVersion: null,
    requirementsResolved: false,
    completeness: { satisfied: 0, required: REQUIRED_IDS.length, complete: false },
    manifestRevision: null,
    // Monotonic high-water mark. Manifests are immutable and append-only, so
    // this must NEVER be reset by invalidation -- otherwise a re-prepare would
    // collide with an existing frozen manifest document.
    lastManifestRevision: 0,
    preparedRevision: null,
    packetHash: null,
    approval: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  try {
    await ref.create(doc)
  } catch {
    // Lost a creation race -- the winner's document is authoritative.
    return getWorkflow(workflowId)
  }
  await appendTransition(workflowId, {
    from: null, to: 'CONTEXT_READY', operation: 'create_workflow', revision: 1,
  })
  return getWorkflow(workflowId)
}

async function appendTransition(workflowId, entry) {
  await ledgerCol(workflowId).add({ ...entry, at: nowIso() })
}

/** Projection of authoritative state. Never returns raw clinical content. */
export async function getWorkflow(workflowId) {
  policyFor(workflowId)
  const snap = await workflowRef(workflowId).get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()
  const bindings = await bindingsCol(workflowId).get()

  return {
    workflowId,
    state: d.state,
    revision: d.revision,
    payer: d.payer,
    requirementSetVersion: d.requirementSetVersion,
    completeness: d.completeness,
    order: d.order,
    coverage: d.coverage,
    manifestRevision: d.manifestRevision,
    preparedRevision: d.preparedRevision,
    packetHash: d.packetHash,
    approval: d.approval
      ? {
          approvedBy: d.approval.approvedBy,
          role: d.approval.role,
          at: d.approval.at,
          manifestRevision: d.approval.manifestRevision,
          packetHash: d.approval.packetHash,
          workflowRevision: d.approval.workflowRevision,
          outcome: d.approval.outcome,
        }
      : null,
    // Bounded submission summary. Never the outbound bundle or raw payer body.
    submission: d.submission
      ? {
          submissionId: d.submission.submissionId,
          state: d.submission.state,
          claimIdentifier: d.submission.claimIdentifier,
          requestHash: d.submission.requestHash,
          packetHash: d.submission.packetHash,
          destination: d.submission.destination,
          attempts: d.submission.attempts,
          payerStatus: d.submission.payerStatus ?? null,
          startedAt: d.submission.startedAt,
          completedAt: d.submission.completedAt ?? null,
          // The authorization validity window the payer granted. Act II's
          // coverage evaluation reads this, so it must survive the bounded
          // projection -- the rest of the receipt deliberately does not.
          authorizationPeriod: d.submission.receipt?.preAuthPeriod ?? null,
          payerReference: d.submission.receipt?.payerReference ?? null,
          // P2-2: the durable time the PAYER answered, so the Activity rail can
          // stamp the payer event from recorded truth instead of guessing.
          receivedAt: d.submission.receipt?.receivedAt ?? null,
          simulated: true,
        }
      : null,
    // Act II remediation record, raw. index.js projects it for the wire.
    remediation: d.remediation ?? null,
    bindings: bindings.docs
      .map((b) => b.data())
      .sort((a, z) => a.requirementId.localeCompare(z.requirementId))
      .map((b) => ({
        requirementId: b.requirementId,
        evidenceHandle: b.evidenceHandle,
        resourceType: b.resourceType,
        resourceId: b.resourceId,
        sourceVersionId: b.sourceVersionId,
        bindingRule: b.bindingRule,
        title: b.title ?? null,
        effectiveDate: b.effectiveDate ?? null,
        dateKind: b.dateKind ?? null,
        boundAt: b.boundAt,
        boundAtRevision: b.boundAtRevision,
      })),
    updatedAt: d.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/**
 * Resolves the versioned requirement set and registers evidence handles.
 *
 * Handle registration is the Gate 1 improvement: the bounded searches run ONCE
 * here, and each accepted candidate is persisted as
 * handle -> {requirementId, resourceType, resourceId, versionId}. Later
 * attach/prepare use direct version-aware reads against that stored scope, so
 * no operation replays five searches and none depends on search indexing.
 */
export async function resolveRequirements(workflowId) {
  policyFor(workflowId)
  const current = await getWorkflow(workflowId)

  const registered = []
  for (const req of REQUIREMENTS) {
    const result = await findEvidence(workflowId, req.id)
    for (const c of result.candidates) {
      registered.push({
        handle: c.evidenceHandle,
        requirementId: req.id,
        resourceType: c.resourceType,
        // findEvidence returns a projection; resolve the id from the handle map.
        resourceId: c.resourceId,
        sourceVersionId: c.sourceVersionId,
      })
    }
  }

  const batch = firestore().batch()
  for (const r of registered) {
    batch.set(handleRef(workflowId, r.handle), {
      workflowId,
      evidenceHandle: r.handle,
      requirementId: r.requirementId,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      observedVersionId: r.sourceVersionId,
      registeredAt: nowIso(),
    })
  }
  await batch.commit()

  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const d = snap.data()
    if (d.state !== 'CONTEXT_READY' && d.state !== 'REQUIREMENTS_RESOLVED') {
      throw new DomainError('ILLEGAL_TRANSITION', 'Requirements already resolved for this workflow')
    }
    if (d.state === 'REQUIREMENTS_RESOLVED' && d.requirementSetVersion === REQUIREMENT_SET_VERSION) {
      return // idempotent no-op; revision must not drift on a repeat call
    }
    tx.update(ref, {
      state: 'REQUIREMENTS_RESOLVED',
      requirementSetVersion: REQUIREMENT_SET_VERSION,
      requirementsResolved: true,
      revision: d.revision + 1,
      updatedAt: nowIso(),
    })
  })

  const after = await getWorkflow(workflowId)
  if (after.revision !== current.revision) {
    await appendTransition(workflowId, {
      from: current.state, to: after.state, operation: 'resolve_requirements',
      revision: after.revision, requirementSetVersion: REQUIREMENT_SET_VERSION,
    })
  }
  return {
    ...after,
    requirements: REQUIREMENTS.map((r) => ({
      id: r.id, label: r.label, expectedResourceType: r.resourceType,
      alternatePath: Boolean(r.alternatePath),
    })),
  }
}

// ---------------------------------------------------------------------------
// Completeness -- always recomputed server-side, never accepted from a caller.
// ---------------------------------------------------------------------------

function computeCompleteness(bindingDocs) {
  const satisfied = REQUIRED_IDS.filter((id) => bindingDocs.some((b) => b.requirementId === id))
  return {
    satisfied: satisfied.length,
    required: REQUIRED_IDS.length,
    complete: satisfied.length === REQUIRED_IDS.length,
    missing: REQUIRED_IDS.filter((id) => !satisfied.includes(id)),
  }
}

/**
 * Any change to bindings invalidates a preparation and any approval riding on
 * it. Returns the fields that reset prepared/approved state.
 */
function invalidationFields() {
  return {
    manifestRevision: null,
    preparedRevision: null,
    packetHash: null,
    approval: null,
  }
}

/**
 * Guard for operations that would invalidate a preparation.
 *
 * Once a submission has actually crossed the payer boundary, tearing down the
 * workflow underneath it would orphan a real outbound transaction. Editing
 * evidence after transmission is therefore refused rather than silently
 * discarding the payer's record of what was sent.
 */
function assertNotSubmitted(d) {
  const st = d.submission?.state
  if (!st || st === 'FAILED') return
  throw new DomainError('ALREADY_SUBMITTED',
    'This authorization has been submitted; workflow evidence can no longer be changed')
}

function stateAfterBindingChange(completeness) {
  return completeness.complete ? 'PACKET_COMPLETE' : 'REQUIREMENTS_RESOLVED'
}

// ---------------------------------------------------------------------------
// Attach / remove evidence
// ---------------------------------------------------------------------------

/**
 * Attach existing evidence to a requirement.
 *
 * Reversible workflow bookkeeping -- explicitly NOT the protected human
 * approval moment. Mutates workflow state only; clinical source is untouched.
 */
export async function attachEvidence(workflowId, { requirementId, evidenceHandle, expectedRevision }) {
  const wf = policyFor(workflowId)
  const req = REQUIREMENTS_BY_ID[requirementId]
  if (!req) throw new DomainError('REQUIREMENT_NOT_FOUND', 'Unknown requirement')
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }

  // Handle must be registered to THIS workflow. A handle minted elsewhere is
  // refused identically to an unknown one -- no existence leak.
  const hSnap = await handleRef(workflowId, evidenceHandle).get()
  if (!hSnap.exists) {
    throw new DomainError('CONTEXT_MISMATCH', 'Evidence is not available in this workflow context')
  }
  const handle = hSnap.data()
  if (handle.requirementId !== requirementId) {
    throw new DomainError('EVIDENCE_REQUIREMENT_MISMATCH', 'Evidence does not satisfy that requirement')
  }

  // Direct version-aware read + policy re-check. No search.
  const { resource, versionId } = await readExact(handle.resourceType, handle.resourceId)
  const subject =
    resource.subject?.reference ?? resource.beneficiary?.reference ?? resource.patient?.reference
  if (subject && subject !== `Patient/${wf.patientId}`) {
    throw new DomainError('CONTEXT_MISMATCH', 'Evidence is not available in this workflow context')
  }
  if (!satisfiesPolicy(req, resource, wf)) {
    throw new DomainError('EVIDENCE_INELIGIBLE', 'Evidence no longer satisfies this requirement')
  }

  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const d = snap.data()
    if (d.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
    }
    if (d.state === 'CONTEXT_READY') {
      throw new DomainError('REQUIREMENTS_NOT_RESOLVED', 'Requirements have not been resolved')
    }
    assertNotSubmitted(d)
    const bindingsSnap = await tx.get(bindingsCol(workflowId))
    const others = bindingsSnap.docs
      .map((b) => b.data())
      .filter((b) => b.requirementId !== requirementId)
    const next = [...others, { requirementId }]
    const completeness = computeCompleteness(next)
    const revision = d.revision + 1

    tx.set(bindingRef(workflowId, requirementId), {
      workflowId,
      requirementId,
      evidenceHandle,
      resourceType: handle.resourceType,
      resourceId: handle.resourceId,
      sourceVersionId: versionId,
      bindingRule: req.alternatePath ? 'alternate-document-path' : 'structured-resource-path',
      // C-2: presentation metadata for the provenance line, derived from the
      // exact resource version this binding freezes -- so the title and date
      // shown can never describe a different version than the one attached.
      // Costs no extra FHIR read: `resource` was already fetched above for the
      // version-aware policy re-check.
      title: titleOf(resource),
      effectiveDate: effectiveOf(resource),
      // P1-3: WHAT that date is. A Coverage/PractitionerRole period start is
      // administrative, not clinical, and must not be rendered as if it were
      // the date the evidence was authored.
      dateKind: dateKindOf(resource),
      boundAt: nowIso(),
      boundAtRevision: revision,
    })
    tx.update(ref, {
      ...invalidationFields(),
      state: stateAfterBindingChange(completeness),
      completeness,
      revision,
      updatedAt: nowIso(),
    })
  })

  const after = await getWorkflow(workflowId)
  await appendTransition(workflowId, {
    operation: 'attach_evidence', requirementId, to: after.state, revision: after.revision,
  })
  return after
}

/** Remove evidence: recomputes completeness, invalidates prepare + approval. */
export async function removeEvidence(workflowId, { requirementId, expectedRevision }) {
  policyFor(workflowId)
  if (!REQUIREMENTS_BY_ID[requirementId]) {
    throw new DomainError('REQUIREMENT_NOT_FOUND', 'Unknown requirement')
  }
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }

  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const d = snap.data()
    if (d.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
    }
    assertNotSubmitted(d)
    const bSnap = await tx.get(bindingRef(workflowId, requirementId))
    if (!bSnap.exists) throw new DomainError('NOT_BOUND', 'No evidence attached to that requirement')

    const bindingsSnap = await tx.get(bindingsCol(workflowId))
    const remaining = bindingsSnap.docs
      .map((b) => b.data())
      .filter((b) => b.requirementId !== requirementId)
    const completeness = computeCompleteness(remaining)

    tx.delete(bindingRef(workflowId, requirementId))
    tx.update(ref, {
      ...invalidationFields(),
      state: stateAfterBindingChange(completeness),
      completeness,
      revision: d.revision + 1,
      updatedAt: nowIso(),
    })
  })

  const after = await getWorkflow(workflowId)
  await appendTransition(workflowId, {
    operation: 'remove_evidence', requirementId, to: after.state, revision: after.revision,
  })
  return after
}

// ---------------------------------------------------------------------------
// Freshness -- exact direct reads of every version the workflow depends on.
// ---------------------------------------------------------------------------

/**
 * Re-reads order, coverage and every bound evidence resource directly and
 * compares meta.versionId against what the workflow recorded. Never uses FHIR
 * search: search indexing lags and would make this check unsound.
 *
 * Returns the freshly observed versions so the caller can freeze them.
 */
async function verifyFreshness(workflowId, d, bindings) {
  const stale = []

  const order = await readExact(d.order.resourceType, d.order.id)
  if (order.versionId !== d.order.versionId) {
    stale.push({ what: 'order', expected: d.order.versionId, actual: order.versionId })
  }
  const coverage = await readExact(d.coverage.resourceType, d.coverage.id)
  if (coverage.versionId !== d.coverage.versionId) {
    stale.push({ what: 'coverage', expected: d.coverage.versionId, actual: coverage.versionId })
  }
  if (!satisfiesPolicy(REQUIREMENTS_BY_ID['req-005'], coverage.resource, contextFor(workflowId))) {
    stale.push({ what: 'coverage', reason: 'ineligible' })
  }

  const evidence = []
  for (const b of bindings) {
    const req = REQUIREMENTS_BY_ID[b.requirementId]
    const cur = await readExact(b.resourceType, b.resourceId)
    if (cur.versionId !== b.sourceVersionId) {
      stale.push({
        what: 'evidence', requirementId: b.requirementId,
        expected: b.sourceVersionId, actual: cur.versionId,
      })
      continue
    }
    if (!satisfiesPolicy(req, cur.resource, contextFor(workflowId))) {
      stale.push({ what: 'evidence', requirementId: b.requirementId, reason: 'ineligible' })
      continue
    }
    evidence.push({ binding: b, versionId: cur.versionId })
  }

  return { stale, order, coverage, evidence }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Claims an idempotency key for one logical operation. A repeat of the same
 * key returns the ORIGINAL recorded result rather than performing the action
 * again, so replays never produce a second logical transition.
 */
async function claimIdempotency(workflowId, key, operation) {
  if (!key) return { fresh: true, record: null }
  const ref = idemRef(workflowId, key)
  const claimed = await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists) return snap.data()
    tx.create(ref, { workflowId, key, operation, status: 'in-progress', at: nowIso() })
    return null
  })
  if (!claimed) return { fresh: true, record: null }
  if (claimed.operation !== operation) {
    throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Key already used for a different operation')
  }
  if (claimed.status === 'in-progress') {
    throw new DomainError('OPERATION_IN_PROGRESS', 'An identical request is already in flight')
  }
  return { fresh: false, record: claimed }
}

async function completeIdempotency(workflowId, key, result) {
  if (!key) return
  await idemRef(workflowId, key).set(
    { status: 'complete', completedAt: nowIso(), result },
    { merge: true },
  )
}

async function releaseIdempotency(workflowId, key) {
  if (!key) return
  await idemRef(workflowId, key).delete().catch(() => {})
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/**
 * prepare_prior_authorization.
 *
 * Allowed only when the SERVER recomputes completeness as 5/5 from its own
 * bindings. A client claim of completeness has no effect anywhere in here.
 *
 * The frozen artifact is an internal representation, deliberately named
 * WellAuthPreparedSubmission/1 -- it is NOT a FHIR PAS Bundle and Gate 2 makes
 * no PAS claim. PAS compilation belongs to Gate 3, which can compile from this
 * frozen, hashed, version-exact input.
 */
export async function prepareSubmission(workflowId, { expectedRevision, idempotencyKey } = {}) {
  policyFor(workflowId)
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }

  const claim = await claimIdempotency(workflowId, idempotencyKey, 'prepare')
  if (!claim.fresh) return claim.record.result

  try {
    const snap = await workflowRef(workflowId).get()
    if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const d = snap.data()
    if (d.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
    }
    if (d.requirementSetVersion !== REQUIREMENT_SET_VERSION) {
      throw new DomainError('REQUIREMENT_SET_STALE', 'Requirement set version has changed')
    }
    assertNotSubmitted(d)

    const bindingsSnap = await bindingsCol(workflowId).get()
    const bindings = bindingsSnap.docs
      .map((b) => b.data())
      .sort((a, z) => a.requirementId.localeCompare(z.requirementId))

    // Server-side recomputation. 4/5 cannot get past this line.
    const completeness = computeCompleteness(bindings)
    if (!completeness.complete) {
      throw new DomainError(
        'MISSING_REQUIRED_EVIDENCE',
        `Requirements without current evidence: ${completeness.missing.join(', ')}`,
      )
    }

    const fresh = await verifyFreshness(workflowId, d, bindings)
    if (fresh.stale.length > 0) {
      throw new DomainError('SOURCE_STALE', 'A bound source resource has changed since it was attached')
    }

    const manifestRevision = (d.lastManifestRevision ?? d.manifestRevision ?? 0) + 1
    const preparedAt = nowIso()

    // The frozen, purpose-limited disclosure. Only what Northstar needs.
    // manifestRevision is packaging metadata, not disclosure content, so it is
    // attached to the stored document but deliberately kept OUT of `content`
    // -- otherwise re-preparing an identical packet would hash differently.
    const content = {
      artifact: 'WellAuthPreparedSubmission/1',
      workflowId,
      requirementSetVersion: d.requirementSetVersion,
      destination: DESTINATION,
      purpose: PURPOSE,
      order: { ...d.order },
      coverage: { ...d.coverage },
      patientContextRef: `Patient/${d.patientId}`,
      items: bindings.map((b) => ({
        requirementId: b.requirementId,
        resourceType: b.resourceType,
        resourceId: b.resourceId,
        sourceVersionId: b.sourceVersionId,
        inclusionReason: `satisfies:${b.requirementId}:${b.bindingRule}`,
      })),
      exclusionPolicy: { version: EXCLUSION_POLICY_VERSION, excludes: [...EXCLUSION_POLICY] },
    }
    // Hash covers disclosure content only -- revision counters and timestamps
    // stay out, so an identical packet prepared twice hashes identically.
    const hash = packetHash(content)
    const manifest = { ...content, manifestRevision }

    const ref = workflowRef(workflowId)
    await firestore().runTransaction(async (tx) => {
      const cur = await tx.get(ref)
      const c = cur.data()
      // Re-assert the precondition inside the transaction: anything that moved
      // while we were reading FHIR invalidates this preparation.
      if (c.revision !== expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
      }
      tx.create(manifestRef(workflowId, manifestRevision), {
        ...manifest, packetHash: hash, preparedAt, preparedAtRevision: c.revision + 1,
      })
      tx.update(ref, {
        state: 'PREPARED_AWAITING_APPROVAL',
        manifestRevision,
        lastManifestRevision: manifestRevision,
        preparedRevision: c.revision + 1,
        packetHash: hash,
        approval: null,
        revision: c.revision + 1,
        updatedAt: nowIso(),
      })
    })

    const after = await getWorkflow(workflowId)
    await appendTransition(workflowId, {
      operation: 'prepare', to: after.state, revision: after.revision,
      manifestRevision, packetHash: hash,
    })
    const result = {
      workflowId, state: after.state, revision: after.revision,
      manifestRevision, packetHash: hash, completeness: after.completeness,
    }
    await completeIdempotency(workflowId, idempotencyKey, result)
    return result
  } catch (err) {
    await releaseIdempotency(workflowId, idempotencyKey)
    throw err
  }
}

/** The frozen manifest -- "what Northstar will see". Immutable once written. */
export async function getPreparedDisclosure(workflowId) {
  policyFor(workflowId)
  const snap = await workflowRef(workflowId).get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()
  if (!d.manifestRevision) throw new DomainError('NOT_PREPARED', 'No prepared submission exists')
  const m = await manifestRef(workflowId, d.manifestRevision).get()
  if (!m.exists) throw new DomainError('NOT_PREPARED', 'No prepared submission exists')
  return { ...m.data(), state: d.state, currentPacketHash: d.packetHash }
}

// ---------------------------------------------------------------------------
// Human approval -- deliberately NOT a WebMCP tool and not an agent capability.
// ---------------------------------------------------------------------------

/**
 * record_submission_approval.
 *
 * The workforce UI action. The server takes the packet hash from its OWN
 * current workflow record; a client-supplied hash is only ever compared, never
 * trusted. Approval binds identity + role + exact manifest revision + exact
 * hash + workflow revision, and re-verifies source freshness first.
 *
 * No network submission occurs. APPROVED is terminal for Gate 2.
 */
export async function recordApproval(
  workflowId,
  { approvedBy, role, expectedRevision, nonce, acknowledgedPacketHash, idempotencyKey } = {},
) {
  policyFor(workflowId)
  if (!approvedBy || !role) {
    throw new DomainError('APPROVER_IDENTITY_REQUIRED', 'Workforce identity and role are required')
  }
  if (!APPROVER_ROLES.includes(role)) {
    throw new DomainError('ROLE_NOT_PERMITTED', 'Role may not approve a submission')
  }
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }
  if (!nonce) throw new DomainError('NONCE_REQUIRED', 'A one-time approval nonce is required')

  const claim = await claimIdempotency(workflowId, idempotencyKey, 'approve')
  if (!claim.fresh) return claim.record.result

  try {
    const snap = await workflowRef(workflowId).get()
    if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const d = snap.data()

    if (d.state !== 'PREPARED_AWAITING_APPROVAL') {
      throw new DomainError('NOT_AWAITING_APPROVAL', 'No frozen submission is awaiting approval')
    }
    if (d.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
    }
    // The client may state which hash it believes it is approving; it is
    // checked against the server's, never substituted for it.
    if (acknowledgedPacketHash && acknowledgedPacketHash !== d.packetHash) {
      throw new DomainError('PACKET_HASH_MISMATCH', 'Approved packet does not match the prepared packet')
    }

    const bindingsSnap = await bindingsCol(workflowId).get()
    const bindings = bindingsSnap.docs
      .map((b) => b.data())
      .sort((a, z) => a.requirementId.localeCompare(z.requirementId))

    const completeness = computeCompleteness(bindings)
    if (!completeness.complete) {
      throw new DomainError('MISSING_REQUIRED_EVIDENCE', 'Preparation is no longer complete')
    }
    // Full freshness re-check at the approval boundary (P0.10/P0.12).
    const fresh = await verifyFreshness(workflowId, d, bindings)
    if (fresh.stale.length > 0) {
      // Approval refused AND the stale preparation is torn down atomically.
      await invalidatePreparation(workflowId, 'SOURCE_STALE')
      throw new DomainError('SOURCE_STALE', 'Source changed since preparation; re-prepare required')
    }

    const ref = workflowRef(workflowId)
    const approval = {
      approvalId: randomUUID(),
      approvedBy, role,
      workflowId,
      manifestRevision: d.manifestRevision,
      packetHash: d.packetHash,
      workflowRevision: d.revision,
      nonce,
      at: nowIso(),
      outcome: 'APPROVED',
    }

    await firestore().runTransaction(async (tx) => {
      const cur = await tx.get(ref)
      const c = cur.data()
      if (c.revision !== expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
      }
      if (c.state !== 'PREPARED_AWAITING_APPROVAL') {
        throw new DomainError('NOT_AWAITING_APPROVAL', 'No frozen submission is awaiting approval')
      }
      // One-time nonce: a replayed nonce cannot mint a second approval.
      if (c.consumedNonces?.includes(nonce)) {
        throw new DomainError('NONCE_ALREADY_USED', 'This approval nonce has already been used')
      }
      tx.update(ref, {
        state: 'APPROVED',
        approval,
        consumedNonces: FieldValue.arrayUnion(nonce),
        revision: c.revision + 1,
        updatedAt: nowIso(),
      })
    })

    const after = await getWorkflow(workflowId)
    await appendTransition(workflowId, {
      operation: 'approve', to: after.state, revision: after.revision,
      manifestRevision: approval.manifestRevision, packetHash: approval.packetHash,
      approvedBy, role,
    })
    const result = {
      workflowId, state: after.state, revision: after.revision,
      approval: after.approval, submitted: false,
    }
    await completeIdempotency(workflowId, idempotencyKey, result)
    return result
  } catch (err) {
    await releaseIdempotency(workflowId, idempotencyKey)
    throw err
  }
}

/** Tears down a preparation and any approval riding on it, atomically. */
async function invalidatePreparation(workflowId, reason) {
  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const d = snap.data()
    if (!d.manifestRevision && !d.approval) return
    const bindingsSnap = await tx.get(bindingsCol(workflowId))
    const completeness = computeCompleteness(bindingsSnap.docs.map((b) => b.data()))
    tx.update(ref, {
      ...invalidationFields(),
      state: stateAfterBindingChange(completeness),
      completeness,
      revision: d.revision + 1,
      invalidationReason: reason,
      updatedAt: nowIso(),
    })
  })
  await appendTransition(workflowId, { operation: 'invalidate_preparation', reason })
}

/**
 * Reconciliation: adopt the current source versions after a legitimate upstream
 * change. Explicit, never automatic -- and it always drops any preparation and
 * approval, so a changed source can never ride an old approval forward.
 */
export async function reconcileSources(workflowId, { expectedRevision } = {}) {
  const wf = policyFor(workflowId)
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }
  const order = await readExact('ServiceRequest', wf.serviceRequestId)
  const coverage = await readExact('Coverage', wf.coverageId)

  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const d = snap.data()
    if (d.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
    }
    assertNotSubmitted(d)
    const bindingsSnap = await tx.get(bindingsCol(workflowId))
    // Bindings whose source moved are dropped: re-attaching is a human choice,
    // not something reconciliation may infer.
    const kept = []
    for (const doc of bindingsSnap.docs) {
      const b = doc.data()
      if (b.staleObserved) tx.delete(doc.ref)
      else kept.push(b)
    }
    const completeness = computeCompleteness(kept)
    tx.update(ref, {
      ...invalidationFields(),
      order: { resourceType: 'ServiceRequest', id: wf.serviceRequestId, versionId: order.versionId },
      coverage: { resourceType: 'Coverage', id: wf.coverageId, versionId: coverage.versionId },
      state: stateAfterBindingChange(completeness),
      completeness,
      revision: d.revision + 1,
      updatedAt: nowIso(),
    })
  })
  await appendTransition(workflowId, { operation: 'reconcile_sources' })
  return getWorkflow(workflowId)
}
