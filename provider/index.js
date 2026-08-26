// WellAuth provider service -- Gate 1.
//
// Only bounded domain routes exist. There is deliberately no route that accepts
// a FHIR query, a resource type, a raw id, or a patient id: the path parameters
// are opaque workflow/requirement/evidence identifiers, and everything else is
// resolved server-side.
//
// ponytail: node:http again -- four routes, no framework.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DomainError } from './service.js'
import * as service from './service.js'

const PORT = Number(process.env.PORT ?? 8080)

const HTTP_STATUS = {
  WORKFLOW_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  REQUIREMENT_NOT_FOUND: 404,
  COVERAGE_NOT_FOUND: 404,
  AMBIGUOUS_COVERAGE: 409,
  CONTEXT_MISMATCH: 403,
  FHIR_UNAVAILABLE: 503,
  FHIR_RESPONSE_INVALID: 502,
}

// Opaque-id shape guard. Nothing that reaches the domain layer can carry a FHIR
// query fragment, a slash-path, or a resource type.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

const ROUTES = [
  [/^\/health$/, () => service.health()],
  [/^\/workflows\/([^/]+)\/order$/, (m) => service.getOrder(m[1])],
  [/^\/workflows\/([^/]+)\/requirements$/, (m) => service.getRequirements(m[1])],
  [
    /^\/workflows\/([^/]+)\/requirements\/([^/]+)\/evidence$/,
    (m) => service.findEvidence(m[1], m[2]),
  ],
  [
    /^\/workflows\/([^/]+)\/evidence\/([^/]+)$/,
    (m) => service.getEvidenceDetail(m[1], m[2]),
  ],
]

const server = createServer(async (req, res) => {
  const correlationId = randomUUID()
  const url = req.url.split('?')[0]

  const send = (status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
    })
    res.end(JSON.stringify(payload))
  }

  if (req.method !== 'GET') {
    // Gate 1 is read-only. No verb that could mutate clinical truth is routed.
    return send(405, { code: 'METHOD_NOT_ALLOWED', message: 'Read-only service', correlationId })
  }

  const match = ROUTES.map(([re, fn]) => [url.match(re), fn]).find(([m]) => m)
  if (!match) {
    return send(404, { code: 'ROUTE_NOT_FOUND', message: 'No such endpoint', correlationId })
  }

  const [m, handler] = match
  const params = m.slice(1)
  if (params.some((p) => !SAFE_ID.test(p))) {
    return send(400, { code: 'INVALID_IDENTIFIER', message: 'Malformed identifier', correlationId })
  }

  try {
    const result = await handler(m)
    // Log the operation, never the payload -- no clinical content reaches logs.
    console.log(
      JSON.stringify({ correlationId, path: url, outcome: 'ok', status: result.status ?? 'ok' }),
    )
    send(200, { ...result, correlationId })
  } catch (err) {
    if (err instanceof DomainError) {
      console.log(
        JSON.stringify({ correlationId, path: url, outcome: 'refused', code: err.code }),
      )
      return send(HTTP_STATUS[err.code] ?? 400, {
        code: err.code,
        message: err.message,
        retryable: Boolean(err.retryable),
        correlationId,
      })
    }
    // Unexpected: log the class only, and never return a stack to the caller.
    console.error(
      JSON.stringify({ correlationId, path: url, outcome: 'error', kind: err?.name ?? 'Error' }),
    )
    send(500, {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected provider error',
      retryable: true,
      correlationId,
    })
  }
})

server.listen(PORT, () => {
  console.log(`WellAuth provider service listening on :${PORT}`)
})
