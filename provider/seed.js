// Seeds the synthetic hero fixture into the Cloud Healthcare FHIR R4 store.
//
// Run with WRITE-capable credentials (a human operator / ADC), NOT the provider
// service account -- that one is read-only by design and must stay that way.
//
//   node provider/seed.js
//
// Resources are PUT one at a time in dependency order. The store enforces
// referential integrity, so a transaction Bundle with forward references is
// rejected; ordered individual writes are the simpler path.

import { readFileSync } from 'node:fs'
import { GoogleAuth } from 'google-auth-library'
import { CONFIG, STORE_PATH } from './fhir.js'

const bundle = JSON.parse(
  readFileSync(new URL('./fixtures/seed.json', import.meta.url), 'utf8'),
)

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
const client = await auth.getClient()
const BASE = `https://healthcare.googleapis.com/v1/${STORE_PATH}/fhir`

// ServiceRequest references Condition/wellauth-condition-001, so Conditions
// must land before it; everything else follows plain parent-before-child order.
const ORDER = [
  'Patient',
  'Practitioner',
  'Organization',
  'PractitionerRole',
  'Condition',
  'Coverage',
  'DiagnosticReport',
  'Observation',
  'DocumentReference',
  'ServiceRequest',
]

const entries = [...bundle.entry].sort(
  (a, b) =>
    ORDER.indexOf(a.resource.resourceType) - ORDER.indexOf(b.resource.resourceType),
)

let ok = 0
for (const entry of entries) {
  const { resourceType, id } = entry.resource
  const token = await client.getAccessToken()
  const res = await fetch(`${BASE}/${resourceType}/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token.token ?? token}`,
      'Content-Type': 'application/fhir+json',
      Accept: 'application/fhir+json',
    },
    body: JSON.stringify(entry.resource),
  })
  const out = await res.json()
  if (!res.ok) {
    console.error(`FAIL ${resourceType}/${id} (${res.status})`)
    console.error(JSON.stringify(out.issue ?? out, null, 2).slice(0, 1200))
    process.exit(1)
  }
  ok += 1
  console.log(`  ${resourceType}/${id} -> v${out.meta?.versionId}`)
}

console.log(`\nSeeded ${ok} resources into ${CONFIG.dataset}/${CONFIG.fhirStore} (${CONFIG.fhirVersion})`)
