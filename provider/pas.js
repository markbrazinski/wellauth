// PAS request compilation.
//
// WHAT THIS IS
//   Compiles the frozen, hashed, version-exact Gate 2 manifest
//   (WellAuthPreparedSubmission/1) into a FHIR R4 PAS-SHAPED request Bundle
//   whose first entry is a Claim with use = preauthorization.
//
// WHAT THIS IS NOT
//   Not X12 278. Not a clearinghouse transaction. Not a claim of Da Vinci PAS
//   conformance -- see docs/GATE-3-PAS-VALIDATION.md for exactly what was
//   validated and what was not. The honest claim is "PAS-shaped"; anything
//   stronger requires the validator output to support it.
//
// MINIMUM NECESSARY
//   The bundle contains exactly: the Claim, the patient, the requesting
//   practitioner + role + organization, the payer organization, the coverage,
//   and the resources bound to the five requirements. Nothing else. The decoy
//   resources that exist in the FHIR store to make evidence selection non-
//   trivial must never appear here, and P0.18 asserts their absence.
//
// The compiler reads the MANIFEST for what to include -- never the live store
// -- so a source that changed after approval cannot silently enter the packet.
// Freshness is a precondition checked before compilation, not a filter here.

import * as fhir from './fhir.js'
import { packetHash } from './canonical.js'

/** Business-identifier system for the provider-minted Claim identifier. */
export const CLAIM_IDENTIFIER_SYSTEM = 'urn:wellauth:claim'

/**
 * Fields stripped from a source resource before disclosure.
 *
 * `text` is the FHIR narrative -- human-readable prose that frequently repeats
 * the entire clinical note. It is not required for adjudication and it is the
 * single largest over-disclosure risk in a PA packet, so it is removed.
 */
const STRIP = ['text', 'meta', 'contained', 'implicitRules', 'language']

function minimize(resource) {
  const out = {}
  for (const [k, v] of Object.entries(resource)) {
    if (STRIP.includes(k)) continue
    out[k] = v
  }
  // Retain the exact version the packet was frozen against -- this is the
  // provenance that makes the disclosure auditable.
  out.meta = { versionId: resource.meta?.versionId ?? null }
  return out
}

/**
 * DocumentReference attachments are the one place raw clinical narrative can
 * ride along as base64. The requirement is satisfied by the document's
 * existence, code, status and date -- not by its bytes -- so the payload is
 * replaced by its provenance. A payer that needs the document requests it.
 */
function minimizeDocumentReference(resource) {
  const out = minimize(resource)
  out.content = (resource.content ?? []).map((c) => ({
    attachment: {
      contentType: c.attachment?.contentType ?? null,
      title: c.attachment?.title ?? null,
      creation: c.attachment?.creation ?? null,
      // deliberately: no `data`, no `url`
    },
  }))
  return out
}

const minimizers = { DocumentReference: minimizeDocumentReference }
const minimizeFor = (r) => (minimizers[r.resourceType] ?? minimize)(r)

/**
 * The stable business identifier for one logical authorization request.
 *
 * Derived from workflow + packet hash, so:
 *   - a replay of the same approved packet yields the SAME identifier and the
 *     payer recognises a duplicate (P0.10/P0.11);
 *   - a genuinely different packet yields a different identifier and is a
 *     different authorization.
 * It is never randomly generated, which is what makes retry safe.
 */
export function claimIdentifier(workflowId, hash) {
  return `WA-${workflowId}-${hash.replace(/^sha256:/, '').slice(0, 24)}`
}

/**
 * Compiles the PAS-shaped request Bundle.
 *
 * @param manifest  the frozen Gate 2 disclosure manifest
 * @param sources   Map of "Type/id" -> exact resource read at the frozen version
 */
export function compilePasBundle({ manifest, sources, workflowId }) {
  const hash = manifest.packetHash
  const identifier = claimIdentifier(workflowId, hash)

  const patientId = manifest.patientContextRef.split('/')[1]
  const patient = sources.get(manifest.patientContextRef)
  const order = sources.get(`ServiceRequest/${manifest.order.id}`)
  const coverage = sources.get(`Coverage/${manifest.coverage.id}`)

  // The requesting practitioner comes from the ORDER, not from a caller.
  const practitionerRef = order.requester?.reference ?? null
  const practitioner = practitionerRef ? sources.get(practitionerRef) : null
  const practitionerRole = [...sources.values()].find((r) => r.resourceType === 'PractitionerRole')
  const providerOrgRef = practitionerRole?.organization?.reference ?? null
  const providerOrg = providerOrgRef ? sources.get(providerOrgRef) : null
  const payerOrgRef = coverage.payor?.[0]?.reference ?? null
  const payerOrg = payerOrgRef ? sources.get(payerOrgRef) : null

  // Supporting information: one entry per satisfied requirement, each pointing
  // at the exact evidence resource and naming the requirement it satisfies.
  const supportingInfo = manifest.items.map((item, i) => ({
    sequence: i + 1,
    category: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/claiminformationcategory',
        code: 'info',
        display: 'Information',
      }],
      text: item.requirementId,
    },
    valueReference: { reference: `${item.resourceType}/${item.resourceId}` },
  }))

  const claim = {
    resourceType: 'Claim',
    id: `wellauth-pa-${hash.replace(/^sha256:/, '').slice(0, 16)}`,
    meta: {
      tag: [{
        system: 'urn:wellauth:submission',
        code: 'synthetic',
        display: 'Synthetic prior authorization -- simulated payer',
      }],
    },
    // Stable business identifier: the exactly-once join key.
    identifier: [{ system: CLAIM_IDENTIFIER_SYSTEM, value: identifier }],
    status: 'active',
    type: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/claim-type',
        code: 'institutional',
        display: 'Institutional',
      }],
    },
    // The whole point: this is a prior-authorization request, not a claim.
    use: 'preauthorization',
    patient: { reference: manifest.patientContextRef },
    created: manifest.preparedAt ?? new Date().toISOString(),
    provider: { reference: providerOrgRef ?? practitionerRef },
    priority: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/processpriority',
        code: order.priority === 'stat' ? 'stat' : 'normal',
      }],
    },
    insurer: { reference: payerOrgRef },
    insurance: [{
      sequence: 1,
      focal: true,
      coverage: { reference: `Coverage/${manifest.coverage.id}` },
    }],
    supportingInfo,
    // The ordered service, unchanged. WellAuth never alters clinical intent to
    // satisfy a payer -- the code, quantity and date come from the order.
    item: [{
      sequence: 1,
      productOrService: order.code,
      ...(order.occurrenceDateTime ? { servicedDate: order.occurrenceDateTime.slice(0, 10) } : {}),
      ...(providerOrgRef ? { provider: { reference: providerOrgRef } } : {}),
      // Ties the requested service back to the evidence supporting it.
      informationSequence: supportingInfo.map((s) => s.sequence),
    }],
  }

  // Diagnosis: taken from the order's stated reason. This is the clinician's
  // existing documented reason, NOT an inference -- WellAuth does not diagnose.
  const reasonRef = order.reasonReference?.[0]?.reference
  const reason = reasonRef ? sources.get(reasonRef) : null
  if (reason?.code) {
    claim.diagnosis = [{
      sequence: 1,
      diagnosisCodeableConcept: reason.code,
    }]
  }

  // Bundle membership: the Claim plus exactly the resources it references.
  const referenced = [
    patient,
    practitioner,
    practitionerRole,
    providerOrg,
    payerOrg,
    coverage,
    ...manifest.items.map((i) => sources.get(`${i.resourceType}/${i.resourceId}`)),
    reason,
  ].filter(Boolean)

  // Deduplicate on Type/id; a resource may be both evidence and a reference
  // target (Coverage satisfies req-005 and is the insurance).
  const seen = new Set()
  const entry = [{ resource: claim }]
  for (const r of referenced) {
    const key = `${r.resourceType}/${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    entry.push({ resource: minimizeFor(r) })
  }

  const bundle = {
    resourceType: 'Bundle',
    id: `wellauth-pa-bundle-${hash.replace(/^sha256:/, '').slice(0, 16)}`,
    meta: {
      tag: [{
        system: 'urn:wellauth:submission',
        code: 'synthetic',
        display: 'Synthetic prior authorization -- simulated payer',
      }],
    },
    type: 'collection',
    timestamp: manifest.preparedAt ?? new Date().toISOString(),
    entry,
  }

  return {
    bundle,
    claimIdentifier: identifier,
    // Hash of the exact outbound artifact -- distinct from the packet hash,
    // which covers the disclosure decision rather than its wire form.
    requestHash: packetHash(bundle),
    patientId,
  }
}

/**
 * Reads every source the manifest froze, at the exact frozen version.
 *
 * Uses direct version-aware reads and refuses if any version has moved: the
 * compiler must never assemble a packet from resources that differ from what
 * the human approved. Freshness is re-proven here, immediately before the
 * network call, not inherited from the approval.
 */
export async function readFrozenSources(manifest) {
  const sources = new Map()
  const stale = []

  const add = async (resourceType, id, expectedVersionId) => {
    const key = `${resourceType}/${id}`
    if (sources.has(key)) return sources.get(key)
    const { resource } = await fhir.read(resourceType, id)
    if (expectedVersionId && resource.meta?.versionId !== expectedVersionId) {
      stale.push({ what: key, expected: expectedVersionId, actual: resource.meta?.versionId })
    }
    sources.set(key, resource)
    return resource
  }

  const order = await add('ServiceRequest', manifest.order.id, manifest.order.versionId)
  const coverage = await add('Coverage', manifest.coverage.id, manifest.coverage.versionId)
  await add('Patient', manifest.patientContextRef.split('/')[1], null)

  for (const item of manifest.items) {
    await add(item.resourceType, item.resourceId, item.sourceVersionId)
  }

  // Context resources referenced by the Claim. Not evidence, so not version
  // pinned by the manifest -- but still fetched exactly, never searched.
  const follow = [
    order.requester?.reference,
    order.reasonReference?.[0]?.reference,
    coverage.payor?.[0]?.reference,
  ].filter(Boolean)
  for (const ref of follow) {
    const [t, i] = ref.split('/')
    if (t && i) await add(t, i, null)
  }

  const role = [...sources.values()].find((r) => r.resourceType === 'PractitionerRole')
  if (role?.organization?.reference) {
    const [t, i] = role.organization.reference.split('/')
    await add(t, i, null)
  }

  return { sources, stale }
}
