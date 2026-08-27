// Act II -- authorization-window remediation.
//
// WHAT THIS PROVES
//   A payer response can change what the application is able to do next.
//
// The simulated payer APPROVES the request, but the authorization validity
// window it grants ends before the already-scheduled MRI. The prior
// authorization is therefore technically approved while the ordered care stays
// administratively blocked. WellAuth detects that deterministically from
// PERSISTED payer state (never from browser inference), and only then does a
// new bounded capability become valid.
//
// CLINICAL INVARIANT
//   Nothing here mutates clinical truth. Not the ServiceRequest, not the
//   service code, not the schedule, not a Condition, Observation,
//   DiagnosticReport or DocumentReference, not the evidence selection, not
//   medical necessity or intent. The ONLY thing this changes is the
//   administrative authorization validity window held by the simulated payer.
//   The scheduled service date is read from FHIR and is an INPUT here; there
//   is no code path that writes it.
//
// CLAIM BOUNDARY
//   This is the canonical workflow of the synthetic Northstar simulator. It is
//   NOT a claim that real payers expose a standardized authorization-extension
//   transaction, and NOT a claim of Da Vinci PAS extension conformance.

import { randomUUID } from 'node:crypto'
import { FieldValue } from '@google-cloud/firestore'
import { DomainError } from './service.js'
import { packetHash } from './canonical.js'
import { firestore, workflowRef } from './store.js'
import { transmit } from './submission.js'
import { contextFor } from './policy.js'
import * as fixture from './fixture.js'

const nowIso = () => new Date().toISOString()

/** Same bounded workflow lookup used by workflow.js / submission.js. */
function policyFor(workflowId) {
  const wf = contextFor(workflowId)
  if (!wf) throw new DomainError('WORKFLOW_NOT_FOUND', 'Unknown workflow')
  return wf
}

/** Act II states, carried on `remediation.state`. */
export const REMEDIATION_STATES = [
  'REMEDIATION_AVAILABLE',
  'REMEDIATION_PREPARED',
  'REMEDIATION_APPROVED',
  'REMEDIATION_SUBMITTING',
  'REMEDIATION_SUBMITTED',
  'AUTHORIZATION_ALIGNED',
]

export const APPROVER_ROLES = ['prior-auth-coordinator', 'clinician', 'supervisor']

export const REMEDIATION_ARTIFACT = 'WellAuthAuthorizationWindowRemediation/1'

/**
 * Deterministic coverage evaluation.
 *
 * A date-only string comparison is correct here because both values are
 * ISO `YYYY-MM-DD` in the same calendar frame, and lexical order on that form
 * IS chronological order. Parsing to Date would introduce a timezone question
 * that does not exist in the data.
 */
export function evaluateAlignment({ scheduledServiceDate, validThrough }) {
  if (!scheduledServiceDate || !validThrough) {
    return { evaluated: false, aligned: null, scheduledServiceDate, validThrough }
  }
  return {
    evaluated: true,
    aligned: scheduledServiceDate <= validThrough,
    scheduledServiceDate,
    validThrough,
  }
}

/**
 * Derives the Act II posture from PERSISTED state only.
 *
 * Pure function: the caller supplies the workflow document and the scheduled
 * date read from FHIR. Nothing here reads the network, so the same inputs
 * always produce the same posture -- which is what makes a page reload
 * reconstruct the identical capability set.
 */
export function derivePosture(d, scheduledServiceDate) {
  const sub = d?.submission
  const rem = d?.remediation

  // Act II cannot begin until a real payer decision is persisted.
  const payerApproved =
    sub?.state === 'COMPLETE' && sub?.payerStatus === 'approved'
  if (!payerApproved) return { phase: null, alignment: null }

  // Accepts both the bounded projection (authorizationPeriod) and a raw
  // Firestore document (receipt.preAuthPeriod), so the same evaluation runs
  // over an HTTP snapshot and an in-transaction read alike.
  const validThrough =
    rem?.currentValidThrough ??
    sub?.authorizationPeriod?.end ??
    sub?.receipt?.preAuthPeriod?.end ??
    null
  const alignment = evaluateAlignment({ scheduledServiceDate, validThrough })

  // Already covered: there is nothing to remediate and no capability appears.
  if (alignment.aligned === true) {
    return { phase: rem?.state === 'AUTHORIZATION_ALIGNED' ? 'AUTHORIZATION_ALIGNED'
                                                           : 'AUTHORIZATION_ALIGNED',
             alignment }
  }
  if (alignment.aligned === null) return { phase: null, alignment }

  // Mismatch is real. Phase follows the durable remediation record.
  if (!rem) return { phase: 'PAYER_APPROVED_COVERAGE_GAP', alignment }
  return { phase: rem.state, alignment }
}

/** The bounded, human-reviewable remediation artifact. */
function buildRemediation(d, scheduledServiceDate, currentValidThrough, revision) {
  // Only semantically meaningful fields are hashed. `preparedAt` is volatile
  // and is deliberately excluded so that preparing the identical remediation
  // twice yields the identical hash (Gate 2 determinism principle).
  const semantic = {
    type: REMEDIATION_ARTIFACT,
    workflowId: d.workflowId,
    originalSubmissionId: d.submission.submissionId,
    payerAuthorizationReference: d.submission.receipt?.payerReference ?? null,
    payer: d.payer,
    currentValidThrough,
    scheduledServiceDate,
    requestedValidThrough: fixture.EXTENDED_VALID_THROUGH,
    reasonCode: fixture.REMEDIATION_REASON_CODE,
    reasonDisplay: fixture.REMEDIATION_REASON_DISPLAY,
    // Stated explicitly in the artifact the human approves, so the scope of
    // what is being authorized is legible rather than implied.
    clinicalIntentChanged: false,
    evidenceChanged: false,
    orderChanged: false,
    revision,
  }
  return { ...semantic, hash: packetHash(semantic), preparedAt: nowIso() }
}

/**
 * `resolve_authorization_window`.
 *
 * Prepares the remediation. Sends nothing. The caller may not name the
 * requested date, the payer, or the authorization -- every authoritative field
 * is resolved from durable state and server policy.
 */
export async function resolveAuthorizationWindow(
  workflowId, { expectedRevision, scheduledServiceDate } = {},
) {
  policyFor(workflowId)
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }

  const ref = workflowRef(workflowId)
  const snap = await ref.get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()

  const posture = derivePosture({ ...d, workflowId }, scheduledServiceDate)
  if (posture.phase === null) {
    throw new DomainError('REMEDIATION_NOT_AVAILABLE',
      'No persisted payer approval to remediate')
  }
  if (posture.alignment?.aligned === true) {
    throw new DomainError('NO_COVERAGE_GAP',
      'Authorization already covers the scheduled service')
  }
  if (posture.phase !== 'PAYER_APPROVED_COVERAGE_GAP') {
    throw new DomainError('REMEDIATION_ALREADY_PREPARED',
      `Remediation is already at ${posture.phase}`)
  }

  const remediation = buildRemediation(
    { ...d, workflowId }, scheduledServiceDate, posture.alignment.validThrough, d.revision,
  )

  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    const c = cur.data()
    if (c.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
    }
    if (c.remediation) {
      throw new DomainError('REMEDIATION_ALREADY_PREPARED', 'Remediation already prepared')
    }
    tx.update(ref, {
      remediation: {
        ...remediation,
        state: 'REMEDIATION_PREPARED',
        currentValidThrough: posture.alignment.validThrough,
        approval: null,
        submission: null,
      },
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
  })

  await appendRemediationEvent(workflowId, {
    operation: 'resolve_authorization_window',
    to: 'REMEDIATION_PREPARED',
    hash: remediation.hash,
  })

  return projectRemediation(await ref.get(), scheduledServiceDate)
}

/**
 * The human approval of the exact remediation. Deliberately NOT a WebMCP tool
 * -- it is reachable only with workforce headers a browser agent does not hold.
 * Approving does not transmit.
 */
export async function approveRemediation(
  workflowId, { approvedBy, role, expectedRevision, nonce, acknowledgedHash,
                scheduledServiceDate } = {},
) {
  policyFor(workflowId)
  if (!approvedBy || !role) {
    throw new DomainError('APPROVER_IDENTITY_REQUIRED', 'Workforce identity and role are required')
  }
  if (!APPROVER_ROLES.includes(role)) {
    throw new DomainError('ROLE_NOT_PERMITTED', 'Role may not approve a remediation')
  }
  if (typeof expectedRevision !== 'number') {
    throw new DomainError('EXPECTED_REVISION_REQUIRED', 'expected_revision is required')
  }
  if (!nonce) throw new DomainError('NONCE_REQUIRED', 'A one-time approval nonce is required')

  const ref = workflowRef(workflowId)

  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    if (!cur.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const c = cur.data()
    const rem = c.remediation
    if (!rem || rem.state !== 'REMEDIATION_PREPARED') {
      throw new DomainError('NOT_AWAITING_APPROVAL', 'No prepared remediation is awaiting approval')
    }
    if (c.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
    }
    // The client may state which hash it believes it approves; it is checked
    // against the server's, never substituted for it.
    if (acknowledgedHash && acknowledgedHash !== rem.hash) {
      throw new DomainError('REMEDIATION_HASH_MISMATCH',
        'Approved remediation does not match the prepared remediation')
    }
    // Re-verify the gap still exists against the CURRENT persisted validity.
    // If the payer window already moved, approving would authorize a change
    // that is no longer warranted.
    const alignment = evaluateAlignment({
      scheduledServiceDate,
      validThrough: rem.currentValidThrough,
    })
    if (alignment.aligned !== false) {
      throw new DomainError('REMEDIATION_STALE',
        'Coverage gap no longer holds as prepared')
    }
    if (c.consumedNonces?.includes(nonce)) {
      throw new DomainError('NONCE_ALREADY_USED', 'This approval nonce has already been used')
    }

    tx.update(ref, {
      'remediation.state': 'REMEDIATION_APPROVED',
      'remediation.approval': {
        approvalId: randomUUID(),
        approvedBy,
        role,
        remediationHash: rem.hash,
        remediationRevision: rem.revision,
        workflowRevision: c.revision,
        nonce,
        at: nowIso(),
        outcome: 'APPROVED',
      },
      consumedNonces: FieldValue.arrayUnion(nonce),
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
  })

  await appendRemediationEvent(workflowId, {
    operation: 'approve_remediation', to: 'REMEDIATION_APPROVED', approvedBy, role,
  })

  return projectRemediation(await ref.get(), scheduledServiceDate)
}

/**
 * Transactionally claims REMEDIATION_APPROVED -> REMEDIATION_SUBMITTING.
 *
 * Exactly one caller can win, so exactly one outbound remediation request is
 * possible. Same mechanism Gate 3 proved for the original submission; the
 * network call happens strictly AFTER this returns.
 */
export async function claimRemediationSubmission(
  workflowId, { expectedRevision, scheduledServiceDate } = {},
) {
  policyFor(workflowId)
  const ref = workflowRef(workflowId)

  return firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    if (!cur.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
    const c = cur.data()
    const rem = c.remediation

    if (!rem) throw new DomainError('REMEDIATION_NOT_AVAILABLE', 'No remediation prepared')
    if (rem.state === 'REMEDIATION_SUBMITTING') {
      throw new DomainError('REMEDIATION_IN_PROGRESS', 'A remediation submission is in flight')
    }
    if (rem.state === 'REMEDIATION_SUBMITTED' || rem.state === 'AUTHORIZATION_ALIGNED') {
      throw new DomainError('REMEDIATION_ALREADY_SUBMITTED', 'Remediation already submitted')
    }
    if (rem.state !== 'REMEDIATION_APPROVED' || !rem.approval) {
      throw new DomainError('REMEDIATION_APPROVAL_REQUIRED',
        'Remediation requires explicit workforce approval before submission')
    }
    // The approval must be for the exact artifact still on the record.
    if (rem.approval.remediationHash !== rem.hash) {
      throw new DomainError('REMEDIATION_HASH_MISMATCH',
        'Approval does not match the current remediation')
    }
    if (typeof expectedRevision === 'number' && c.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
    }
    // The gap must still hold, and the schedule must be what was approved.
    if (scheduledServiceDate !== rem.scheduledServiceDate) {
      throw new DomainError('REMEDIATION_STALE',
        'Scheduled service changed since the remediation was approved')
    }
    const alignment = evaluateAlignment({
      scheduledServiceDate, validThrough: rem.currentValidThrough,
    })
    if (alignment.aligned !== false) {
      throw new DomainError('REMEDIATION_STALE', 'Coverage gap no longer holds')
    }

    tx.update(ref, {
      'remediation.state': 'REMEDIATION_SUBMITTING',
      'remediation.submission': {
        remediationSubmissionId: `rem-${rem.approval.approvalId}`,
        startedAt: nowIso(),
        attempts: (rem.submission?.attempts ?? 0) + 1,
      },
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })

    return {
      claimIdentifier: c.submission.claimIdentifier,
      authorizationReference: rem.payerAuthorizationReference,
      expectedValidThrough: rem.currentValidThrough,
      requestedValidThrough: rem.requestedValidThrough,
      remediationHash: rem.hash,
      remediationSubmissionId: `rem-${rem.approval.approvalId}`,
    }
  })
}

/** Persists the payer's extension response and recomputes alignment. */
export async function settleRemediation(
  workflowId, { validThrough, extensionReceiptId, outcome, scheduledServiceDate },
) {
  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    const c = cur.data()
    const alignment = evaluateAlignment({ scheduledServiceDate, validThrough })
    tx.update(ref, {
      // AUTHORIZATION_ALIGNED is reached ONLY when the persisted payer validity
      // actually covers the authoritative scheduled date. It is never asserted
      // from a successful HTTP status.
      'remediation.state': alignment.aligned === true
        ? 'AUTHORIZATION_ALIGNED'
        : 'REMEDIATION_SUBMITTED',
      'remediation.currentValidThrough': validThrough,
      'remediation.submission.completedAt': nowIso(),
      'remediation.submission.outcome': outcome,
      'remediation.submission.extensionReceiptId': extensionReceiptId,
      'remediation.submission.simulated': true,
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
  })
  await appendRemediationEvent(workflowId, {
    operation: 'settle_remediation', extensionReceiptId, validThrough,
  })
}

/** Records an ambiguous remediation outcome. Never retried automatically. */
export async function markRemediationAmbiguous(workflowId, reason) {
  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    const c = cur.data()
    tx.update(ref, {
      'remediation.state': 'REMEDIATION_UNKNOWN_OUTCOME',
      'remediation.submission.ambiguityReason': reason,
      'remediation.submission.completedAt': nowIso(),
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
  })
}

/** Returns a failed remediation to APPROVED so a fresh attempt is safe. */
export async function markRemediationFailed(workflowId, failureCode) {
  const ref = workflowRef(workflowId)
  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    const c = cur.data()
    tx.update(ref, {
      'remediation.state': 'REMEDIATION_APPROVED',
      'remediation.submission.failureCode': failureCode,
      'remediation.submission.completedAt': nowIso(),
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
  })
}

async function appendRemediationEvent(workflowId, entry) {
  await workflowRef(workflowId).collection('transitions').add({ ...entry, at: nowIso() })
}

/** Bounded projection. Never returns the raw payer body. */
export function projectRemediation(snap, scheduledServiceDate) {
  const d = snap.data()
  const rem = d.remediation
  const posture = derivePosture({ ...d, workflowId: snap.id }, scheduledServiceDate)
  if (!rem) {
    return { workflowId: snap.id, revision: d.revision, remediation: null,
             phase: posture.phase, alignment: posture.alignment }
  }
  return {
    workflowId: snap.id,
    revision: d.revision,
    phase: posture.phase,
    alignment: posture.alignment,
    remediation: {
      type: rem.type,
      state: rem.state,
      payer: rem.payer,
      payerAuthorizationReference: rem.payerAuthorizationReference,
      currentValidThrough: rem.currentValidThrough,
      scheduledServiceDate: rem.scheduledServiceDate,
      requestedValidThrough: rem.requestedValidThrough,
      reasonCode: rem.reasonCode,
      reasonDisplay: rem.reasonDisplay,
      clinicalIntentChanged: false,
      evidenceChanged: false,
      orderChanged: false,
      revision: rem.revision,
      hash: rem.hash,
      preparedAt: rem.preparedAt,
      approval: rem.approval
        ? {
            approvedBy: rem.approval.approvedBy,
            role: rem.approval.role,
            at: rem.approval.at,
            remediationHash: rem.approval.remediationHash,
            outcome: rem.approval.outcome,
          }
        : null,
      submission: rem.submission
        ? {
            remediationSubmissionId: rem.submission.remediationSubmissionId,
            attempts: rem.submission.attempts,
            startedAt: rem.submission.startedAt,
            completedAt: rem.submission.completedAt ?? null,
            outcome: rem.submission.outcome ?? null,
            extensionReceiptId: rem.submission.extensionReceiptId ?? null,
            ambiguityReason: rem.submission.ambiguityReason ?? null,
            failureCode: rem.submission.failureCode ?? null,
            simulated: true,
          }
        : null,
      simulated: true,
    },
  }
}

// ---------------------------------------------------------------------------
// `submit_authorization_extension`
// ---------------------------------------------------------------------------

/**
 * Transmits the exact workforce-approved remediation to the simulated payer.
 *
 * Exactly-once, by the same construction Gate 3 proved:
 *   1. every precondition is checked BEFORE the claim, so a refusal transmits
 *      nothing at all;
 *   2. a Firestore transaction claims REMEDIATION_APPROVED -> SUBMITTING, so
 *      exactly one caller can reach the network;
 *   3. the remediation hash is a deterministic function of the approved
 *      artifact, so the payer collapses a duplicate delivery onto the same
 *      logical remediation rather than granting a second extension;
 *   4. there is NO retry loop. An ambiguous outcome stays ambiguous.
 *
 * The caller supplies only a workflow id and an expected revision. The payer,
 * the authorization reference, the current validity and the requested validity
 * are all resolved from durable state -- none of them are caller-controlled.
 */
export async function submitAuthorizationExtension(
  workflowId, { expectedRevision, scheduledServiceDate, correlationId } = {},
) {
  // Claims the transition. Throws before any network call if preconditions
  // fail, so a refused submission provably transmits nothing.
  const claim = await claimRemediationSubmission(workflowId, {
    expectedRevision, scheduledServiceDate,
  })

  const result = await transmit({
    path: '/authorization-extension',
    contentType: 'application/json',
    correlationId,
    bundle: {
      claimIdentifier: claim.claimIdentifier,
      authorizationReference: claim.authorizationReference,
      expectedValidThrough: claim.expectedValidThrough,
      requestedValidThrough: claim.requestedValidThrough,
      remediationHash: claim.remediationHash,
    },
    unwrap: (body) => (body?.resourceType === 'Parameters' ? body : null),
  })

  if (result.classification === 'rejected') {
    // The payer refused before recording. A fresh attempt is safe.
    await markRemediationFailed(workflowId, 'PAYER_REJECTED_REMEDIATION')
    throw new DomainError('PAYER_REJECTED_REMEDIATION',
      'Simulated payer refused the remediation request')
  }
  if (result.classification === 'unknown') {
    // Never retried automatically -- WellAuth cannot tell whether the payer
    // applied the extension, so it records that honestly and stops.
    await markRemediationAmbiguous(workflowId, result.reason)
    throw new DomainError('UNKNOWN_REMEDIATION_OUTCOME',
      'Remediation outcome could not be determined; reconciliation required')
  }

  const params = Object.fromEntries(
    (result.body.parameter ?? []).map((p) => [p.name, p.valueString ?? p.valueBoolean]),
  )
  // Alignment is recomputed from the persisted payer validity, never asserted
  // from the HTTP status.
  await settleRemediation(workflowId, {
    validThrough: params.validThrough,
    extensionReceiptId: params.extensionReceiptId,
    outcome: params.outcome,
    scheduledServiceDate,
  })

  return projectRemediation(await workflowRef(workflowId).get(), scheduledServiceDate)
}
