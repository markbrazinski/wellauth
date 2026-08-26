// Gate 3 -- submission across the simulated payer boundary.
//
// THE ONE HARD GUARANTEE
//   One human approval produces AT MOST ONE outbound payer request.
//
// How that is achieved, in order:
//   1. Every precondition is re-verified against live truth (Gate 2 approval is
//      necessary, never sufficient). Any failure => ZERO outbound calls.
//   2. A Firestore transaction moves APPROVED -> SUBMITTING. Exactly one caller
//      can win that transition; the loser never reaches the network.
//   3. The Claim business identifier is derived from the packet hash, so even
//      if a request were somehow delivered twice, the payer recognises the same
//      logical authorization rather than creating a second one.
//   4. An ambiguous transport outcome becomes UNKNOWN_SUBMISSION_OUTCOME and is
//      NEVER retried automatically. Resolution is explicit reconciliation.
//
// WHAT IS DELIBERATELY ABSENT
//   There is no retry loop. "Retry until 200" is precisely the bug that
//   duplicates authorizations, so an ambiguous result parks in a state that
//   requires a bounded reconciliation query instead.

import { randomUUID } from 'node:crypto'
import { GoogleAuth } from 'google-auth-library'
import { DomainError } from './service.js'
import { REQUIREMENTS_BY_ID, WORKFLOWS } from './policy.js'
import { compilePasBundle, readFrozenSources, claimIdentifier } from './pas.js'
import {
  bindingsCol,
  firestore,
  ledgerCol,
  manifestRef,
  submissionRef,
  submissionsCol,
  workflowRef,
} from './store.js'

/** Terminal-ish submission states. See docs/GATE-3-REPORT.md for the table. */
export const SUBMISSION_STATES = [
  'SUBMITTING',
  'SUBMITTED_OR_PENDING',
  'COMPLETE',
  'FAILED',
  'UNKNOWN_SUBMISSION_OUTCOME',
]

/** Server-bound destination. A caller can never name a payer URL. */
export const PAYER_BASE_URL = process.env.PAYER_BASE_URL ?? ''
// Bounds the payer HTTP call only (credential minting happens before the timer
// is armed). Sized for a Cloud Run cold start on the payer side; a genuinely
// hung payer still resolves to UNKNOWN_SUBMISSION_OUTCOME rather than hanging.
const PAYER_TIMEOUT_MS = Number(process.env.PAYER_TIMEOUT_MS ?? 30_000)

const nowIso = () => new Date().toISOString()

function policyFor(workflowId) {
  const wf = WORKFLOWS[workflowId]
  if (!wf) throw new DomainError('WORKFLOW_NOT_FOUND', 'Unknown workflow')
  return wf
}

// ---------------------------------------------------------------------------
// Authenticated service-to-service call to the simulated payer.
// ---------------------------------------------------------------------------

let auth
/**
 * Cloud Run ID token for the payer audience. The provider's own identity is
 * what authorizes the call -- there is no shared secret, no API key, and no
 * caller-supplied authorization header anywhere in this path.
 */
async function payerIdToken(audience) {
  if (process.env.PAYER_ID_TOKEN) return process.env.PAYER_ID_TOKEN
  auth ??= new GoogleAuth()
  const client = await auth.getIdTokenClient(audience)
  const headers = await client.getRequestHeaders()
  // google-auth-library returns a Headers instance, not a plain object --
  // property access on it silently yields undefined, so use .get().
  const raw = typeof headers?.get === 'function'
    ? headers.get('authorization')
    : (headers?.Authorization ?? headers?.authorization)
  const token = String(raw ?? '').replace(/^Bearer\s+/i, '')
  if (!token) {
    throw new DomainError('PAYER_UNAVAILABLE',
      'Could not mint a service credential for the payer boundary', { retryable: true })
  }
  return token
}

/**
 * Classifies the transport outcome. This is the function that decides whether
 * WellAuth is allowed to say "not received" -- and it is deliberately
 * conservative: anything it cannot prove is ambiguous.
 *
 *   accepted  : payer returned a response we can read
 *   rejected  : payer explicitly refused BEFORE recording (4xx validation)
 *   unknown   : socket died, timed out, or returned something unreadable
 */
async function transmit({ bundle, mode, correlationId }) {
  if (!PAYER_BASE_URL) {
    throw new DomainError('PAYER_UNAVAILABLE', 'No payer destination is configured',
      { retryable: true })
  }
  const url = `${PAYER_BASE_URL}/Claim/$submit`

  // Mint the credential BEFORE arming the timeout. The first token mint of a
  // process can take >13s (ADC discovery), and if that ran inside the timeout
  // budget it would consume the whole allowance and abort a payer call that
  // never actually got made -- turning a healthy submission into a spurious
  // UNKNOWN_SUBMISSION_OUTCOME. The timeout must bound the PAYER call only.
  let token
  try {
    token = await payerIdToken(PAYER_BASE_URL)
  } catch (cause) {
    // No credential means nothing was transmitted. That is a KNOWN
    // non-acceptance, not an ambiguous outcome.
    if (process.env.WELLAUTH_DEBUG_TRANSPORT === 'true') {
      console.error('CREDENTIAL_DEBUG', cause?.name, cause?.message)
    }
    throw cause instanceof DomainError ? cause : new DomainError(
      'PAYER_UNAVAILABLE', 'Could not authenticate to the payer boundary',
      { retryable: true })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAYER_TIMEOUT_MS)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/fhir+json',
        Accept: 'application/fhir+json',
        'X-Correlation-Id': correlationId,
        // Test-only scenario selector. Never derived from clinical content.
        ...(mode ? { 'X-Payer-Sim-Mode': mode } : {}),
      },
      body: JSON.stringify(bundle),
      signal: controller.signal,
    })
  } catch (cause) {
    // Connection reset / abort / DNS. We do NOT know whether the payer
    // recorded the request -- an accept-then-disconnect lands exactly here.
    if (process.env.WELLAUTH_DEBUG_TRANSPORT === 'true') {
      console.error('TRANSPORT_DEBUG', cause?.name, cause?.message, cause?.cause?.message)
    }
    return { classification: 'unknown', reason: cause?.name === 'AbortError' ? 'timeout' : 'transport' }
  } finally {
    clearTimeout(timer)
  }

  let body
  let raw
  try {
    raw = await res.text()
    body = JSON.parse(raw)
  } catch {
    // A response we cannot parse tells us nothing about acceptance.
    return { classification: 'unknown', reason: 'unreadable-response', status: res.status }
  }

  // 4xx = the payer refused the request itself. The simulator guarantees it
  // persists nothing on this path, so non-acceptance is a KNOWN fact.
  if (res.status >= 400 && res.status < 500) {
    return { classification: 'rejected', status: res.status, body }
  }
  // 5xx: the payer may or may not have recorded it. Never assume -- UNLESS the
  // payer explicitly guarantees it recorded nothing, which only the payer can
  // know. That guarantee is what makes a later fresh submission safe; without
  // it the outcome stays ambiguous and requires reconciliation.
  if (res.status >= 500) {
    if (res.headers.get('x-payer-not-recorded') === 'true') {
      return { classification: 'rejected', status: res.status, body, notRecorded: true }
    }
    return { classification: 'unknown', reason: 'server-error', status: res.status }
  }
  // PAS returns a response Bundle wrapping the ClaimResponse. Unwrap to the
  // decision resource; anything we cannot unwrap tells us nothing about
  // acceptance and must stay ambiguous rather than be optimistically accepted.
  const claimResponse = extractClaimResponse(body)
  if (!claimResponse) {
    return { classification: 'unknown', reason: 'unexpected-response-shape', status: res.status }
  }
  return { classification: 'accepted', status: res.status, body: claimResponse, envelope: body }
}

// ---------------------------------------------------------------------------
// Payer response interpretation.
// ---------------------------------------------------------------------------

/**
 * Unwraps the payer's decision from a PAS response Bundle.
 *
 * PAS 2.2.1 defines Claim/$submit as returning a Bundle whose sliced first
 * entry is the ClaimResponse. A bare ClaimResponse is still accepted so that
 * persisted receipts from before the bundle change, and any simpler payer,
 * keep working. Returns null when no ClaimResponse can be found -- the caller
 * must treat that as ambiguous, never as success.
 */
export function extractClaimResponse(body) {
  if (!body || typeof body !== 'object') return null
  if (body.resourceType === 'ClaimResponse') return body
  if (body.resourceType === 'Bundle') {
    const hit = (body.entry ?? [])
      .map((e) => e?.resource)
      .find((r) => r?.resourceType === 'ClaimResponse')
    return hit ?? null
  }
  return null
}

/**
 * Maps a synthetic ClaimResponse to a WellAuth submission state.
 *
 * HTTP success is NOT an authorization. The decision comes only from
 * ClaimResponse.outcome, and an unrecognised outcome is never optimistically
 * treated as approval.
 */
export function interpretClaimResponse(response) {
  const outcome = response?.outcome
  if (outcome === 'complete') {
    return { state: 'COMPLETE', payerStatus: 'approved' }
  }
  if (outcome === 'error') {
    // A definite payer DECISION (denial), not a transport failure. The
    // submission completed; the answer was no.
    return { state: 'COMPLETE', payerStatus: 'denied' }
  }
  if (outcome === 'queued' || outcome === 'partial') {
    return { state: 'SUBMITTED_OR_PENDING', payerStatus: 'pending' }
  }
  return { state: 'SUBMITTED_OR_PENDING', payerStatus: 'unrecognized-outcome' }
}

/** Bounded projection of a payer response. Never stores the raw bundle. */
function receiptFrom(response, requestHash, claimId) {
  return {
    receiptId: response.identifier?.find((i) => /receipt/.test(i.system ?? ''))?.value
      ?? response.id ?? null,
    payerReference: response.preAuthRef ?? null,
    responseResourceType: response.resourceType,
    responseId: response.id ?? null,
    outcome: response.outcome ?? null,
    disposition: response.disposition ?? null,
    // Retained for Act II. Gate 3 stores it and invents no window mechanics.
    preAuthPeriod: response.preAuthPeriod ?? null,
    reviewActionCode: response.item?.[0]?.adjudication?.[0]?.reason?.coding?.[0]?.code ?? null,
    requestHash,
    claimIdentifier: claimId,
    simulated: true,
    receivedAt: nowIso(),
  }
}

// ---------------------------------------------------------------------------
// Preconditions -- Gate 2 approval is necessary but NOT sufficient.
// ---------------------------------------------------------------------------

/**
 * Re-verifies every fact the approval depended on, immediately before
 * transmission. Any failure raises, and the caller has not yet claimed the
 * transition, so ZERO outbound requests occur.
 */
async function verifySubmittable(workflowId, d, expectedRevision) {
  if (d.state === 'APPROVED' && d.submission?.state === 'SUBMITTING') {
    throw new DomainError('SUBMISSION_IN_PROGRESS', 'A submission is already in flight')
  }
  if (d.state !== 'APPROVED') {
    throw new DomainError('APPROVAL_REQUIRED', 'Submission requires an approved workflow')
  }
  if (!d.approval || d.approval.outcome !== 'APPROVED') {
    throw new DomainError('APPROVAL_REQUIRED', 'No current approval exists')
  }
  if (typeof expectedRevision === 'number' && d.revision !== expectedRevision) {
    throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${d.revision}`)
  }
  // The approval must be for THIS packet, not an earlier one.
  if (d.approval.packetHash !== d.packetHash) {
    throw new DomainError('PACKET_HASH_MISMATCH',
      'Approval does not match the current prepared packet')
  }
  if (d.approval.manifestRevision !== d.manifestRevision) {
    throw new DomainError('APPROVAL_STALE', 'Approval is bound to a superseded preparation')
  }
  if (!d.manifestRevision || !d.packetHash) {
    throw new DomainError('APPROVAL_STALE', 'No frozen preparation is present')
  }

  // Completeness is recomputed from the server's own bindings. A 4/5 workflow
  // cannot be talked past this line by any client claim.
  const bindings = (await bindingsCol(workflowId).get()).docs.map((b) => b.data())
  const required = Object.keys(REQUIREMENTS_BY_ID)
  const missing = required.filter((id) => !bindings.some((b) => b.requirementId === id))
  if (missing.length) {
    throw new DomainError('MISSING_REQUIRED_EVIDENCE',
      `Requirements without current evidence: ${missing.join(', ')}`)
  }

  const mSnap = await manifestRef(workflowId, d.manifestRevision).get()
  if (!mSnap.exists) throw new DomainError('APPROVAL_STALE', 'Frozen manifest is missing')
  const manifest = mSnap.data()
  if (manifest.packetHash !== d.approval.packetHash) {
    throw new DomainError('PACKET_HASH_MISMATCH', 'Frozen manifest does not match the approval')
  }
  // The manifest must still describe the workflow's current bindings; if a
  // binding moved, the approval is for a different packet.
  for (const b of bindings) {
    const item = manifest.items.find((i) => i.requirementId === b.requirementId)
    if (!item || item.resourceId !== b.resourceId || item.sourceVersionId !== b.sourceVersionId) {
      throw new DomainError('PACKET_HASH_MISMATCH', 'Bindings have changed since approval')
    }
  }
  if (manifest.destination !== d.payer) {
    throw new DomainError('CONTEXT_MISMATCH', 'Prepared destination does not match the workflow payer')
  }
  return manifest
}

// ---------------------------------------------------------------------------
// submit_prior_authorization
// ---------------------------------------------------------------------------

/**
 * The Gate 3 operation. Available only in APPROVED, and it consumes the
 * approval: the capability is one-shot by construction.
 */
export async function submitPriorAuthorization(
  workflowId,
  { expectedRevision, idempotencyKey, simulatorMode, correlationId = randomUUID() } = {},
) {
  policyFor(workflowId)

  const snap = await workflowRef(workflowId).get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()

  // --- already-submitted short circuit -----------------------------------
  // A replay of a logically identical submission returns the existing result
  // instead of transmitting again. This is checked BEFORE preconditions so a
  // completed submission is idempotent even once its approval is consumed.
  if (d.submission && d.submission.state !== 'SUBMITTING') {
    if (d.submission.state === 'FAILED') {
      // A KNOWN non-acceptance is the one case a fresh attempt is permitted:
      // nothing was recorded downstream, so no duplicate can result.
      if (!d.approval) throw new DomainError('APPROVAL_REQUIRED', 'Approval is no longer present')
    } else {
      return {
        ...projectSubmission(workflowId, d),
        duplicate: true,
        transmitted: false,
      }
    }
  }
  if (d.submission?.state === 'SUBMITTING') {
    throw new DomainError('SUBMISSION_IN_PROGRESS', 'A submission is already in flight')
  }

  // --- preconditions: any failure => zero outbound calls -------------------
  const manifest = await verifySubmittable(workflowId, d, expectedRevision)

  // Live version-exact re-read of everything the packet froze. This is the
  // stale-source gate (P0.4/P0.5/P0.6) and it runs before any network call.
  const { sources, stale } = await readFrozenSources(manifest)
  if (stale.length) {
    throw new DomainError('SOURCE_STALE',
      'A source resource has changed since the packet was approved')
  }

  const compiled = compilePasBundle({ manifest, sources, workflowId })

  // The identifier must be a pure function of the approved packet, so a replay
  // cannot mint a second authorization.
  const expectedId = claimIdentifier(workflowId, d.approval.packetHash)
  if (compiled.claimIdentifier !== expectedId) {
    throw new DomainError('PACKET_HASH_MISMATCH', 'Compiled request does not match the approval')
  }

  // --- claim the transition: exactly one caller may transmit ---------------
  const submissionId = `sub-${d.approval.approvalId}`
  const claimed = await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(workflowRef(workflowId))
    const c = cur.data()
    // Re-assert under the transaction: anything that moved while we were
    // reading FHIR invalidates this attempt.
    if (c.state !== 'APPROVED') {
      throw new DomainError('APPROVAL_REQUIRED', 'Workflow is no longer approved')
    }
    if (c.packetHash !== d.packetHash || c.approval?.approvalId !== d.approval.approvalId) {
      throw new DomainError('APPROVAL_STALE', 'Approval changed during submission')
    }
    if (c.submission && c.submission.state !== 'FAILED') {
      throw new DomainError('SUBMISSION_IN_PROGRESS', 'A submission is already in flight')
    }
    if (typeof expectedRevision === 'number' && c.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Workflow has advanced to revision ${c.revision}`)
    }

    const attempt = (c.submission?.attempts ?? 0) + 1
    const submission = {
      submissionId,
      state: 'SUBMITTING',
      claimIdentifier: compiled.claimIdentifier,
      requestHash: compiled.requestHash,
      packetHash: c.packetHash,
      manifestRevision: c.manifestRevision,
      approvalId: c.approval.approvalId,
      idempotencyKey: idempotencyKey ?? null,
      destination: c.payer,
      attempts: attempt,
      startedAt: nowIso(),
      correlationId,
      simulated: true,
    }
    tx.update(workflowRef(workflowId), {
      submission,
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
    // Attempt ledger: append-only record of every claim of the transition.
    tx.create(submissionRef(workflowId, `${submissionId}-a${attempt}`), {
      ...submission, attempt,
    })
    return submission
  })

  await appendTransition(workflowId, {
    operation: 'submit_claim_transition', to: 'SUBMITTING',
    submissionId, claimIdentifier: compiled.claimIdentifier,
  })

  // ======================= THE NETWORK BOUNDARY ==========================
  // Exactly one caller reaches this line per approval.
  const result = await transmit({
    bundle: compiled.bundle, mode: simulatorMode, correlationId,
  })

  return finalizeSubmission(workflowId, claimed, compiled, result)
}

/**
 * Records the outcome of the one transmission. Every branch is durable and
 * none of them retries.
 */
async function finalizeSubmission(workflowId, submission, compiled, result) {
  let next

  if (result.classification === 'accepted') {
    const interpreted = interpretClaimResponse(result.body)
    next = {
      ...submission,
      state: interpreted.state,
      payerStatus: interpreted.payerStatus,
      receipt: receiptFrom(result.body, compiled.requestHash, compiled.claimIdentifier),
      httpStatus: result.status,
      completedAt: nowIso(),
    }
  } else if (result.classification === 'rejected') {
    // The payer refused the request itself and recorded nothing. Known
    // non-acceptance -- safe to describe as failed, and a corrected packet may
    // legitimately be submitted later.
    next = {
      ...submission,
      state: 'FAILED',
      payerStatus: 'not-accepted',
      failureCode: result.notRecorded ? 'PAYER_UNAVAILABLE' : 'PAYER_REJECTED_REQUEST',
      httpStatus: result.status,
      completedAt: nowIso(),
    }
  } else {
    // AMBIGUOUS. The payer may or may not hold this request. This is the state
    // that must never auto-retry: a blind resend is exactly how one approval
    // becomes two authorizations.
    next = {
      ...submission,
      state: 'UNKNOWN_SUBMISSION_OUTCOME',
      payerStatus: 'unknown',
      ambiguityReason: result.reason ?? 'transport',
      httpStatus: result.status ?? null,
      completedAt: nowIso(),
    }
  }

  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(workflowRef(workflowId))
    const c = cur.data()
    tx.update(workflowRef(workflowId), {
      submission: next,
      // The approval is consumed by the attempt, not by its success: a
      // successful submission can never be re-approved into a second one.
      ...(next.state === 'FAILED' ? {} : { approval: { ...c.approval, consumedBy: next.submissionId } }),
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
    tx.set(submissionRef(workflowId, `${next.submissionId}-a${next.attempts}`), next, { merge: true })
  })

  await appendTransition(workflowId, {
    operation: 'submit_prior_authorization', to: next.state,
    submissionId: next.submissionId, payerStatus: next.payerStatus,
  })

  const after = (await workflowRef(workflowId).get()).data()
  return {
    ...projectSubmission(workflowId, after),
    transmitted: true,
    duplicate: false,
  }
}

async function appendTransition(workflowId, entry) {
  await ledgerCol(workflowId).add({ ...entry, at: nowIso() })
}

/** Bounded projection. Never returns the outbound bundle or raw payer body. */
function projectSubmission(workflowId, d) {
  const s = d.submission
  if (!s) return { workflowId, state: d.state, revision: d.revision, submission: null }
  return {
    workflowId,
    state: d.state,
    revision: d.revision,
    submission: {
      submissionId: s.submissionId,
      state: s.state,
      claimIdentifier: s.claimIdentifier,
      requestHash: s.requestHash,
      packetHash: s.packetHash,
      destination: s.destination,
      attempts: s.attempts,
      payerStatus: s.payerStatus ?? null,
      startedAt: s.startedAt,
      completedAt: s.completedAt ?? null,
      ambiguityReason: s.ambiguityReason ?? null,
      failureCode: s.failureCode ?? null,
      simulated: true,
      receipt: s.receipt
        ? {
            receiptId: s.receipt.receiptId,
            payerReference: s.receipt.payerReference,
            responseResourceType: s.receipt.responseResourceType,
            outcome: s.receipt.outcome,
            disposition: s.receipt.disposition,
            preAuthPeriod: s.receipt.preAuthPeriod,
            receivedAt: s.receipt.receivedAt,
            simulated: true,
          }
        : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Reconciliation of UNKNOWN_SUBMISSION_OUTCOME
// ---------------------------------------------------------------------------

/**
 * Resolves an ambiguous submission by ASKING the payer whether it holds the
 * request, keyed on the stable business identifier the provider already minted.
 *
 * It never resends. If the payer has no record, the submission becomes FAILED
 * (known non-acceptance) and a fresh submission is then legitimate -- that is
 * the only safe recovery, and it is safe precisely because it is confirmed.
 */
export async function reconcileSubmission(workflowId, { correlationId = randomUUID() } = {}) {
  policyFor(workflowId)
  const snap = await workflowRef(workflowId).get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()
  const s = d.submission
  if (!s) throw new DomainError('NO_SUBMISSION', 'No submission exists for this workflow')
  if (s.state !== 'UNKNOWN_SUBMISSION_OUTCOME' && s.state !== 'SUBMITTING') {
    throw new DomainError('NOTHING_TO_RECONCILE', 'Submission outcome is already known')
  }

  if (!PAYER_BASE_URL) {
    throw new DomainError('PAYER_UNAVAILABLE', 'No payer destination is configured',
      { retryable: true })
  }

  // Bounded lookup: the identifier comes from OUR stored submission record,
  // never from a caller. There is no way to ask about another workflow.
  let res
  try {
    const token = await payerIdToken(PAYER_BASE_URL)
    res = await fetch(
      `${PAYER_BASE_URL}/Claim/$status/${encodeURIComponent(s.claimIdentifier)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/fhir+json',
          'X-Correlation-Id': correlationId,
        },
      },
    )
  } catch {
    throw new DomainError('PAYER_UNAVAILABLE', 'Simulated payer could not be reached',
      { retryable: true })
  }

  if (res.status === 404) {
    // Payer definitively holds no record: the request was never accepted.
    const next = {
      ...s,
      state: 'FAILED',
      payerStatus: 'not-accepted',
      failureCode: 'CONFIRMED_NOT_RECEIVED',
      reconciledAt: nowIso(),
    }
    await persistReconciled(workflowId, next)
    await appendTransition(workflowId, {
      operation: 'reconcile_submission', to: 'FAILED', resolution: 'confirmed-not-received',
    })
    return { ...projectSubmission(workflowId, (await workflowRef(workflowId).get()).data()),
      resolution: 'confirmed-not-received', resent: false }
  }

  if (!res.ok) {
    throw new DomainError('PAYER_UNAVAILABLE', 'Simulated payer status lookup failed',
      { retryable: true })
  }

  let body
  try {
    body = await res.json()
  } catch {
    throw new DomainError('PAYER_RESPONSE_INVALID', 'Simulated payer returned an unreadable status')
  }

  const params = Object.fromEntries(
    (body.parameter ?? []).map((p) => [p.name, p.valueString ?? p.valueInstant ?? p.valueInteger ?? p.valueBoolean]),
  )
  // The receipt must be for the exact artifact we sent, or this is not our
  // transaction and must not be adopted.
  if (params.requestHash && params.requestHash !== s.requestHash) {
    throw new DomainError('PAYER_RESPONSE_INVALID',
      'Payer receipt does not match the transmitted request')
  }

  // Accepts either a bare ClaimResponse (how the payer stores its decision) or
  // a PAS response Bundle, so reconciliation is independent of transport shape.
  const response = extractClaimResponse(body.response)
  const interpreted = response
    ? interpretClaimResponse(response)
    : { state: 'SUBMITTED_OR_PENDING', payerStatus: 'pending' }

  const next = {
    ...s,
    state: interpreted.state,
    payerStatus: interpreted.payerStatus,
    receipt: response
      ? receiptFrom(response, s.requestHash, s.claimIdentifier)
      : {
          receiptId: params.receiptId ?? null,
          payerReference: params.authorizationNumber ?? null,
          responseResourceType: 'Parameters',
          requestHash: s.requestHash,
          claimIdentifier: s.claimIdentifier,
          simulated: true,
          receivedAt: nowIso(),
        },
    reconciledAt: nowIso(),
  }
  await persistReconciled(workflowId, next)
  await appendTransition(workflowId, {
    operation: 'reconcile_submission', to: next.state, resolution: 'confirmed-received',
  })
  return {
    ...projectSubmission(workflowId, (await workflowRef(workflowId).get()).data()),
    resolution: 'confirmed-received',
    resent: false,
  }
}

async function persistReconciled(workflowId, next) {
  await firestore().runTransaction(async (tx) => {
    const cur = await tx.get(workflowRef(workflowId))
    const c = cur.data()
    tx.update(workflowRef(workflowId), {
      submission: next,
      revision: c.revision + 1,
      updatedAt: nowIso(),
    })
    tx.set(submissionRef(workflowId, `${next.submissionId}-a${next.attempts}`), next, { merge: true })
  })
}

// ---------------------------------------------------------------------------
// check_authorization_status
// ---------------------------------------------------------------------------

/**
 * Bounded status read.
 *
 * Reads PROVIDER-AUTHORITATIVE persisted state. The caller supplies a workflow
 * id and nothing else -- there is no parameter for a Claim id, a payer
 * reference or a patient, so a browser agent cannot ask about a submission
 * that is not its own. No decision is ever inferred from elapsed time.
 */
export async function checkAuthorizationStatus(workflowId) {
  policyFor(workflowId)
  const snap = await workflowRef(workflowId).get()
  if (!snap.exists) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not established')
  const d = snap.data()
  const s = d.submission

  if (!s) {
    return {
      workflowId,
      workflowState: d.state,
      submissionState: null,
      payerStatus: 'not-submitted',
      payer: d.payer,
      simulated: true,
      simulationNotice: 'Destination is a simulated payer. No real payer was contacted.',
    }
  }

  return {
    workflowId,
    workflowState: d.state,
    submissionState: s.state,
    payerStatus: s.payerStatus ?? null,
    payerReference: s.receipt?.payerReference ?? null,
    receiptId: s.receipt?.receiptId ?? null,
    disposition: s.receipt?.disposition ?? null,
    // Present for Act II; Gate 3 reports it verbatim and acts on nothing.
    authorizationPeriod: s.receipt?.preAuthPeriod ?? null,
    effectiveAt: s.receipt?.receivedAt ?? s.completedAt ?? s.startedAt,
    claimIdentifier: s.claimIdentifier,
    attempts: s.attempts,
    additionalInformationRequired: s.payerStatus === 'pending',
    requiresReconciliation: s.state === 'UNKNOWN_SUBMISSION_OUTCOME',
    payer: d.payer,
    simulated: true,
    simulationNotice: 'Destination is a simulated payer. No real payer was contacted.',
  }
}

/** Attempt ledger for one workflow -- used by the suite to count transmissions. */
export async function submissionAttempts(workflowId) {
  const snap = await submissionsCol(workflowId).get()
  return snap.docs.map((d) => d.data())
}
