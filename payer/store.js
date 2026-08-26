// Simulated-payer transaction store.
//
// Separate Firestore DATABASE from the provider's workflow store, so the payer
// boundary is a real data boundary and not two collections in one trust domain.
// The provider cannot read this and the payer cannot read workflow state.
//
// Persistence exists for exactly four reasons, all of them Gate 3 requirements:
//   - duplicate detection by stable business identifier;
//   - a receipt that survives a payer restart;
//   - reconciliation of an ambiguous outcome;
//   - a response that is byte-stable across replays.
//
// ponytail: one collection, doc id = the provider's business identifier.
// Duplicate detection is then a primary-key collision, not a query.

import { createHash, randomUUID } from 'node:crypto'
import { Firestore } from '@google-cloud/firestore'
import { packetHash } from './canonical.js'
import {
  CANONICAL_AUTHORIZATION_REFERENCE,
  CANONICAL_WORKFLOW_ID,
  EXTENDED_VALID_THROUGH,
  INITIAL_VALID_THROUGH,
  VALID_FROM,
} from './fixture.js'

export const DB_ID = process.env.PAYER_FIRESTORE_DATABASE ?? 'wellauth-payer'
export const COLLECTION = 'northstar_submissions'

/** Response scenarios. Selected only by an explicit test header. */
export const MODES = [
  'approved',
  'rejected',
  'pending',
  'accept-then-disconnect',
  'transport-failure',
]

let db
function firestore() {
  db ??= new Firestore({
    projectId: process.env.GCP_PROJECT ?? 'preflight-hackathon',
    databaseId: DB_ID,
    // Defence in depth: a single undefined field must never crash the payer
    // mid-transaction and turn a decided outcome into a transport ambiguity.
    ignoreUndefinedProperties: true,
  })
  return db
}

const docRef = (identifier) =>
  firestore().collection(COLLECTION).doc(
    // Business identifiers are provider-minted and opaque, but they still must
    // not be able to escape the collection via a path separator.
    createHash('sha256').update(identifier).digest('hex').slice(0, 40),
  )

const nowIso = () => new Date().toISOString()

/**
 * Records an inbound submission, or recognises it as a replay.
 *
 * Runs in a Firestore transaction keyed on the provider's stable business
 * identifier: two concurrent deliveries of the same logical authorization
 * produce ONE record, and the second is reported as a duplicate rather than
 * creating a second authorization. This is the payer-side half of
 * exactly-once; the provider holds the other half.
 */
export async function recordSubmission({ identifier, claim, bundle, mode, correlationId }) {
  const ref = docRef(identifier)
  // Hash of exactly what arrived, computed with the SAME canonical
  // serialization the provider used. A hash over JSON.stringify of a re-parsed
  // object depends on key order and would never match, making the "is this the
  // artifact I sent?" check useless.
  const requestHash = packetHash(bundle)

  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      const existing = snap.data()
      // A replay never re-decides. The original outcome is authoritative, so
      // one approval can never become two, or an approval become a rejection.
      tx.update(ref, {
        replayCount: (existing.replayCount ?? 0) + 1,
        lastSeenAt: nowIso(),
      })
      return { record: existing, duplicate: true }
    }

    const record = {
      receiptId: `NS-RCPT-${randomUUID()}`,
      identifier,
      // Payer's own authorization number, minted once and never re-minted.
      authorizationNumber: authorizationNumberFor(identifier),
      mode,
      requestHash,
      // Bounded echo only -- the payer records WHAT was asked for, not the
      // whole clinical bundle, and never the supporting narrative.
      claimIdentifier: identifier,
      patientReference: claim.patient?.reference ?? null,
      itemCount: claim.item?.length ?? 0,
      supportingInfoCount: claim.supportingInfo?.length ?? 0,
      receivedAt: nowIso(),
      // Authoritative validity end for this authorization. Act II extends
      // exactly this field, and only through the bounded remediation route.
      validThrough: INITIAL_VALID_THROUGH,
      extension: null,
      replayCount: 0,
      correlationId,
      simulated: true,
    }
    record.response = buildResponse(record)
    tx.create(ref, record)
    return { record, duplicate: false }
  })
}

/** Reconciliation lookup by the provider's stable business identifier. */
export async function findByIdentifier(identifier) {
  const snap = await docRef(identifier).get()
  return snap.exists ? snap.data() : null
}

/** The durable receipt, independent of whether the response was delivered. */
export function receiptFor(record) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'receiptId', valueString: record.receiptId },
      { name: 'claimIdentifier', valueString: record.claimIdentifier },
      { name: 'authorizationNumber', valueString: record.authorizationNumber },
      { name: 'requestHash', valueString: record.requestHash },
      { name: 'receivedAt', valueInstant: record.receivedAt },
      { name: 'replayCount', valueInteger: record.replayCount ?? 0 },
      { name: 'simulated', valueBoolean: true },
    ],
  }
}

export const claimResponseFor = (record) => record.response ?? buildResponse(record)

/**
 * PAS response bundle -- what Claim/$submit actually returns.
 *
 * The official PAS 2.2.1 OperationDefinition declares Claim/$submit as
 * returning a Bundle, and profile-pas-response-bundle requires
 * Bundle.type=collection, a Bundle.identifier, a Bundle.timestamp, and a
 * sliced first entry whose resource is the ClaimResponse (min=1, max=1).
 *
 * The stored record still holds the bare ClaimResponse: that is the payer's
 * decision, and wrapping is a transport concern. Keeping the two separate
 * means reconciliation and duplicate detection are untouched by this shape.
 */
export function responseBundleFor(record) {
  const claimResponse = claimResponseFor(record)
  return {
    resourceType: 'Bundle',
    // Required by the profile, and it doubles as the join key back to the
    // provider's own submission -- the receipt id identifies this exchange.
    identifier: { system: 'urn:wellauth:northstar:receipt', value: record.receiptId },
    type: 'collection',
    timestamp: record.receivedAt,
    meta: {
      tag: [{
        system: 'urn:wellauth:payer-sim',
        code: 'simulated',
        display: 'SIMULATED PAYER -- Northstar Health Plan (fictional)',
      }],
    },
    entry: [{ resource: claimResponse }],
  }
}

/**
 * Deterministic synthetic ClaimResponse.
 *
 * `outcome` and `disposition` carry the authorization decision. Transport
 * success is expressed by HTTP status and is a different fact entirely -- a
 * rejection below still arrives as HTTP 201.
 */
function buildResponse(record) {
  const decision = {
    approved: {
      outcome: 'complete',
      disposition: 'Prior authorization approved by simulated payer',
      // PAS review action: approved.
      reviewAction: { code: 'A1', display: 'Certified in total' },
    },
    rejected: {
      outcome: 'error',
      disposition: 'Prior authorization denied by simulated payer: medical necessity criteria not met',
      reviewAction: { code: 'A3', display: 'Not certified' },
    },
    pending: {
      outcome: 'queued',
      disposition: 'Prior authorization pended for clinical review by simulated payer',
      reviewAction: { code: 'A4', display: 'Pended' },
    },
  }[record.mode] ?? {
    outcome: 'complete',
    disposition: 'Prior authorization approved by simulated payer',
    reviewAction: { code: 'A1', display: 'Certified in total' },
  }

  return {
    resourceType: 'ClaimResponse',
    id: record.receiptId,
    meta: {
      tag: [{
        system: 'urn:wellauth:payer-sim',
        code: 'simulated',
        display: 'SIMULATED PAYER -- Northstar Health Plan (fictional)',
      }],
    },
    identifier: [
      { system: 'urn:wellauth:northstar:receipt', value: record.receiptId },
      { system: 'urn:wellauth:northstar:authorization', value: record.authorizationNumber },
    ],
    status: 'active',
    type: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/claim-type',
        code: 'institutional',
      }],
    },
    use: 'preauthorization',
    patient: { reference: record.patientReference },
    created: record.receivedAt,
    insurer: { display: 'Northstar Health Plan (fictional synthetic payer)' },
    // Echoes the provider's business identifier so provider and payer can
    // always be joined on one stable key.
    request: { identifier: { system: 'urn:wellauth:claim', value: record.claimIdentifier } },
    outcome: decision.outcome,
    disposition: decision.disposition,
    // A denial carries no authorization reference and no validity window.
    // These keys are OMITTED rather than set to undefined: this object is
    // persisted to Firestore, which rejects undefined values outright.
    ...(decision.outcome === 'error' ? {} : {
      preAuthRef: record.authorizationNumber,
      // Validity window. FIXED, not a rolling window from "now": the canonical
      // fixture requires the approval to end BEFORE the scheduled MRI so the
      // Act II coverage mismatch is deterministic on any day the demo runs.
      // `validThrough` on the record is the authoritative value; this echoes it.
      preAuthPeriod: {
        start: VALID_FROM,
        end: record.validThrough,
      },
    }),
    item: [{
      itemSequence: 1,
      adjudication: [{
        category: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/adjudication',
            code: 'submitted',
          }],
        },
        reason: {
          coding: [{
            system: 'https://codesystem.x12.org/005010/306',
            code: decision.reviewAction.code,
            display: decision.reviewAction.display,
          }],
        },
      }],
    }],
  }
}

/**
 * The canonical demo workflow gets the fixture's pinned authorization
 * reference so the demo reads identically every run. Anything else keeps the
 * derived value -- this pins the DEMO, it does not special-case correctness.
 */
function authorizationNumberFor(identifier) {
  if (identifier.startsWith(`WA-${CANONICAL_WORKFLOW_ID}-`)) {
    return CANONICAL_AUTHORIZATION_REFERENCE
  }
  return `NS-AUTH-${createHash('sha256')
    .update(identifier).digest('hex').slice(0, 12).toUpperCase()}`
}


/**
 * Records an authorization-window extension against an EXISTING authorization.
 *
 * This is a bounded remediation, not a generic mutation route: the caller may
 * name only the authorization it already holds and the validity end the payer
 * itself publishes. The original approval is preserved intact -- the extension
 * is written alongside it, never over it, so the workflow retains the full
 * history (initial approval -> mismatch -> remediation -> update).
 *
 * Exactly-once is the same mechanism Gate 3 proved for submission: a Firestore
 * transaction on the one record, keyed by the provider's stable identifier. A
 * replay returns the original extension and never re-decides.
 */
export async function recordExtension({
  identifier, authorizationReference, expectedValidThrough, requestedValidThrough,
  remediationHash, correlationId,
}) {
  const ref = docRef(identifier)

  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { error: 'AUTHORIZATION_NOT_FOUND' }
    const record = snap.data()

    // The authorization must be the one the caller thinks it is.
    if (record.authorizationNumber !== authorizationReference) {
      return { error: 'AUTHORIZATION_REFERENCE_MISMATCH' }
    }
    // Only an approved authorization has a window to extend.
    if (record.response?.outcome !== 'complete') {
      return { error: 'AUTHORIZATION_NOT_APPROVED' }
    }

    // Replay: return the original decision, never a second one.
    if (record.extension) {
      if (record.extension.remediationHash === remediationHash) {
        tx.update(ref, {
          extensionReplayCount: (record.extensionReplayCount ?? 0) + 1,
          lastSeenAt: nowIso(),
        })
        return { record, extension: record.extension, duplicate: true }
      }
      // A DIFFERENT remediation against an already-extended authorization is
      // not a replay -- it is a second logical change, and is refused.
      return { error: 'ALREADY_EXTENDED' }
    }

    // Compare-and-set on the validity the caller believed was current.
    if (record.validThrough !== expectedValidThrough) {
      return { error: 'VALIDITY_STATE_MISMATCH' }
    }
    // The payer publishes the permitted end date; it is not caller-chosen.
    if (requestedValidThrough !== EXTENDED_VALID_THROUGH) {
      return { error: 'REQUESTED_VALIDITY_NOT_PERMITTED' }
    }

    const extension = {
      extensionReceiptId: `NS-EXT-${randomUUID()}`,
      authorizationReference,
      previousValidThrough: record.validThrough,
      validThrough: requestedValidThrough,
      remediationHash,
      outcome: 'updated',
      receivedAt: nowIso(),
      correlationId,
      simulated: true,
    }

    tx.update(ref, {
      validThrough: requestedValidThrough,
      extension,
      extensionReplayCount: 0,
      lastSeenAt: nowIso(),
      // The ORIGINAL response object is deliberately left untouched.
    })
    return { record: { ...record, validThrough: requestedValidThrough, extension },
             extension, duplicate: false }
  })
}

/** Bounded response for an accepted extension. Never echoes clinical content. */
export function extensionResponseFor(record, extension) {
  return {
    resourceType: 'Parameters',
    meta: {
      tag: [{
        system: 'urn:wellauth:payer-sim',
        code: 'simulated',
        display: 'SIMULATED PAYER -- Northstar Health Plan (fictional)',
      }],
    },
    parameter: [
      { name: 'outcome', valueString: extension.outcome },
      { name: 'authorizationReference', valueString: extension.authorizationReference },
      { name: 'previousValidThrough', valueString: extension.previousValidThrough },
      { name: 'validThrough', valueString: extension.validThrough },
      { name: 'extensionReceiptId', valueString: extension.extensionReceiptId },
      { name: 'claimIdentifier', valueString: record.claimIdentifier },
      { name: 'simulated', valueBoolean: true },
    ],
  }
}

/**
 * Deletes the payer's record for one business identifier.
 *
 * Demo/test fixture use only, and reachable only through the payer's env-gated
 * demo route. This exists because the payer's duplicate-collapse is deliberate
 * and permanent: a replayed identifier returns the ORIGINAL decision forever,
 * so re-running the canonical demo requires explicitly clearing the prior
 * transaction rather than hoping the payer re-decides.
 */
export async function purgeSubmission(identifier) {
  await docRef(identifier).delete()
}
