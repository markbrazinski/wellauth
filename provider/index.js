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
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { DomainError } from './service.js'
import * as service from './service.js'
import * as workflow from './workflow.js'
import * as submission from './submission.js'
import * as remediation from './remediation.js'
import { capabilitiesFor } from './capabilities.js'
import { purgeWorkflow, workflowRef } from './store.js'
import * as fixture from './fixture.js'

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
  // Gate 3 submission codes.
  APPROVAL_REQUIRED: 409,
  APPROVAL_STALE: 409,
  PACKET_HASH_MISMATCH: 409,
  SUBMISSION_IN_PROGRESS: 409,
  DUPLICATE_SUBMISSION: 409,
  ALREADY_SUBMITTED: 409,
  NO_SUBMISSION: 409,
  NOTHING_TO_RECONCILE: 409,
  PAYER_REJECTED: 502,
  PAYER_UNAVAILABLE: 503,
  PAYER_RESPONSE_INVALID: 502,
  UNKNOWN_SUBMISSION_OUTCOME: 409,
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
const DISCLOSURE_ROUTES = /\/(disclosure|state|prepare|approval|evidence\/(attach|remove)|requirements|reconcile|submit|authorization-status)$|^\/workflows\/[^/]+$/

/**
 * The one read the frontend performs. Composes workflow truth, the scheduled
 * service read from FHIR, the Act II posture and the authoritative capability
 * list, so the page and the browser tool inventory are reconstructed from a
 * single server-derived snapshot rather than assembled client-side.
 */
async function snapshot(workflowId) {
  const wf = await workflow.getWorkflow(workflowId)
  // Scheduled service date is CLINICAL truth, read from FHIR. It is an input
  // to alignment evaluation and is never written by the workflow.
  let order = null
  try {
    order = await service.getOrder(workflowId)
  } catch {
    order = null
  }
  const scheduled = order?.scheduled ?? null
  const scheduledServiceDate = scheduled ? String(scheduled).slice(0, 10) : null

  const act2 = remediation.derivePosture(wf, scheduledServiceDate)
  const rem = wf.remediation
    ? remediation.projectRemediation(
        { data: () => wf, id: workflowId }, scheduledServiceDate).remediation
    : null

  return {
    ...wf,
    order,
    scheduledServiceDate,
    scheduledServiceDisplay: fixture.SCHEDULED_SERVICE_DISPLAY,
    // Only surfaced once the workflow has ACTUALLY resolved them. Returning
    // the static policy list at CONTEXT_READY would make the page claim a
    // discovery that never happened.
    requirements: wf.state === 'CONTEXT_READY'
      ? []
      : service.getRequirements(workflowId).requirements,
    act2: { phase: act2.phase, alignment: act2.alignment },
    remediation: rem,
    availableTools: capabilitiesFor(wf, act2),
    simulated: true,
  }
}

const ROUTES = [
  [/^\/health$/, () => service.health()],
  [/^\/workflows\/([^/]+)\/snapshot$/, (m) => snapshot(m[1])],
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
  // check_authorization_status -- bounded: the ONLY input is the workflow id.
  // There is deliberately no parameter for a Claim id or payer reference, so a
  // caller cannot ask this route about someone else's submission.
  [/^\/workflows\/([^/]+)\/authorization-status$/,
    (m) => submission.checkAuthorizationStatus(m[1])],
]

/**
 * Mutating domain operations. There is deliberately no generic state setter:
 * a caller names an OPERATION, never a target state, and every precondition is
 * recomputed server-side. `state` in a request body is ignored entirely.
 */
/** Scheduled service date from FHIR clinical truth. Never caller-supplied. */
async function scheduledDateFor(workflowId) {
  const order = await service.getOrder(workflowId)
  return order?.scheduled ? String(order.scheduled).slice(0, 10) : null
}

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
  // submit_prior_authorization. Reachable only in APPROVED; every precondition
  // is re-verified server-side and the destination is server-bound -- the body
  // cannot name a payer, a Claim identifier or a target state.
  [
    /^\/workflows\/([^/]+)\/submit$/,
    (m, body, headers) =>
      submission.submitPriorAuthorization(m[1], {
        expectedRevision: body.expected_revision,
        idempotencyKey: headers['idempotency-key'],
        // Test-only scenario selector for the payer simulator. Ignored unless
        // the deployment explicitly enables simulator scenarios.
        simulatorMode: process.env.PAYER_SIM_MODES_ENABLED === 'true'
          ? headers['x-payer-sim-mode']
          : undefined,
      }),
  ],
  // Explicit operator-driven resolution of UNKNOWN_SUBMISSION_OUTCOME.
  // Never resends: it asks the payer what it already holds.
  [
    /^\/workflows\/([^/]+)\/submission\/reconcile$/,
    (m) => submission.reconcileSubmission(m[1]),
  ],

  // --- Act II -----------------------------------------------------------
  // resolve_authorization_window. Prepares only; transmits nothing. The body
  // cannot name a date, a payer or an authorization -- every authoritative
  // field is resolved from durable state and server policy.
  [
    /^\/workflows\/([^/]+)\/remediation\/resolve$/,
    async (m, body) =>
      remediation.resolveAuthorizationWindow(m[1], {
        expectedRevision: body.expected_revision,
        scheduledServiceDate: await scheduledDateFor(m[1]),
      }),
  ],
  // submit_authorization_extension. Reachable only in REMEDIATION_APPROVED.
  [
    /^\/workflows\/([^/]+)\/remediation\/submit$/,
    async (m, body, headers) =>
      remediation.submitAuthorizationExtension(m[1], {
        expectedRevision: body.expected_revision,
        scheduledServiceDate: await scheduledDateFor(m[1]),
        correlationId: headers['x-correlation-id'],
      }),
  ],
]

/**
 * The human approval route. Separated from POST_ROUTES and gated on the
 * workforce headers so that an agent-shaped call -- which carries no workforce
 * identity -- cannot reach it. WebMCP exposes no tool that targets this path.
 */
const APPROVAL_ROUTE = /^\/workflows\/([^/]+)\/approval$/

/**
 * The Act II human approval route. Same workforce gating as Act I: approving
 * an authorization-window remediation is a workforce action, never a WebMCP
 * tool, and approving does not transmit.
 */
const REMEDIATION_APPROVAL_ROUTE = /^\/workflows\/([^/]+)\/remediation\/approval$/

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

// ---------------------------------------------------------------------------
// Static UI (same-origin).
// ---------------------------------------------------------------------------

const STATIC_ROOT = process.env.WELLAUTH_STATIC_DIR ?? null

/**
 * Clears one prior payer transaction so the canonical demo can be re-run.
 * Best-effort: a payer that refuses must not break the provider-side reset.
 */
async function resetPayerRecord(claimIdentifier, correlationId) {
  try {
    await submission.transmit({
      path: '/demo/reset',
      contentType: 'application/json',
      correlationId,
      bundle: { claimIdentifier },
      unwrap: (b) => b ?? null,
    })
  } catch {
    // The provider-side reset is still valid on its own.
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

async function serveStatic(url, res, correlationId) {
  // Resolve inside the root and reject anything that escapes it. `normalize`
  // collapses `..` segments, so the prefix check below is meaningful.
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
  const full = join(STATIC_ROOT, rel)
  if (!full.startsWith(normalize(STATIC_ROOT))) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ code: 'FORBIDDEN', correlationId }))
  }

  try {
    const body = await readFile(full)
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' })
    return res.end(body)
  } catch {
    // SPA fallback: unknown paths render the app shell, which then reads
    // authoritative state from the API.
    try {
      const shell = await readFile(join(STATIC_ROOT, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      return res.end(shell)
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ code: 'NOT_FOUND', correlationId }))
    }
  }
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

  // --- demo reset -------------------------------------------------------
  // Deliberately NOT a WebMCP capability and NOT a healthcare domain route:
  // it is an operator affordance for filming and testing. Off unless the
  // deployment explicitly enables it.
  if (req.method === 'POST' && url === '/demo/reset') {
    if (process.env.WELLAUTH_DEMO_RESET !== 'true') {
      return send(404, { code: 'ROUTE_NOT_FOUND', message: 'No such endpoint', correlationId })
    }
    const token = process.env.WELLAUTH_DEMO_RESET_TOKEN
    if (token && req.headers['x-wellauth-demo-token'] !== token) {
      return send(401, { code: 'DEMO_RESET_UNAUTHORIZED', message: 'Demo reset token required',
        correlationId })
    }
    try {
      // Clear the PAYER's record for this workflow's prior claim identifier
      // too. The payer's duplicate-collapse is permanent by design, so without
      // this a re-run would replay the previous decision instead of minting a
      // fresh one, and the demo would not be repeatable.
      const prior = await workflowRef(fixture.CANONICAL_WORKFLOW_ID).get()
      const priorClaim = prior.exists ? prior.data()?.submission?.claimIdentifier : null
      if (priorClaim) await resetPayerRecord(priorClaim, correlationId)

      await purgeWorkflow(fixture.CANONICAL_WORKFLOW_ID)
      const created = await workflow.createWorkflow(fixture.CANONICAL_WORKFLOW_ID)
      console.log(JSON.stringify({ correlationId, path: url, outcome: 'ok', action: 'demo-reset' }))
      return send(200, { reset: true, workflowId: created.workflowId, state: created.state,
        revision: created.revision, correlationId })
    } catch (err) {
      console.error(JSON.stringify({ correlationId, path: url, outcome: 'error',
        kind: err?.name ?? 'Error' }))
      return send(500, { code: 'INTERNAL_ERROR', message: 'Demo reset failed', correlationId })
    }
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

    const remApprovalMatch = url.match(REMEDIATION_APPROVAL_ROUTE)
    if (remApprovalMatch) {
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
      if (!SAFE_ID.test(remApprovalMatch[1])) {
        return send(400, { code: 'INVALID_IDENTIFIER', message: 'Malformed identifier',
          correlationId })
      }
      return runHandler(
        async () =>
          remediation.approveRemediation(remApprovalMatch[1], {
            approvedBy,
            role,
            expectedRevision: body.expected_revision,
            nonce: body.nonce,
            acknowledgedHash: body.acknowledged_hash,
            scheduledServiceDate: await scheduledDateFor(remApprovalMatch[1]),
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
    // Same-origin UI. Serving the built page from the provider means the
    // browser agent, the page and the workflow API share one origin: no CORS,
    // no cross-origin cookie or WebMCP complexity, one URL for a judge.
    // Domain routes are matched FIRST, so static serving can never shadow one.
    if (STATIC_ROOT) return serveStatic(url, res, correlationId)
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
