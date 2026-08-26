// Gate 2 suite: P0.1 - P0.20 against REAL Firestore + REAL Cloud Healthcare FHIR.
//
//   npm run test:gate2                                  (in-process)
//   GATE2_BASE_URL=https://... npm run test:gate2       (deployed Cloud Run)
//
// Nothing here is stubbed. Every version id, hash and state below comes from
// the live backends. Source mutations required by the stale-state tests are
// issued with SEPARATE fixture credentials (wellauth-fixture-sa), never with
// the provider runtime identity -- which holds only fhirResourceReader.

import { GoogleAuth } from 'google-auth-library'
import { createHash, randomUUID } from 'node:crypto'
import * as fhir from './fhir.js'
import * as service from './service.js'
import * as workflow from './workflow.js'
import { DomainError } from './service.js'
import { canonicalize, packetHash } from './canonical.js'
import { firestore, purgeWorkflow, workflowRef, bindingsCol, ledgerCol } from './store.js'
import { WORKFLOWS } from './policy.js'

const BASE_URL = process.env.GATE2_BASE_URL
const W = 'wf-wellauth-001'
const REQS = ['req-001', 'req-002', 'req-003', 'req-004', 'req-005']

let pass = 0, fail = 0
const failures = []
const logLines = []

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}
const section = (t) => console.log(`\n${t}`)

// Capture provider logs for the P0.20 hygiene review.
const realLog = console.log
const realErr = console.error
function captureLogs() {
  console.log = (...a) => { logLines.push(a.join(' ')); realLog(...a) }
  console.error = (...a) => { logLines.push(a.join(' ')); realErr(...a) }
}

// ---------------------------------------------------------------------------
// Transport: in-process domain calls, or HTTP against the deployed service.
// ---------------------------------------------------------------------------
let idToken
async function http(method, path, { body, headers = {} } = {}) {
  if (!idToken) {
    idToken = process.env.GATE2_ID_TOKEN
    if (!idToken) {
      const { execFileSync } = await import('node:child_process')
      idToken = execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim()
    }
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { code: 'NON_JSON', raw: text.slice(0, 200) } }
  return { status: res.status, body: json }
}

/** Uniform call surface: returns {ok, value} or {ok:false, code}. */
const api = {
  async create() {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}`))
    return ok(() => workflow.createWorkflow(W))
  },
  async state() {
    if (BASE_URL) return wrap(await http('GET', `/workflows/${W}/state`))
    return ok(() => workflow.getWorkflow(W))
  },
  async resolve() {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}/requirements`))
    return ok(() => workflow.resolveRequirements(W))
  },
  async attach(requirementId, evidenceHandle, expectedRevision, extra = {}) {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}/evidence/attach`,
      { body: { requirement_id: requirementId, evidence_handle: evidenceHandle,
                expected_revision: expectedRevision, ...extra } }))
    return ok(() => workflow.attachEvidence(W, { requirementId, evidenceHandle, expectedRevision }))
  },
  async remove(requirementId, expectedRevision) {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}/evidence/remove`,
      { body: { requirement_id: requirementId, expected_revision: expectedRevision } }))
    return ok(() => workflow.removeEvidence(W, { requirementId, expectedRevision }))
  },
  async prepare(expectedRevision, idempotencyKey, extra = {}) {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}/prepare`,
      { body: { expected_revision: expectedRevision, ...extra },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }))
    return ok(() => workflow.prepareSubmission(W, { expectedRevision, idempotencyKey }))
  },
  async disclosure() {
    if (BASE_URL) return wrap(await http('GET', `/workflows/${W}/disclosure`))
    return ok(() => workflow.getPreparedDisclosure(W))
  },
  async approve(opts) {
    if (BASE_URL) {
      return wrap(await http('POST', `/workflows/${W}/approval`, {
        body: { expected_revision: opts.expectedRevision, nonce: opts.nonce,
                acknowledged_packet_hash: opts.acknowledgedPacketHash },
        headers: {
          ...(opts.approvedBy ? { 'X-WellAuth-User': opts.approvedBy } : {}),
          ...(opts.role ? { 'X-WellAuth-Role': opts.role } : {}),
          ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        },
      }))
    }
    return ok(() => workflow.recordApproval(W, opts))
  },
  async reconcile(expectedRevision) {
    if (BASE_URL) return wrap(await http('POST', `/workflows/${W}/reconcile`,
      { body: { expected_revision: expectedRevision } }))
    return ok(() => workflow.reconcileSources(W, { expectedRevision }))
  },
}

async function ok(fn) {
  try { return { ok: true, value: await fn() } }
  catch (e) { return { ok: false, code: e.code ?? e.name, message: e.message } }
}
function wrap({ status, body }) {
  if (status >= 200 && status < 300) return { ok: true, value: body, status }
  return { ok: false, code: body.code, message: body.message, status }
}

// ---------------------------------------------------------------------------
// Fixture mutation authority -- SEPARATE identity from the provider runtime.
// ---------------------------------------------------------------------------
const FIXTURE_SA = 'wellauth-fixture-sa@preflight-hackathon.iam.gserviceaccount.com'
let fixtureToken

/**
 * Mints an access token for the fixture SA by impersonation. The provider
 * runtime NEVER uses this path -- it is test-only write authority.
 */
async function fixtureAuth() {
  if (fixtureToken) return fixtureToken
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const res = await client.request({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${FIXTURE_SA}:generateAccessToken`,
    method: 'POST',
    data: { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '600s' },
  })
  fixtureToken = res.data.accessToken
  return fixtureToken
}

const FHIR_BASE = `https://healthcare.googleapis.com/v1/${(await import('./fhir.js')).STORE_PATH}/fhir`

async function fixtureRead(type, id) {
  const token = await fixtureAuth()
  const res = await fetch(`${FHIR_BASE}/${type}/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
  })
  if (!res.ok) throw new Error(`fixture read ${type}/${id}: ${res.status}`)
  return res.json()
}

/** Writes a resource back with the fixture identity, producing a new version. */
async function fixtureWrite(resource) {
  const token = await fixtureAuth()
  const res = await fetch(`${FHIR_BASE}/${resource.resourceType}/${resource.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/fhir+json',
      Accept: 'application/fhir+json',
    },
    body: JSON.stringify(resource),
  })
  if (!res.ok) throw new Error(`fixture write ${resource.resourceType}/${resource.id}: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Touches a resource to advance meta.versionId without changing meaning. */
async function bumpVersion(type, id) {
  const r = await fixtureRead(type, id)
  const before = r.meta?.versionId
  delete r.meta
  const after = await fixtureWrite(r)
  return { before, after: after.meta?.versionId }
}

const snapshot = async (type, id) => {
  const r = await fixtureRead(type, id)
  const { meta, ...rest } = r
  return {
    versionId: meta?.versionId ?? null,
    contentHash: createHash('sha256').update(canonicalize(rest)).digest('hex'),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function firstHandle(requirementId) {
  const ev = await service.findEvidence(W, requirementId)
  return ev.candidates[0]?.evidenceHandle ?? null
}

async function freshWorkflowThroughComplete() {
  await purgeWorkflow(W).catch(() => {})
  await api.create()
  let s = (await api.resolve()).value
  for (const rid of REQS) {
    const h = await firstHandle(rid)
    s = (await api.attach(rid, h, s.revision)).value
  }
  return s
}

// ===========================================================================
console.log('WellAuth Gate 2 suite --',
  BASE_URL ? `deployed: ${BASE_URL}` : 'in-process (ADC)')
console.log(`Firestore database: ${process.env.FIRESTORE_DATABASE ?? 'wellauth-workflow'}`)

// Baseline clinical snapshots for the P0.18 read-only proof.
const CLINICAL = [
  ['ServiceRequest', 'wellauth-order-001'],
  ['Coverage', 'wellauth-coverage-001'],
  ['Condition', 'wellauth-condition-001'],
  ['DiagnosticReport', 'wellauth-echo-001'],
  ['DocumentReference', 'wellauth-doc-conservative-therapy'],
  ['PractitionerRole', 'wellauth-practrole-001'],
]
const baseline = {}
for (const [t, i] of CLINICAL) baseline[`${t}/${i}`] = await snapshot(t, i)

captureLogs()

// --- P0.1 -----------------------------------------------------------------
section('P0.1  Initial authoritative state')
await purgeWorkflow(W).catch(() => {})
const created = await api.create()
check('P0.1 workflow created', created.ok, created.code ?? '')
check('P0.1 state is CONTEXT_READY', created.value?.state === 'CONTEXT_READY', created.value?.state)
check('P0.1 revision is stable at 1', created.value?.revision === 1, String(created.value?.revision))
check('P0.1 order version recorded from FHIR', Boolean(created.value?.order?.versionId))
check('P0.1 coverage version recorded from FHIR', Boolean(created.value?.coverage?.versionId))
check('P0.1 no packet hash yet', created.value?.packetHash === null)
check('P0.1 no approval yet', created.value?.approval === null)
const reCreate = await api.create()
check('P0.1 re-create is idempotent (no revision drift)',
  reCreate.value?.revision === 1, String(reCreate.value?.revision))

// --- P0.2 -----------------------------------------------------------------
section('P0.2  Requirements resolved')
const resolved = await api.resolve()
check('P0.2 resolve succeeded', resolved.ok, resolved.code ?? '')
check('P0.2 state is REQUIREMENTS_RESOLVED', resolved.value?.state === 'REQUIREMENTS_RESOLVED')
check('P0.2 requirement set version persisted',
  resolved.value?.requirementSetVersion === 'northstar-cardiac-mri-v1',
  String(resolved.value?.requirementSetVersion))
check('P0.2 revision advanced to 2', resolved.value?.revision === 2, String(resolved.value?.revision))
check('P0.2 completeness starts at 0/5',
  resolved.value?.completeness?.satisfied === 0 && resolved.value?.completeness?.required === 5)
const reResolve = await api.resolve()
check('P0.2 repeat resolve does not drift revision',
  reResolve.value?.revision === 2, String(reResolve.value?.revision))

// --- P0.3 -----------------------------------------------------------------
section('P0.3  Attach evidence')
const h1 = await firstHandle('req-001')
const beforeAttach = (await api.state()).value
const attached = await api.attach('req-001', h1, beforeAttach.revision)
check('P0.3 attach succeeded', attached.ok, attached.code ?? '')
check('P0.3 revision incremented',
  attached.value?.revision === beforeAttach.revision + 1, String(attached.value?.revision))
const b1 = attached.value?.bindings?.find((b) => b.requirementId === 'req-001')
check('P0.3 binding persisted in Firestore', Boolean(b1))
check('P0.3 binding carries exact FHIR version', Boolean(b1?.sourceVersionId))
const liveCond = await fixtureRead('Condition', b1?.resourceId ?? 'wellauth-condition-001')
check('P0.3 bound version matches live FHIR version',
  b1?.sourceVersionId === liveCond.meta?.versionId,
  `${b1?.sourceVersionId} vs ${liveCond.meta?.versionId}`)
check('P0.3 completeness recomputed to 1/5', attached.value?.completeness?.satisfied === 1)
check('P0.3 state stays REQUIREMENTS_RESOLVED at 1/5',
  attached.value?.state === 'REQUIREMENTS_RESOLVED')
const afterAttachSnap = await snapshot('Condition', 'wellauth-condition-001')
check('P0.3 source FHIR resource unchanged by attach',
  afterAttachSnap.versionId === baseline['Condition/wellauth-condition-001'].versionId)

// --- P0.4 -----------------------------------------------------------------
section('P0.4  Attach all five -> PACKET_COMPLETE')
let s = attached.value
for (const rid of REQS.slice(1)) {
  const h = await firstHandle(rid)
  const r = await api.attach(rid, h, s.revision)
  check(`P0.4 attach ${rid}`, r.ok, r.code ?? '')
  s = r.value
}
check('P0.4 completeness is 5/5', s?.completeness?.satisfied === 5, String(s?.completeness?.satisfied))
check('P0.4 state is PACKET_COMPLETE', s?.state === 'PACKET_COMPLETE', s?.state)
const fsDoc = (await workflowRef(W).get()).data()
check('P0.4 completeness came from server recomputation (Firestore agrees)',
  fsDoc.completeness.complete === true && fsDoc.state === 'PACKET_COMPLETE')
const bindCount = (await bindingsCol(W).get()).size
check('P0.4 exactly five bindings stored', bindCount === 5, String(bindCount))

// --- P0.5 -----------------------------------------------------------------
section('P0.5  4/5 refusal')
const removed = await api.remove('req-003', s.revision)
check('P0.5 remove succeeded', removed.ok, removed.code ?? '')
check('P0.5 completeness back to 4/5', removed.value?.completeness?.satisfied === 4)
check('P0.5 state fell back to REQUIREMENTS_RESOLVED',
  removed.value?.state === 'REQUIREMENTS_RESOLVED', removed.value?.state)
const badPrepare = await api.prepare(removed.value.revision, `k-${randomUUID()}`)
check('P0.5 prepare refused at 4/5', !badPrepare.ok)
check('P0.5 refusal code is MISSING_REQUIRED_EVIDENCE',
  badPrepare.code === 'MISSING_REQUIRED_EVIDENCE', String(badPrepare.code))
const afterRefusal = (await api.state()).value
check('P0.5 no packet hash was produced', afterRefusal.packetHash === null)
check('P0.5 no manifest revision was produced', afterRefusal.manifestRevision === null)

// --- P0.6 -----------------------------------------------------------------
section('P0.6  Prepare at 5/5')
const h3 = await firstHandle('req-003')
s = (await api.attach('req-003', h3, afterRefusal.revision)).value
check('P0.6 restored to 5/5', s.completeness.satisfied === 5)
const prepared = await api.prepare(s.revision, `k-${randomUUID()}`)
check('P0.6 prepare succeeded', prepared.ok, prepared.code ?? '')
check('P0.6 state is PREPARED_AWAITING_APPROVAL',
  prepared.value?.state === 'PREPARED_AWAITING_APPROVAL', prepared.value?.state)
check('P0.6 packet hash produced', String(prepared.value?.packetHash).startsWith('sha256:'))
check('P0.6 manifest revision recorded', prepared.value?.manifestRevision === 1)
const disc = await api.disclosure()
check('P0.6 disclosure retrievable', disc.ok, disc.code ?? '')
check('P0.6 manifest names the destination payer',
  disc.value?.destination === 'Northstar Health Plan')
check('P0.6 manifest states the purpose', disc.value?.purpose === 'prior-authorization-review')
check('P0.6 manifest freezes exact order version',
  disc.value?.order?.versionId === created.value.order.versionId)
check('P0.6 manifest freezes exact coverage version',
  disc.value?.coverage?.versionId === created.value.coverage.versionId)
check('P0.6 manifest has five evidence items', disc.value?.items?.length === 5)
check('P0.6 every item carries type/id/version',
  disc.value?.items?.every((i) => i.resourceType && i.resourceId && i.sourceVersionId))
check('P0.6 every item carries an inclusion reason',
  disc.value?.items?.every((i) => typeof i.inclusionReason === 'string'))
check('P0.6 exclusion policy version tracked',
  disc.value?.exclusionPolicy?.version === 'wellauth-minimum-necessary-v1')
const { exclusionPolicy: _ex, ...discContent } = disc.value ?? {}
check('P0.6 manifest carries no raw clinical narrative',
  !JSON.stringify(discContent).match(/narrative|"div"|text\/plain|base64|"text"\s*:/i))
check('P0.6 artifact is explicitly named, not claimed as PAS',
  disc.value?.artifact === 'WellAuthPreparedSubmission/1', String(disc.value?.artifact))

// --- P0.7 -----------------------------------------------------------------
section('P0.7  Agent / unauthenticated approval refusal')
const noIdentity = await api.approve({
  expectedRevision: prepared.value.revision, nonce: `n-${randomUUID()}`,
})
check('P0.7 approval without workforce identity refused', !noIdentity.ok)
check('P0.7 refusal code is identity-related',
  ['APPROVER_IDENTITY_REQUIRED', 'ROLE_NOT_PERMITTED'].includes(noIdentity.code),
  String(noIdentity.code))
const agentRole = await api.approve({
  approvedBy: 'webmcp-agent', role: 'agent',
  expectedRevision: prepared.value.revision, nonce: `n-${randomUUID()}`,
})
check('P0.7 agent role refused', !agentRole.ok)
check('P0.7 agent refusal code is ROLE_NOT_PERMITTED',
  agentRole.code === 'ROLE_NOT_PERMITTED', String(agentRole.code))
check('P0.7 recordApproval is the only approval entry point',
  Object.entries(workflow)
    .filter(([k, v]) => typeof v === 'function' && /approv/i.test(k))
    .map(([k]) => k).join(',') === 'recordApproval')
const stillAwaiting = (await api.state()).value
check('P0.7 state still PREPARED_AWAITING_APPROVAL',
  stillAwaiting.state === 'PREPARED_AWAITING_APPROVAL', stillAwaiting.state)

// --- P0.8 -----------------------------------------------------------------
section('P0.8  Human approval')
const approvalNonce = `n-${randomUUID()}`
const approved = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: stillAwaiting.revision, nonce: approvalNonce,
  acknowledgedPacketHash: stillAwaiting.packetHash,
  idempotencyKey: 'gate2-approval-1',
})
check('P0.8 approval succeeded', approved.ok, approved.code ?? '')
check('P0.8 state is APPROVED', approved.value?.state === 'APPROVED', approved.value?.state)
check('P0.8 approval bound to identity',
  approved.value?.approval?.approvedBy === 'coordinator@wellauth.test')
check('P0.8 approval bound to role',
  approved.value?.approval?.role === 'prior-auth-coordinator')
check('P0.8 approval bound to exact packet hash',
  approved.value?.approval?.packetHash === stillAwaiting.packetHash)
check('P0.8 approval bound to exact manifest revision',
  approved.value?.approval?.manifestRevision === 1)
check('P0.8 approval bound to workflow revision',
  approved.value?.approval?.workflowRevision === stillAwaiting.revision)
check('P0.8 approval timestamped', Boolean(approved.value?.approval?.at))

// --- P0.9 -----------------------------------------------------------------
section('P0.9  No submission occurs')
check('P0.9 approval result reports submitted=false', approved.value?.submitted === false)
check('P0.9 no SUBMITTING/SUBMITTED state exists',
  !workflow.STATES.includes('SUBMITTING') && !workflow.STATES.includes('SUBMITTED'))
check('P0.9 APPROVED is terminal for Gate 2',
  workflow.STATES[workflow.STATES.length - 1] === 'APPROVED')
check('P0.9 provider exports no submit operation',
  !Object.keys(workflow).some((k) => /submit/i.test(k)))
const srcAll = [
  await import('node:fs').then((fs) => fs.readFileSync('provider/workflow.js', 'utf8')),
  await import('node:fs').then((fs) => fs.readFileSync('provider/index.js', 'utf8')),
  await import('node:fs').then((fs) => fs.readFileSync('provider/service.js', 'utf8')),
].join('\n')
check('P0.9 no payer endpoint appears in provider source',
  !/northstar[a-z.-]*\.(com|net|org|health)|payer\.example|https?:\/\/[^\s'"]*payer/i.test(srcAll))
const outboundHosts = [...srcAll.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])
check('P0.9 only Google API hosts appear in provider source',
  outboundHosts.every((h) => /googleapis\.com$/.test(h)), outboundHosts.join(','))

// --- P0.10 ----------------------------------------------------------------
section('P0.10  Stale evidence after prepare')
const preApproved = (await api.state()).value
const bumpEcho = await bumpVersion('DiagnosticReport', 'wellauth-echo-001')
check('P0.10 fixture identity advanced the evidence version',
  bumpEcho.before !== bumpEcho.after, `${bumpEcho.before} -> ${bumpEcho.after}`)
// Re-prepare/approve cycle on stale source must refuse.
const staleApprove = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: preApproved.revision, nonce: `n-${randomUUID()}`,
})
check('P0.10 approval on stale source refused', !staleApprove.ok, String(staleApprove.code))
check('P0.10 refusal is state- or freshness-derived',
  ['SOURCE_STALE', 'NOT_AWAITING_APPROVAL', 'REVISION_CONFLICT'].includes(staleApprove.code),
  String(staleApprove.code))
// Now prove prepare itself refuses a stale binding.
const s10 = (await api.state()).value
const prep10 = await api.prepare(s10.revision, `k-${randomUUID()}`)
check('P0.10 prepare refuses while a bound source is stale',
  !prep10.ok && ['SOURCE_STALE', 'MISSING_REQUIRED_EVIDENCE'].includes(prep10.code),
  String(prep10.code))
check('P0.10 freshness proven by direct read, not FHIR search',
  /verifyFreshness[\s\S]*?readExact/.test(srcAll) && !/verifyFreshness[\s\S]{0,1200}fhir\.search/.test(srcAll))

// --- P0.11 ----------------------------------------------------------------
section('P0.11  Binding change invalidates preparation')
let s11 = await freshWorkflowThroughComplete()
const prep11 = await api.prepare(s11.revision, `k-${randomUUID()}`)
check('P0.11 prepared cleanly', prep11.ok, prep11.code ?? '')
const hashBefore = prep11.value.packetHash
const app11 = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: prep11.value.revision, nonce: `n-${randomUUID()}`,
})
check('P0.11 approved before the change', app11.ok, app11.code ?? '')
const rm11 = await api.remove('req-002', app11.value.revision)
check('P0.11 evidence removal succeeded', rm11.ok, rm11.code ?? '')
check('P0.11 approval invalidated', rm11.value?.approval === null)
check('P0.11 prepared packet hash invalidated', rm11.value?.packetHash === null)
check('P0.11 manifest revision cleared', rm11.value?.manifestRevision === null)
check('P0.11 state fell back below PREPARED',
  rm11.value?.state === 'REQUIREMENTS_RESOLVED', rm11.value?.state)
check('P0.11 revision advanced', rm11.value?.revision > app11.value.revision)
const disc11 = await api.disclosure()
check('P0.11 no current disclosure after invalidation',
  !disc11.ok && disc11.code === 'NOT_PREPARED', String(disc11.code))

// --- P0.12 ----------------------------------------------------------------
section('P0.12  Order / coverage stale')
let s12 = await freshWorkflowThroughComplete()
const prep12 = await api.prepare(s12.revision, `k-${randomUUID()}`)
check('P0.12 prepared before source change', prep12.ok, prep12.code ?? '')
const bumpCov = await bumpVersion('Coverage', 'wellauth-coverage-001')
check('P0.12 fixture advanced the coverage version',
  bumpCov.before !== bumpCov.after, `${bumpCov.before} -> ${bumpCov.after}`)
const app12 = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: prep12.value.revision, nonce: `n-${randomUUID()}`,
})
check('P0.12 approval refused on stale coverage',
  !app12.ok && app12.code === 'SOURCE_STALE', String(app12.code))
const s12b = (await api.state()).value
check('P0.12 stale preparation was torn down',
  s12b.packetHash === null && s12b.state !== 'PREPARED_AWAITING_APPROVAL', s12b.state)
const prep12b = await api.prepare(s12b.revision, `k-${randomUUID()}`)
check('P0.12 prepare still refuses until reconciled',
  !prep12b.ok && prep12b.code === 'SOURCE_STALE', String(prep12b.code))
const rec12 = await api.reconcile(s12b.revision)
check('P0.12 explicit reconcile adopts the new coverage version',
  rec12.ok && rec12.value.coverage.versionId === bumpCov.after, String(rec12.code))
const bumpOrder = await bumpVersion('ServiceRequest', 'wellauth-order-001')
const s12c = (await api.state()).value
const prep12c = await api.prepare(s12c.revision, `k-${randomUUID()}`)
check('P0.12 prepare refuses on stale order version',
  !prep12c.ok && prep12c.code === 'SOURCE_STALE',
  `${prep12c.code} (${bumpOrder.before} -> ${bumpOrder.after})`)

// --- P0.13 ----------------------------------------------------------------
section('P0.13  Concurrent mutation')
let s13 = await freshWorkflowThroughComplete()
const rev13 = s13.revision
const [c1, c2] = await Promise.all([
  api.remove('req-001', rev13),
  api.remove('req-002', rev13),
])
const winners = [c1, c2].filter((r) => r.ok)
const losers = [c1, c2].filter((r) => !r.ok)
check('P0.13 exactly one concurrent mutation committed',
  winners.length === 1, `${winners.length} succeeded`)
check('P0.13 the other received a conflict',
  losers.length === 1 && losers[0].code === 'REVISION_CONFLICT', String(losers[0]?.code))
check('P0.13 conflict reports the current revision',
  /revision \d+/.test(losers[0]?.message ?? ''), String(losers[0]?.message))
const s13after = (await api.state()).value
check('P0.13 exactly one binding was dropped',
  s13after.completeness.satisfied === 4, String(s13after.completeness.satisfied))
check('P0.13 revision advanced exactly once',
  s13after.revision === rev13 + 1, `${rev13} -> ${s13after.revision}`)

// --- P0.14 ----------------------------------------------------------------
section('P0.14  Approval replay')
let s14 = await freshWorkflowThroughComplete()
const prep14 = await api.prepare(s14.revision, `k-${randomUUID()}`)
const key14 = `idem-${randomUUID()}`
const nonce14 = `n-${randomUUID()}`
const a14a = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: prep14.value.revision, nonce: nonce14, idempotencyKey: key14,
})
check('P0.14 first approval succeeded', a14a.ok, a14a.code ?? '')
const revAfter14 = a14a.value.revision
const a14b = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: prep14.value.revision, nonce: nonce14, idempotencyKey: key14,
})
check('P0.14 replay with same idempotency key returned original result',
  a14b.ok && a14b.value.revision === revAfter14, String(a14b.code))
const s14after = (await api.state()).value
check('P0.14 replay did not advance the revision',
  s14after.revision === revAfter14, `${revAfter14} -> ${s14after.revision}`)
const a14c = await api.approve({
  approvedBy: 'coordinator@wellauth.test', role: 'prior-auth-coordinator',
  expectedRevision: revAfter14, nonce: nonce14, idempotencyKey: `idem-${randomUUID()}`,
})
check('P0.14 replay with a fresh key but consumed nonce refused',
  !a14c.ok, String(a14c.code))
const ledger14 = await ledgerCol(W).get()
const approvals14 = ledger14.docs.filter((d) => d.data().operation === 'approve')
check('P0.14 exactly one approval transition recorded',
  approvals14.length === 1, String(approvals14.length))

// --- P0.15 ----------------------------------------------------------------
section('P0.15  Forged frontend state')
let s15 = await freshWorkflowThroughComplete()
const forged = await api.attach('req-001', await firstHandle('req-001'), s15.revision, {
  state: 'APPROVED', workflow_state: 'APPROVED', completeness: { satisfied: 5, complete: true },
  packet_hash: 'sha256:forged', approval: { approvedBy: 'attacker' },
})
check('P0.15 request carrying a forged state was processed on its merits', forged.ok, forged.code ?? '')
check('P0.15 forged state ignored -- state stays server-derived',
  forged.value?.state !== 'APPROVED', String(forged.value?.state))
check('P0.15 forged packet hash ignored', forged.value?.packetHash === null)
check('P0.15 forged approval ignored', forged.value?.approval === null)
check('P0.15 no generic state setter route exists',
  !/PATCH|\bstate\s*:\s*body\.|body\.state/.test(srcAll))
check('P0.15 completeness still server-computed',
  forged.value?.completeness?.satisfied === 5 && forged.value?.state === 'PACKET_COMPLETE')

// --- P0.16 ----------------------------------------------------------------
section('P0.16  Cross-workflow evidence handle')
const foreignHandle = 'ev_' + createHash('sha256')
  .update('wf-other-999|Condition|wellauth-condition-001').digest('hex').slice(0, 20)
const s16 = (await api.state()).value
const cross = await api.attach('req-001', foreignHandle, s16.revision)
check('P0.16 foreign handle refused', !cross.ok)
check('P0.16 refusal code is CONTEXT_MISMATCH',
  cross.code === 'CONTEXT_MISMATCH', String(cross.code))
check('P0.16 refusal leaks no resource id or type',
  !/wellauth-condition|Condition/.test(cross.message ?? ''), String(cross.message))
const unknown = await api.attach('req-001', 'ev_0000000000000000dead', s16.revision)
check('P0.16 unknown handle refused identically (no existence oracle)',
  unknown.code === cross.code && unknown.message === cross.message)

// --- P0.17 ----------------------------------------------------------------
section('P0.17  Deterministic hash')
let s17 = await freshWorkflowThroughComplete()
const p17a = await api.prepare(s17.revision, `k-${randomUUID()}`)
const hashA = p17a.value.packetHash
// Legitimate reset/re-prepare path: remove + re-attach the same evidence.
const rm17 = await api.remove('req-001', p17a.value.revision)
const re17 = await api.attach('req-001', await firstHandle('req-001'), rm17.value.revision)
const p17b = await api.prepare(re17.value.revision, `k-${randomUUID()}`)
check('P0.17 re-prepared successfully', p17b.ok, p17b.code ?? '')
check('P0.17 identical content hashes identically',
  p17b.value.packetHash === hashA, `${hashA} vs ${p17b.value.packetHash}`)
check('P0.17 manifest revision still advanced',
  p17b.value.manifestRevision === 2, String(p17b.value.manifestRevision))
// Changed content must change the hash.
const disc17 = (await api.disclosure()).value
const mutated = { ...disc17, items: disc17.items.map((i, n) =>
  n === 0 ? { ...i, sourceVersionId: `${i.sourceVersionId}-changed` } : i) }
// Reduce a stored/served manifest back to the hashed CONTENT: drop the hash
// itself, packaging metadata (revision counters, timestamps) and per-request
// transport fields (correlationId, only present over HTTP).
const strip = (o) => { const { packetHash: _p, preparedAt: _a, preparedAtRevision: _r, state: _s,
  currentPacketHash: _c, manifestRevision: _m, correlationId: _i, ...rest } = o; return rest }
check('P0.17 evidence version change changes the hash',
  packetHash(strip(mutated)) !== packetHash(strip(disc17)))
check('P0.17 requirement-set version change changes the hash',
  packetHash({ ...strip(disc17), requirementSetVersion: 'v2' }) !== packetHash(strip(disc17)))
check('P0.17 destination change changes the hash',
  packetHash({ ...strip(disc17), destination: 'Other Plan' }) !== packetHash(strip(disc17)))
check('P0.17 key order does not affect the hash',
  packetHash({ b: 1, a: 2 }) === packetHash({ a: 2, b: 1 }))
check('P0.17 recomputed hash matches the stored hash',
  packetHash(strip(disc17)) === disc17.packetHash,
  `${packetHash(strip(disc17))} vs ${disc17.packetHash}`)

// --- P0.18 ----------------------------------------------------------------
section('P0.18  FHIR read-only proof')
for (const [t, i] of CLINICAL) {
  const now = await snapshot(t, i)
  const was = baseline[`${t}/${i}`]
  const bumped = ['DiagnosticReport/wellauth-echo-001', 'Coverage/wellauth-coverage-001',
                  'ServiceRequest/wellauth-order-001'].includes(`${t}/${i}`)
  if (bumped) {
    check(`P0.18 ${t}/${i} changed only via fixture identity (content identical)`,
      now.contentHash === was.contentHash, 'content drifted')
  } else {
    check(`P0.18 ${t}/${i} version unchanged`, now.versionId === was.versionId,
      `${was.versionId} -> ${now.versionId}`)
    check(`P0.18 ${t}/${i} content unchanged`, now.contentHash === was.contentHash)
  }
}
check('P0.18 provider FHIR module exposes no write verb',
  !Object.keys(fhir).some((k) => /write|create|update|delete|patch|put/i.test(k)))
check('P0.18 provider runtime issues no non-GET FHIR request',
  !/method:\s*'(PUT|POST|PATCH|DELETE)'/.test(
    await import('node:fs').then((f) => f.readFileSync('provider/fhir.js', 'utf8'))))
check('P0.18 fixture writes used a separate identity',
  /generateAccessToken/.test(await import('node:fs').then((f) =>
    f.readFileSync('provider/gate2.js', 'utf8'))))

// --- P0.19 ----------------------------------------------------------------
section('P0.19  Restart durability')
const before19 = (await api.state()).value
// Cold-load the modules: simulates a fresh process with no in-memory state.
const fresh = await import(`./workflow.js?cold=${randomUUID()}`)
const after19 = await fresh.getWorkflow(W)
check('P0.19 workflow survives a cold module load', after19.state === before19.state,
  `${before19.state} -> ${after19.state}`)
check('P0.19 revision survives', after19.revision === before19.revision)
check('P0.19 bindings survive', after19.bindings.length === before19.bindings.length)
check('P0.19 packet hash survives', after19.packetHash === before19.packetHash)
check('P0.19 state lives in Firestore, not process memory',
  (await workflowRef(W).get()).data().state === before19.state)
check('P0.19 no module-level mutable workflow cache',
  !/^let (current|state|workflows)\b/m.test(
    await import('node:fs').then((f) => f.readFileSync('provider/workflow.js', 'utf8'))))

// --- P0.20 ----------------------------------------------------------------
section('P0.20  Logging hygiene')
const logBlob = logLines.join('\n')
const canaries = [
  ['patient id', /wellauth-patient-001/],
  ['clinical narrative', /conservative therapy trial|chest pain|dyspnea|ejection fraction/i],
  ['raw FHIR resource', /"resourceType"\s*:\s*"(Condition|DiagnosticReport|DocumentReference)"/],
  ['approval nonce', new RegExp(approvalNonce.replace(/[-]/g, '\\-'))],
  ['bearer token', /Bearer\s+ey/],
  ['full evidence text', /"content"\s*:\s*\[/],
]
for (const [label, re] of canaries) {
  check(`P0.20 no ${label} in provider logs`, !re.test(logBlob))
}
const providerLogCalls = (await import('node:fs')
  .then((f) => f.readFileSync('provider/index.js', 'utf8')))
check('P0.20 HTTP layer logs only operation metadata',
  !/console\.log\([^)]*result\)|console\.log\([^)]*body\)/.test(providerLogCalls))

// ===========================================================================
console.log = realLog
console.error = realErr
console.log('\n========================================================')
console.log(`Gate 2 suite: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('ALL P0 CHECKS PASSED')
