// Northstar Health Plan -- SIMULATED PAYER.
//
// FICTIONAL. This service is not a payer, not a clearinghouse, and not
// connected to any real plan. It exists to give WellAuth a genuine service
// boundary to cross: separate Cloud Run service, separate service account,
// separate origin, separate Firestore namespace. A provider-local write is
// not a submission; this is what makes the submission real.
//
// It accepts exactly one operation -- POST /Claim/$submit -- and refuses to be
// a general FHIR proxy. There is no resource-type parameter, no search, no
// arbitrary read: the only lookup is by a business identifier the provider
// already minted, which is what reconciliation needs and nothing more.
//
// ponytail: node:http, one route table, Firestore for durability. No FHIR
// server, no framework -- this simulates a payer endpoint, it does not need
// to be one.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  MODES,
  claimResponseFor,
  findByIdentifier,
  receiptFor,
  recordSubmission,
} from './store.js'

const PORT = Number(process.env.PORT ?? 8080)

/** Marker stamped on every artifact this service produces. */
export const SIMULATOR_MARKER = 'SIMULATED PAYER -- Northstar Health Plan (fictional)'

const send = (res, status, payload, correlationId) => {
  res.writeHead(status, {
    'Content-Type': 'application/fhir+json',
    'X-Payer-Simulation': 'true',
    'X-Correlation-Id': correlationId,
  })
  res.end(JSON.stringify(payload))
}

/** OperationOutcome -- the FHIR-shaped refusal. Never echoes request content. */
const outcome = (severity, code, diagnostics) => ({
  resourceType: 'OperationOutcome',
  issue: [{ severity, code, diagnostics }],
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Structural validation of an inbound PAS-shaped request Bundle.
 *
 * Deliberately strict about the things that make this a prior-authorization
 * request at all. A payer that accepted anything would prove nothing about
 * what WellAuth actually sends.
 */
export function validateRequest(bundle) {
  const problems = []
  if (bundle?.resourceType !== 'Bundle') problems.push('expected a Bundle')
  if (bundle?.type !== 'collection') problems.push('expected Bundle.type = collection')

  const entries = bundle?.entry ?? []
  const claim = entries[0]?.resource
  if (claim?.resourceType !== 'Claim') {
    problems.push('first Bundle entry must be a Claim')
    return { ok: false, problems, claim: null }
  }
  if (claim.use !== 'preauthorization') problems.push('Claim.use must be preauthorization')
  if (!claim.patient?.reference) problems.push('Claim.patient is required')
  if (!claim.insurance?.length) problems.push('Claim.insurance is required')
  if (!claim.item?.length) problems.push('Claim.item is required')
  if (!claim.provider?.reference) problems.push('Claim.provider is required')

  // The stable business identifier is what makes duplicate detection and
  // reconciliation possible. Without it we cannot honour exactly-once.
  const identifier = (claim.identifier ?? []).find((i) => i.value)
  if (!identifier) problems.push('Claim.identifier is required for idempotent submission')

  // Every referenced resource must actually be in the bundle -- a payer cannot
  // resolve a provider-local reference, so a dangling one is a real defect.
  const present = new Set(
    entries.map((e) => e.resource && `${e.resource.resourceType}/${e.resource.id}`).filter(Boolean),
  )
  const refs = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'reference' && typeof v === 'string' && !v.startsWith('#')) refs.push(v)
        else walk(v)
      }
    }
  }
  walk(bundle)
  const dangling = [...new Set(refs)].filter((r) => !present.has(r))
  if (dangling.length) problems.push(`unresolvable references: ${dangling.join(', ')}`)

  return { ok: problems.length === 0, problems, claim, identifier: identifier?.value ?? null }
}

/**
 * Response mode. Test-controlled ONLY via an explicit header, so the canonical
 * path is always the honest approved path and a scenario can never be selected
 * by anything inside the clinical payload.
 */
function modeFor(req) {
  const requested = req.headers['x-payer-sim-mode']
  return MODES.includes(requested) ? requested : 'approved'
}

const server = createServer(async (req, res) => {
  const correlationId = randomUUID()
  const url = req.url.split('?')[0]

  // --- reconciliation lookup: by business identifier, nothing else ---------
  // This is NOT a search endpoint. It resolves one exact provider-minted
  // identifier to its receipt, which is precisely what an ambiguous outcome
  // needs and no more. There is no query, no resource type, no patient param.
  const lookup = url.match(/^\/Claim\/\$status\/([A-Za-z0-9_.:-]{1,128})$/)
  if (lookup && req.method === 'GET') {
    const found = await findByIdentifier(lookup[1])
    console.log(JSON.stringify({
      correlationId, route: 'status', outcome: found ? 'found' : 'not-found',
    }))
    if (!found) {
      return send(res, 404, outcome('error', 'not-found', 'No such submission'), correlationId)
    }
    return send(res, 200, {
      ...receiptFor(found),
      response: found.response ?? null,
    }, correlationId)
  }

  if (url === '/health' && req.method === 'GET') {
    return send(res, 200, {
      status: 'ok',
      service: 'wellauth-payer-simulator',
      simulated: true,
      marker: SIMULATOR_MARKER,
    }, correlationId)
  }

  if (url !== '/Claim/$submit' || req.method !== 'POST') {
    // No generic proxying, no resource routes, no search.
    console.log(JSON.stringify({ correlationId, route: 'unknown', outcome: 'refused' }))
    return send(res, 404, outcome('error', 'not-supported',
      'This simulated payer accepts only POST /Claim/$submit'), correlationId)
  }

  let bundle
  try {
    bundle = await readBody(req)
  } catch {
    return send(res, 400, outcome('error', 'structure', 'Malformed request body'), correlationId)
  }

  const mode = modeFor(req)
  const validation = validateRequest(bundle)

  if (!validation.ok) {
    // A structurally invalid request is never recorded as accepted: the
    // provider must be able to trust that this outcome means "not received".
    console.log(JSON.stringify({
      correlationId, route: 'submit', outcome: 'rejected-invalid',
      problemCount: validation.problems.length,
    }))
    return send(res, 400, outcome('error', 'invalid',
      `Prior authorization request failed validation: ${validation.problems.join('; ')}`),
      correlationId)
  }

  // --- transport-failure-before-acceptance --------------------------------
  // Deliberately refuses BEFORE persisting anything, so the provider may
  // safely conclude the request was not received (P0.13).
  if (mode === 'transport-failure') {
    console.log(JSON.stringify({
      correlationId, route: 'submit', outcome: 'refused-before-persist',
    }))
    // The payer is the only party that KNOWS whether it persisted anything.
    // On this path it provably did not, so it says so explicitly rather than
    // leaving the provider to guess from a status code. Without this header a
    // 5xx stays ambiguous, which is the safe default.
    res.writeHead(503, {
      'Content-Type': 'application/fhir+json',
      'X-Payer-Not-Recorded': 'true',
    })
    return res.end(JSON.stringify(
      outcome('error', 'transient', 'Simulated payer temporarily unavailable')))
  }

  // Persist first, respond second. Duplicate detection is by the provider's
  // stable business identifier, so a replay is recognised as the SAME logical
  // authorization rather than a second one.
  const { record, duplicate } = await recordSubmission({
    identifier: validation.identifier,
    claim: validation.claim,
    bundle,
    mode,
    correlationId,
  })

  console.log(JSON.stringify({
    correlationId, route: 'submit', outcome: duplicate ? 'duplicate' : 'accepted',
    receiptId: record.receiptId, mode,
  }))

  // --- accept-then-disconnect ---------------------------------------------
  // The request IS persisted above. The socket is then destroyed without a
  // response, so the provider genuinely cannot tell whether the payer received
  // it -- which is the whole point of UNKNOWN_SUBMISSION_OUTCOME (P0.14).
  if (mode === 'accept-then-disconnect') {
    return req.socket.destroy()
  }

  const response = claimResponseFor(record)
  // HTTP 200 means "received and processed", never "authorized". The
  // authorization decision lives in ClaimResponse.outcome/disposition.
  return send(res, duplicate ? 200 : 201, {
    ...response,
    ...(duplicate ? { meta: { ...(response.meta ?? {}), tag: [
      ...(response.meta?.tag ?? []),
      { system: 'urn:wellauth:payer-sim', code: 'duplicate-of-prior-submission' },
    ] } } : {}),
  }, correlationId)
})

server.listen(PORT, () => {
  console.log(`wellauth-payer-simulator (SIMULATED) listening on :${PORT}`)
})
