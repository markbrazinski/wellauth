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
      authorizationNumber: `NS-AUTH-${createHash('sha256')
        .update(identifier).digest('hex').slice(0, 12).toUpperCase()}`,
      mode,
      requestHash,
      // Bounded echo only -- the payer records WHAT was asked for, not the
      // whole clinical bundle, and never the supporting narrative.
      claimIdentifier: identifier,
      patientReference: claim.patient?.reference ?? null,
      itemCount: claim.item?.length ?? 0,
      supportingInfoCount: claim.supportingInfo?.length ?? 0,
      receivedAt: nowIso(),
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
      // Validity window is recorded because Act II will need it. Gate 3
      // persists it and does nothing else -- no extension mechanics invented.
      preAuthPeriod: {
        start: record.receivedAt.slice(0, 10),
        end: addDays(record.receivedAt, 90),
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

function addDays(iso, days) {
  const d = new Date(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
