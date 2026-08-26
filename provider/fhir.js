// Thin FHIR R4 read client for Google Cloud Healthcare API.
// ponytail: google-auth-library + fetch. No FHIR SDK -- we issue a handful of
// server-defined reads, not a general-purpose FHIR client.

import { GoogleAuth } from 'google-auth-library'

export const CONFIG = {
  projectId: process.env.GCP_PROJECT ?? 'preflight-hackathon',
  location: process.env.GCP_LOCATION ?? 'us-central1',
  dataset: process.env.FHIR_DATASET ?? 'wellauth',
  fhirStore: process.env.FHIR_STORE ?? 'wellauth-r4',
  fhirVersion: 'R4 (4.0.1)',
}

export const STORE_PATH =
  `projects/${CONFIG.projectId}/locations/${CONFIG.location}` +
  `/datasets/${CONFIG.dataset}/fhirStores/${CONFIG.fhirStore}`

const BASE = `https://healthcare.googleapis.com/v1/${STORE_PATH}/fhir`

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
})
let clientPromise

function client() {
  clientPromise ??= auth.getClient()
  return clientPromise
}

/** Raised for anything the FHIR layer could not answer. Carries a stable code. */
export class FhirError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let res
  try {
    const c = await client()
    const token = await c.getAccessToken()
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.token ?? token}`,
        Accept: 'application/fhir+json',
        ...(body ? { 'Content-Type': 'application/fhir+json' } : {}),
        ...headers,
      },
      body,
    })
  } catch (cause) {
    // Transport/credential failure -- never surfaced as "not found".
    throw new FhirError('FHIR_UNAVAILABLE', 'FHIR backend unreachable', {
      retryable: true,
      cause,
    })
  }

  if (res.status === 404) {
    throw new FhirError('FHIR_NOT_FOUND', 'Resource not present', { status: 404 })
  }
  if (!res.ok) {
    // Deliberately does not echo the FHIR OperationOutcome to the caller.
    throw new FhirError('FHIR_UNAVAILABLE', `FHIR request failed (${res.status})`, {
      retryable: res.status >= 500 || res.status === 429,
      status: res.status,
    })
  }

  let json
  try {
    json = await res.json()
  } catch {
    throw new FhirError('FHIR_RESPONSE_INVALID', 'FHIR response was not valid JSON')
  }
  return { json, etag: res.headers.get('etag') }
}

/** Read one resource by type+id. Server-supplied ids only -- never caller input. */
export async function read(resourceType, id) {
  const { json, etag } = await request(`/${resourceType}/${id}`)
  if (json.resourceType !== resourceType) {
    throw new FhirError('FHIR_RESPONSE_INVALID', 'Unexpected resourceType in response')
  }
  return { resource: json, etag }
}

/**
 * Search with a server-constructed parameter map. The signature takes an object,
 * not a query string, so a raw FHIR query can never be threaded through.
 */
export async function search(resourceType, params) {
  const qs = new URLSearchParams(params).toString()
  const { json } = await request(`/${resourceType}?${qs}`)
  if (json.resourceType !== 'Bundle') {
    throw new FhirError('FHIR_RESPONSE_INVALID', 'Expected a Bundle')
  }
  return (json.entry ?? []).map((e) => e.resource).filter(Boolean)
}

/** Capability statement read, used by /health to prove the store is real. */
export async function metadata() {
  const { json } = await request('/metadata')
  return json
}
