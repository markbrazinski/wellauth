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
import * as workflow from './workflow.js'

const PORT = Number(process.env.PORT ?? 8080)

const HTTP_STATUS = {
  // Gate 2 workflow codes.
  REVISION_CONFLICT: 409,
  EXPECTED_REVISION_REQUIRED: 400,
  REQUIREMENTS_NOT_RESOLVED: 409,
  MISSING_REQUIRED_EVIDENCE: 409,
  NOT_AWAITING_APPROVAL: 409,
  NOT_PREPARED: 409,
  NOT_BOUND: 409,
  SOURCE_STALE: 409,
  SOURCE_MISSING: 409,
  REQUIREMENT_SET_STALE: 409,
  ILLEGAL_TRANSITION: 409,
  EVIDENCE_INELIGIBLE: 422,
  EVIDENCE_REQUIREMENT_MISMATCH: 422,
  PACKET_HASH_MISMATCH: 409,
  NONCE_REQUIRED: 400,
  NONCE_ALREADY_USED: 409,
  APPROVER_IDENTITY_REQUIRED: 401,
  ROLE_NOT_PERMITTED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  OPERATION_IN_PROGRESS: 409,
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

/**
 * Evidence *discovery* speaks in opaque handles: the exact FHIR resource id
 * findEvidence carries internally must not cross the boundary there, or a
 * caller could address the store directly instead of via a scoped handle.
 *
 * The prepared disclosure is the deliberate exception -- naming the exact
 * resource type/id/version IS the disclosure, and the manifest is what the
 * payer would receive -- so those routes are not stripped.
 */
function stripHandleIds(value) {
  if (Array.isArray(value)) return value.map(stripHandleIds)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'resourceId')
        .map(([k, v]) => [k, stripHandleIds(v)]),
    )
  }
  return value
}

/** Routes whose payload legitimately names exact source resources. */
const DISCLOSURE_ROUTES = /\/(disclosure|state|prepare|approval|evidence\/(attach|remove)|requirements|reconcile)$|^\/workflows\/[^/]+$/

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
  [/^\/workflows\/([^/]+)\/state$/, (m) => workflow.getWorkflow(m[1])],
  [/^\/workflows\/([^/]+)\/disclosure$/, (m) => workflow.getPreparedDisclosure(m[1])],
]

/**
 * Mutating domain operations. There is deliberately no generic state setter:
 * a caller names an OPERATION, never a target state, and every precondition is
 * recomputed server-side. `state` in a request body is ignored entirely.
 */
const POST_ROUTES = [
  [/^\/workflows\/([^/]+)$/, (m) => workflow.createWorkflow(m[1])],
  [/^\/workflows\/([^/]+)\/requirements$/, (m) => workflow.resolveRequirements(m[1])],
  [
    /^\/workflows\/([^/]+)\/evidence\/attach$/,
    (m, body) =>
      workflow.attachEvidence(m[1], {
        requirementId: body.requirement_id,
        evidenceHandle: body.evidence_handle,
        expectedRevision: body.expected_revision,
      }),
  ],
  [
    /^\/workflows\/([^/]+)\/evidence\/remove$/,
    (m, body) =>
      workflow.removeEvidence(m[1], {
        requirementId: body.requirement_id,
        expectedRevision: body.expected_revision,
      }),
  ],
  [
    /^\/workflows\/([^/]+)\/prepare$/,
    (m, body, headers) =>
      workflow.prepareSubmission(m[1], {
        expectedRevision: body.expected_revision,
        idempotencyKey: headers['idempotency-key'],
      }),
  ],
  [
    /^\/workflows\/([^/]+)\/reconcile$/,
    (m, body) => workflow.reconcileSources(m[1], { expectedRevision: body.expected_revision }),
  ],
]

/**
 * The human approval route. Separated from POST_ROUTES and gated on the
 * workforce headers so that an agent-shaped call -- which carries no workforce
 * identity -- cannot reach it. WebMCP exposes no tool that targets this path.
 */
const APPROVAL_ROUTE = /^\/workflows\/([^/]+)\/approval$/

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 16_384) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

/** Single execution + logging + error-projection path for every route. */
async function runHandler(invoke, url, correlationId, send) {
  try {
    const result = await invoke()
    // Log the operation, never the payload -- no clinical content reaches logs.
    console.log(
      JSON.stringify({
        correlationId, path: url, outcome: 'ok',
        state: result?.state ?? result?.status ?? 'ok',
        revision: result?.revision,
      }),
    )
    const projected = DISCLOSURE_ROUTES.test(url) ? result : stripHandleIds(result)
    return send(200, { ...projected, correlationId })
  } catch (err) {
    // Only DomainError is a bounded, caller-safe refusal. Anything else -- a
    // Firestore gRPC error, a bug -- is a 500 and never leaks its detail.
    if (err instanceof DomainError) {
      console.log(JSON.stringify({ correlationId, path: url, outcome: 'refused', code: err.code }))
      return send(HTTP_STATUS[err.code] ?? 400, {
        code: err.code,
        message: err.message,
        retryable: Boolean(err.retryable),
        correlationId,
      })
    }
    console.error(
      JSON.stringify({ correlationId, path: url, outcome: 'error', kind: err?.name ?? 'Error' }),
    )
    return send(500, {
      code: 'INTERNAL_ERROR', message: 'Unexpected provider error',
      retryable: true, correlationId,
    })
  }
}

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

  if (req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return send(400, { code: 'INVALID_BODY', message: 'Malformed request body', correlationId })
    }

    const approvalMatch = url.match(APPROVAL_ROUTE)
    if (approvalMatch) {
      // Workforce identity comes from headers a browser agent does not hold.
      const approvedBy = req.headers['x-wellauth-user']
      const role = req.headers['x-wellauth-role']
      if (!approvedBy || !role) {
        console.log(JSON.stringify({ correlationId, path: url, outcome: 'refused',
          code: 'APPROVER_IDENTITY_REQUIRED' }))
        return send(401, {
          code: 'APPROVER_IDENTITY_REQUIRED',
          message: 'Approval requires an authenticated workforce user',
          correlationId,
        })
      }
      return runHandler(
        () =>
          workflow.recordApproval(approvalMatch[1], {
            approvedBy,
            role,
            expectedRevision: body.expected_revision,
            nonce: body.nonce,
            acknowledgedPacketHash: body.acknowledged_packet_hash,
            idempotencyKey: req.headers['idempotency-key'],
          }),
        url, correlationId, send,
      )
    }

    const pm = POST_ROUTES.map(([re, fn]) => [url.match(re), fn]).find(([m]) => m)
    if (!pm) {
      return send(404, { code: 'ROUTE_NOT_FOUND', message: 'No such endpoint', correlationId })
    }
    const [m, handler] = pm
    if (m.slice(1).some((p) => !SAFE_ID.test(p))) {
      return send(400, { code: 'INVALID_IDENTIFIER', message: 'Malformed identifier', correlationId })
    }
    return runHandler(() => handler(m, body, req.headers), url, correlationId, send)
  }

  if (req.method !== 'GET') {
    return send(405, { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported method', correlationId })
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

  return runHandler(() => handler(m), url, correlationId, send)
})

server.listen(PORT, () => {
  console.log(`WellAuth provider service listening on :${PORT}`)
})
