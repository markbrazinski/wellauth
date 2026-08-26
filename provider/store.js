// Firestore-backed workflow store. Authoritative for WellAuth WORKFLOW state.
//
// Why Firestore and not FHIR: Gate 1 established that Cloud Healthcare FHIR
// search is not read-after-write consistent (direct reads are; the search index
// lags). Workflow transitions therefore must never be written to FHIR and then
// observed via search. FHIR stays authoritative for CLINICAL truth; this store
// is authoritative for workflow truth. The two are joined by exact
// resourceType/id/versionId triples, never by copying clinical content.
//
// ponytail: one collection, one doc per workflow, bindings/manifests as
// subcollections. No repository pattern, no entity mapper -- the transaction
// bodies in workflow.js are the only readers/writers.

import { Firestore } from '@google-cloud/firestore'

export const DB_ID = process.env.FIRESTORE_DATABASE ?? 'wellauth-workflow'
export const COLLECTION = 'wellauth_workflows'

let db
export function firestore() {
  db ??= new Firestore({
    projectId: process.env.GCP_PROJECT ?? 'preflight-hackathon',
    databaseId: DB_ID,
  })
  return db
}

export const workflowRef = (workflowId) => firestore().collection(COLLECTION).doc(workflowId)
export const bindingRef = (workflowId, requirementId) =>
  workflowRef(workflowId).collection('bindings').doc(requirementId)
export const bindingsCol = (workflowId) => workflowRef(workflowId).collection('bindings')
/** Manifests are append-only: one immutable doc per prepared revision. */
export const manifestRef = (workflowId, manifestRevision) =>
  workflowRef(workflowId).collection('manifests').doc(String(manifestRevision))
/** Handle registry: opaque evidence handle -> exact scoped source reference. */
export const handleRef = (workflowId, handle) =>
  workflowRef(workflowId).collection('handles').doc(handle)
/** Idempotency + transition ledger, keyed by caller-supplied key. */
export const idemRef = (workflowId, key) =>
  workflowRef(workflowId).collection('idempotency').doc(key)
export const ledgerCol = (workflowId) => workflowRef(workflowId).collection('transitions')

/** Deletes a workflow and its subcollections. Test-fixture use only. */
export async function purgeWorkflow(workflowId) {
  const ref = workflowRef(workflowId)
  for (const name of ['bindings', 'manifests', 'handles', 'idempotency', 'transitions']) {
    const snap = await ref.collection(name).get()
    await Promise.all(snap.docs.map((d) => d.ref.delete()))
  }
  await ref.delete()
}
