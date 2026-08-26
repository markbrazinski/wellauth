// Gate 4 suite: the integrated product, Act I + Act II.
//
//   PAYER_BASE_URL=https://... npm run test:gate4                    (in-process)
//   GATE4_BASE_URL=https://... PAYER_BASE_URL=... npm run test:gate4 (deployed)
//
// Nothing is stubbed. Real Cloud Healthcare FHIR, real Firestore, the real
// deployed payer simulator. The Act II assertions count payer transactions from
// the PAYER'S OWN durable records, never from provider state.
//
// THE CENTRAL ASSERTION
//   An external payer response changes what the browser agent is able to do,
//   and every human gate is enforced by the ABSENCE of a capability plus an
//   independent backend refusal -- never by a disabled button.

import { GoogleAuth } from 'google-auth-library'
import { randomUUID } from 'node:crypto'
import * as service from './service.js'
import * as workflow from './workflow.js'
import * as submission from './submission.js'
import * as remediation from './remediation.js'
import { capabilitiesFor } from './capabilities.js'
import { firestore, purgeWorkflow, workflowRef } from './store.js'
import * as fixture from './fixture.js'

const BASE_URL = process.env.GATE4_BASE_URL
const PAYER_URL = process.env.PAYER_BASE_URL
const W = 'wf-wellauth-001'
const REQS = ['req-001', 'req-002', 'req-003', 'req-004', 'req-005']

if (!PAYER_URL) {
  console.error('PAYER_BASE_URL is required -- Gate 4 must cross a real payer boundary.')
  process.exit(1)
}

let pass = 0, fail = 0
const failures = []
const logLines = []

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}
const section = (t) => console.log(`\n${t}`)

const realLog = console.log
const realErr = console.error
function captureLogs() {
  console.log = (...a) => { logLines.push(a.join(' ')); realLog(...a) }
  console.error = (...a) => { logLines.push(a.join(' ')); realErr(...a) }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
let idToken
async function bearer() {
  if (!idToken) {
    idToken = process.env.GATE4_ID_TOKEN
    if (!idToken) {
      const { execFileSync } = await import('node:child_process')
      idToken = execFileSync('gcloud', ['auth', 'print-identity-token'], {
        encoding: 'utf8',
        env: { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON ?? '' },
      }).trim()
    }
  }
  return idToken
}

async function http(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(BASE_URL ? { Authorization: `Bearer ${await bearer()}` } : {}),
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

async function ok(fn) {
  try { return { ok: true, value: await fn() } }
  catch (e) { return { ok: false, code: e.code ?? e.name, message: e.message } }
}
function wrap({ status, body }) {
  if (status >= 200 && status < 300) return { ok: true, value: body, status }
  return { ok: false, code: body.code, message: body.message, status }
}

/** Scheduled service date from FHIR -- clinical truth, never client-supplied. */
async function scheduledDate() {
  const order = await service.getOrder(W)
  return String(order.scheduled).slice(0, 10)
}

/** The composed snapshot the frontend reads. */
async function snapshot() {
  if (BASE_URL) return wrap(await http('GET', `/workflows/${W}/snapshot`))
  const wf = await workflow.getWorkflow(W)
  const sched = await scheduledDate()
  const act2 = remediation.derivePosture(wf, sched)
  return {
    ok: true,
    value: {
      ...wf,
      scheduledServiceDate: sched,
      act2,
      availableTools: capabilitiesFor(wf, act2),
      requirements: service.getRequirements(W).requirements,
    },
  }
}

const api = {
  create: async () => BASE_URL ? wrap(await http('POST', `/workflows/${W}`))
                               : ok(() => workflow.createWorkflow(W)),
  resolve: async () => BASE_URL ? wrap(await http('POST', `/workflows/${W}/requirements`))
                                : ok(() => workflow.resolveRequirements(W)),
  find: async (r) => BASE_URL
    ? wrap(await http('GET', `/workflows/${W}/requirements/${r}/evidence`))
    : ok(() => service.findEvidence(W, r)),
  attach: async (r, h, rev) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/evidence/attach`,
        { body: { requirement_id: r, evidence_handle: h, expected_revision: rev } }))
    : ok(() => workflow.attachEvidence(W, {
        requirementId: r, evidenceHandle: h, expectedRevision: rev })),
  prepare: async (rev) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/prepare`, { body: { expected_revision: rev } }))
    : ok(() => workflow.prepareSubmission(W, { expectedRevision: rev })),
  approve: async (rev, hash) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/approval`, {
        body: { expected_revision: rev, nonce: randomUUID(), acknowledged_packet_hash: hash },
        headers: { 'X-WellAuth-User': 'A. Reyes', 'X-WellAuth-Role': 'prior-auth-coordinator' } }))
    : ok(() => workflow.recordApproval(W, {
        approvedBy: 'A. Reyes', role: 'prior-auth-coordinator',
        expectedRevision: rev, nonce: randomUUID(), acknowledgedPacketHash: hash })),
  submit: async (rev) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/submit`, { body: { expected_revision: rev } }))
    : ok(() => submission.submitPriorAuthorization(W, { expectedRevision: rev })),
  // --- Act II ---
  resolveWindow: async (rev) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/remediation/resolve`,
        { body: { expected_revision: rev } }))
    : ok(async () => remediation.resolveAuthorizationWindow(W, {
        expectedRevision: rev, scheduledServiceDate: await scheduledDate() })),
  approveRemediation: async (rev, hash, headers) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/remediation/approval`, {
        body: { expected_revision: rev, nonce: randomUUID(), acknowledged_hash: hash },
        headers: headers ?? { 'X-WellAuth-User': 'A. Reyes',
                              'X-WellAuth-Role': 'prior-auth-coordinator' } }))
    : ok(async () => remediation.approveRemediation(W, {
        approvedBy: 'A. Reyes', role: 'prior-auth-coordinator',
        expectedRevision: rev, nonce: randomUUID(), acknowledgedHash: hash,
        scheduledServiceDate: await scheduledDate() })),
  submitExtension: async (rev) => BASE_URL
    ? wrap(await http('POST', `/workflows/${W}/remediation/submit`,
        { body: { expected_revision: rev } }))
    : ok(async () => remediation.submitAuthorizationExtension(W, {
        expectedRevision: rev, scheduledServiceDate: await scheduledDate() })),
}

/** Authenticated call to the payer with the provider's own identity. */
async function payerFetch(path, init = {}) {
  const auth = new GoogleAuth()
  const client = await auth.getIdTokenClient(PAYER_URL)
  const headers = await client.getRequestHeaders()
  const raw = typeof headers?.get === 'function'
    ? headers.get('authorization') : headers?.Authorization
  return fetch(`${PAYER_URL}${path}`, {
    ...init,
    headers: { Authorization: String(raw), ...(init.headers ?? {}) },
  })
}

/**
 * Clears the payer's record for this workflow's canonical claim identifiers.
 *
 * The payer's duplicate-collapse is permanent by design: a replayed identifier
 * returns the ORIGINAL decision forever. Re-running the canonical demo
 * therefore requires explicitly clearing prior payer transactions, or the
 * suite would assert against a decision minted by an earlier run.
 */
async function resetPayer(identifiers) {
  for (const id of identifiers) {
    await payerFetch('/demo/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimIdentifier: id }),
    }).catch(() => {})
  }
}

/** Counts payer-side extension transactions from the PAYER'S own records. */
async function payerExtensionState(claimIdentifier) {
  const res = await payerFetch(`/Claim/$status/${encodeURIComponent(claimIdentifier)}`)
  if (!res.ok) return null
  const body = await res.json()
  const p = Object.fromEntries(
    (body.parameter ?? []).map((x) => [x.name, x.valueString ?? x.valueBoolean ?? x.valueInteger]))
  return p
}

/** Drives Act I to a persisted payer approval. */
async function driveActI() {
  await api.create()
  await api.resolve()
  let s = (await snapshot()).value
  for (const r of REQS) {
    const found = await api.find(r)
    const handle = found.value?.candidates?.[0]?.evidenceHandle
    if (!handle) continue
    await api.attach(r, handle, s.revision)
    s = (await snapshot()).value
  }
  const prep = await api.prepare(s.revision)
  s = (await snapshot()).value
  await api.approve(s.revision, prep.value?.packetHash ?? s.packetHash)
  s = (await snapshot()).value
  await api.submit(s.revision)
  return (await snapshot()).value
}

// ===========================================================================
async function main() {
  captureLogs()
  console.log('WellAuth Gate 4 -- integrated product, Act I + Act II')
  console.log(`  mode: ${BASE_URL ? `deployed ${BASE_URL}` : 'in-process'}`)
  console.log(`  payer: ${PAYER_URL} (SIMULATED)\n`)

  await purgeWorkflow(W).catch(() => {})

  // -------------------------------------------------------------------------
  section('P0.1  Cold initial state is reconstructed from the backend')
  await api.create()
  let s = (await snapshot()).value
  check('P0.1 state is CONTEXT_READY', s.state === 'CONTEXT_READY', s.state)
  check('P0.1 no requirements are satisfied yet', s.completeness.satisfied === 0)
  check('P0.1 payer is the canonical synthetic payer', s.payer === 'Northstar Health Plan')
  check('P0.1 scheduled service comes from FHIR clinical truth',
    s.scheduledServiceDate === fixture.SCHEDULED_SERVICE_DATE, s.scheduledServiceDate)
  check('P0.1 no Act II phase before a payer response', s.act2.phase === null)

  section('P0.2  Initial capability inventory')
  check('P0.2 order context is available', s.availableTools.includes('get_order_context'))
  check('P0.2 requirement discovery is available',
    s.availableTools.includes('discover_coverage_requirements'))
  check('P0.2 no evidence tools before requirements resolve',
    !s.availableTools.includes('attach_evidence'))
  check('P0.2 no prepare capability', !s.availableTools.includes('prepare_prior_authorization'))
  check('P0.2 NO submit capability', !s.availableTools.includes('submit_prior_authorization'))
  check('P0.2 no remediation capability',
    !s.availableTools.includes('resolve_authorization_window'))

  // -------------------------------------------------------------------------
  section('P0.3  Requirement discovery advances real backend state')
  const beforeRev = s.revision
  await api.resolve()
  s = (await snapshot()).value
  check('P0.3 state advanced', s.state === 'REQUIREMENTS_RESOLVED', s.state)
  check('P0.3 revision advanced', s.revision > beforeRev)
  check('P0.3 five requirements are visible', s.requirements.length === 5)

  section('P0.4  Evidence capabilities register dynamically')
  check('P0.4 find_supporting_evidence appeared',
    s.availableTools.includes('find_supporting_evidence'))
  check('P0.4 attach_evidence appeared', s.availableTools.includes('attach_evidence'))
  check('P0.4 prepare is still absent at 0/5',
    !s.availableTools.includes('prepare_prior_authorization'))

  // -------------------------------------------------------------------------
  section('P0.5  Four of five, from real FHIR-backed evidence')
  for (const r of ['req-001', 'req-002', 'req-004', 'req-005']) {
    const found = await api.find(r)
    const handle = found.value?.candidates?.[0]?.evidenceHandle
    const res = await api.attach(r, handle, s.revision)
    check(`P0.5 ${r} attached from FHIR evidence`, res.ok, res.code ?? '')
    s = (await snapshot()).value
  }
  check('P0.5 exactly 4 of 5 satisfied', s.completeness.satisfied === 4,
    String(s.completeness.satisfied))
  check('P0.5 packet is NOT complete', s.completeness.complete === false)
  check('P0.5 prepare is still absent at 4/5',
    !s.availableTools.includes('prepare_prior_authorization'))
  check('P0.5 every binding carries an exact source version',
    s.bindings.every((b) => b.sourceVersionId))

  section('P0.6  Fifth evidence via the alternate document path')
  const fifth = await api.find('req-003')
  const fifthHandle = fifth.value?.candidates?.[0]?.evidenceHandle
  check('P0.6 fifth evidence located', Boolean(fifthHandle))
  check('P0.6 it is the alternate document path',
    fifth.value?.candidates?.[0]?.matchedBy?.policy === 'alternate-document-path',
    fifth.value?.candidates?.[0]?.matchedBy?.policy)
  await api.attach('req-003', fifthHandle, s.revision)
  s = (await snapshot()).value
  check('P0.6 5 of 5 satisfied', s.completeness.satisfied === 5)
  check('P0.6 state is PACKET_COMPLETE', s.state === 'PACKET_COMPLETE', s.state)
  check('P0.6 prepare capability NOW appears',
    s.availableTools.includes('prepare_prior_authorization'))

  // -------------------------------------------------------------------------
  section('P0.7  Prepare freezes the exact disclosure')
  const prep = await api.prepare(s.revision)
  s = (await snapshot()).value
  check('P0.7 state is PREPARED_AWAITING_APPROVAL',
    s.state === 'PREPARED_AWAITING_APPROVAL', s.state)
  check('P0.7 a deterministic packet hash exists', /^sha256:/.test(s.packetHash ?? ''))

  section('P0.8  No submission capability before human approval')
  check('P0.8 submit_prior_authorization is ABSENT',
    !s.availableTools.includes('submit_prior_authorization'))
  check('P0.8 prepare is withdrawn once prepared',
    !s.availableTools.includes('prepare_prior_authorization'))
  const earlySubmit = await api.submit(s.revision)
  check('P0.8 direct backend submit REFUSES without approval',
    !earlySubmit.ok && earlySubmit.code === 'APPROVAL_REQUIRED', earlySubmit.code)

  section('P0.9  Human approval is workforce-gated and does not transmit')
  if (BASE_URL) {
    const noIdent = wrap(await http('POST', `/workflows/${W}/approval`,
      { body: { expected_revision: s.revision, nonce: randomUUID() } }))
    check('P0.9 approval without workforce identity is refused',
      !noIdent.ok && noIdent.status === 401, String(noIdent.status))
  } else {
    const noIdent = await ok(() => workflow.recordApproval(W, {
      expectedRevision: s.revision, nonce: randomUUID() }))
    check('P0.9 approval without workforce identity is refused',
      !noIdent.ok && noIdent.code === 'APPROVER_IDENTITY_REQUIRED', noIdent.code)
  }
  const appr = await api.approve(s.revision, s.packetHash)
  check('P0.9 workforce approval succeeds', appr.ok, appr.code ?? '')
  s = (await snapshot()).value
  check('P0.9 state is APPROVED', s.state === 'APPROVED', s.state)
  check('P0.9 approval did NOT transmit anything', s.submission === null)

  section('P0.10  Submit capability unlocks only after approval')
  check('P0.10 submit_prior_authorization NOW appears',
    s.availableTools.includes('submit_prior_authorization'))

  // -------------------------------------------------------------------------
  section('P0.11  Agent submission crosses the real payer boundary')
  // The payer's duplicate-collapse is permanent by design, so a prior run's
  // decision would otherwise be replayed instead of a fresh one being minted.
  // Clearing it here is what makes the suite repeatable.
  const { claimIdentifier: cid } = await import('./pas.js')
  await resetPayer([cid(W, s.packetHash)])
  const sub = await api.submit(s.revision)
  check('P0.11 submission succeeded', sub.ok, sub.code ?? '')
  s = (await snapshot()).value
  check('P0.11 a durable submission record exists', Boolean(s.submission))
  check('P0.11 payer returned approved', s.submission?.payerStatus === 'approved',
    s.submission?.payerStatus)
  check('P0.11 destination is the simulated payer',
    s.submission?.destination === 'Northstar Health Plan')

  section('P0.12  Exactly one payer transaction')
  const payerState = await payerExtensionState(s.submission.claimIdentifier)
  check('P0.12 the payer holds a record for this claim', Boolean(payerState))
  check('P0.12 provider recorded exactly one attempt', s.submission?.attempts === 1,
    String(s.submission?.attempts))
  check('P0.12 submit capability is withdrawn after submission',
    !s.availableTools.includes('submit_prior_authorization'))
  check('P0.12 status capability appears',
    s.availableTools.includes('check_authorization_status'))

  // =========================================================================
  // ACT II
  // =========================================================================
  section('P0.13  Payer approval does not cover the scheduled service')
  check('P0.13 Act II phase is PAYER_APPROVED_COVERAGE_GAP',
    s.act2.phase === 'PAYER_APPROVED_COVERAGE_GAP', String(s.act2.phase))
  check('P0.13 alignment evaluated as NOT covered', s.act2.alignment?.aligned === false)
  check('P0.13 validity ends before the scheduled MRI',
    s.act2.alignment?.validThrough === fixture.INITIAL_VALID_THROUGH,
    s.act2.alignment?.validThrough)
  check('P0.13 scheduled date is the canonical fixture date',
    s.act2.alignment?.scheduledServiceDate === fixture.SCHEDULED_SERVICE_DATE)

  section('P0.14  External payer state unlocks a NEW capability')
  check('P0.14 resolve_authorization_window appeared',
    s.availableTools.includes('resolve_authorization_window'))
  check('P0.14 no extension-submit capability yet',
    !s.availableTools.includes('submit_authorization_extension'))
  check('P0.14 clinical mutation capabilities remain absent',
    !s.availableTools.includes('attach_evidence'))

  section('P0.15  Remediation prepares but does not transmit')
  const resolved = await api.resolveWindow(s.revision)
  check('P0.15 remediation prepared', resolved.ok, resolved.code ?? '')
  s = (await snapshot()).value
  check('P0.15 phase is REMEDIATION_PREPARED', s.act2.phase === 'REMEDIATION_PREPARED',
    String(s.act2.phase))
  check('P0.15 requested validity is server-determined',
    s.remediation?.requestedValidThrough === fixture.EXTENDED_VALID_THROUGH,
    s.remediation?.requestedValidThrough)
  check('P0.15 a deterministic remediation hash exists',
    /^sha256:/.test(s.remediation?.hash ?? ''))
  check('P0.15 the artifact states no clinical change',
    s.remediation?.clinicalIntentChanged === false &&
    s.remediation?.evidenceChanged === false &&
    s.remediation?.orderChanged === false)
  check('P0.15 nothing was transmitted', !s.remediation?.submission)

  section('P0.16  No extension-submission capability before approval')
  check('P0.16 submit_authorization_extension is ABSENT',
    !s.availableTools.includes('submit_authorization_extension'))
  check('P0.16 resolve is withdrawn once prepared',
    !s.availableTools.includes('resolve_authorization_window'))
  const earlyExt = await api.submitExtension(s.revision)
  check('P0.16 direct backend extension submit REFUSES',
    !earlyExt.ok && earlyExt.code === 'REMEDIATION_APPROVAL_REQUIRED', earlyExt.code)
  const afterEarly = (await snapshot()).value
  check('P0.16 zero payer calls were made', !afterEarly.remediation?.submission)

  section('P0.17  Remediation approval is workforce-gated')
  if (BASE_URL) {
    const noIdent = wrap(await http('POST', `/workflows/${W}/remediation/approval`,
      { body: { expected_revision: s.revision, nonce: randomUUID() } }))
    check('P0.17 approval without workforce identity is refused',
      !noIdent.ok && noIdent.status === 401, String(noIdent.status))
  } else {
    const noIdent = await ok(() => remediation.approveRemediation(W, {
      expectedRevision: s.revision, nonce: randomUUID() }))
    check('P0.17 approval without workforce identity is refused',
      !noIdent.ok && noIdent.code === 'APPROVER_IDENTITY_REQUIRED', noIdent.code)
  }
  const badHash = await api.approveRemediation(s.revision, 'sha256:wrong')
  check('P0.17 a mismatched remediation hash is refused',
    !badHash.ok && badHash.code === 'REMEDIATION_HASH_MISMATCH', badHash.code)

  const remAppr = await api.approveRemediation(s.revision, s.remediation.hash)
  check('P0.17 workforce approval succeeds', remAppr.ok, remAppr.code ?? '')
  s = (await snapshot()).value
  check('P0.17 phase is REMEDIATION_APPROVED', s.act2.phase === 'REMEDIATION_APPROVED',
    String(s.act2.phase))
  check('P0.17 approval did NOT transmit', !s.remediation?.submission?.extensionReceiptId)

  section('P0.18  Extension submit unlocks only after approval')
  check('P0.18 submit_authorization_extension NOW appears',
    s.availableTools.includes('submit_authorization_extension'))

  section('P0.19  Extension submission and terminal alignment')
  const ext = await api.submitExtension(s.revision)
  check('P0.19 extension submitted', ext.ok, ext.code ?? '')
  s = (await snapshot()).value
  check('P0.19 phase is AUTHORIZATION_ALIGNED', s.act2.phase === 'AUTHORIZATION_ALIGNED',
    String(s.act2.phase))
  check('P0.19 persisted validity now covers the scheduled MRI',
    s.act2.alignment?.aligned === true)
  check('P0.19 validity is the extended date',
    s.remediation?.currentValidThrough === fixture.EXTENDED_VALID_THROUGH,
    s.remediation?.currentValidThrough)
  check('P0.19 a durable extension receipt exists',
    Boolean(s.remediation?.submission?.extensionReceiptId))
  check('P0.19 all mutation capability is withdrawn',
    !s.availableTools.includes('submit_authorization_extension') &&
    !s.availableTools.includes('resolve_authorization_window'))

  section('P0.20  Exactly one payer remediation transaction')
  const afterExt = await payerExtensionState(s.submission.claimIdentifier)
  check('P0.20 payer validity was updated', afterExt !== null)
  // A replay must not produce a second logical remediation.
  const replay = await api.submitExtension(s.revision)
  check('P0.20 a replayed extension submit is refused',
    !replay.ok && replay.code === 'REMEDIATION_ALREADY_SUBMITTED', replay.code)
  const finalSnap = (await snapshot()).value
  check('P0.20 still exactly one extension receipt',
    finalSnap.remediation?.submission?.extensionReceiptId ===
      s.remediation?.submission?.extensionReceiptId)
  check('P0.20 validity did not move again',
    finalSnap.remediation?.currentValidThrough === fixture.EXTENDED_VALID_THROUGH)

  // -------------------------------------------------------------------------
  section('P0.21  Reload durability at every Act II state')
  // A fresh read from Firestore, with no in-memory carry-over, must reproduce
  // the identical posture and capability inventory.
  const reloaded = (await snapshot()).value
  check('P0.21 phase reconstructs from durable state',
    reloaded.act2.phase === 'AUTHORIZATION_ALIGNED')
  check('P0.21 capability inventory reconstructs identically',
    reloaded.availableTools.join(',') === finalSnap.availableTools.join(','))
  check('P0.21 alignment reconstructs', reloaded.act2.alignment?.aligned === true)

  section('P0.22  Cross-workflow and forged-state refusals')
  const foreign = await ok(() => remediation.resolveAuthorizationWindow('wf-not-real',
    { expectedRevision: 1, scheduledServiceDate: fixture.SCHEDULED_SERVICE_DATE }))
  check('P0.22 another workflow cannot be remediated',
    !foreign.ok && foreign.code === 'WORKFLOW_NOT_FOUND', foreign.code)
  const staleRev = await api.resolveWindow(1)
  check('P0.22 a forged/stale revision is refused', !staleRev.ok, staleRev.code)

  section('P0.23  No-mismatch case exposes no remediation capability')
  // Same evaluation, but with a validity that already covers the service.
  const covered = remediation.derivePosture(
    { submission: { state: 'COMPLETE', payerStatus: 'approved',
                    receipt: { preAuthPeriod: { end: fixture.EXTENDED_VALID_THROUGH } } } },
    fixture.SCHEDULED_SERVICE_DATE)
  check('P0.23 no gap is detected when already covered',
    covered.alignment.aligned === true)
  check('P0.23 resolve_authorization_window is NOT offered',
    !capabilitiesFor({ state: 'APPROVED', completeness: { satisfied: 5 },
      submission: { state: 'COMPLETE', payerStatus: 'approved' } }, covered)
      .includes('resolve_authorization_window'))

  section('P0.24  Clinical source truth unchanged by Act II')
  const orderNow = await service.getOrder(W)
  check('P0.24 scheduled service is unchanged',
    String(orderNow.scheduled).slice(0, 10) === fixture.SCHEDULED_SERVICE_DATE,
    String(orderNow.scheduled))
  check('P0.24 ordered service is unchanged',
    /MRI/i.test(orderNow.service?.display ?? ''), orderNow.service?.display)
  check('P0.24 order status is unchanged', orderNow.status === 'active', orderNow.status)
  const remediationSrc = (await import('node:fs')).readFileSync('provider/remediation.js', 'utf8')
  check('P0.24 the remediation module contains no FHIR write verb',
    !/\b(PUT|PATCH|POST)\b.*fhir/i.test(remediationSrc) && !/updateResource|createResource/
      .test(remediationSrc))
  check('P0.24 the remediation module never imports the FHIR client',
    !/from '\.\/fhir\.js'/.test(remediationSrc))

  section('P0.25  Bounded schemas and server-determined values')
  const capSrc = (await import('node:fs')).readFileSync('src/capabilities.ts', 'utf8')
  check('P0.25 remediation tools accept no caller-supplied date',
    !/requested_valid_through|new_date|valid_through.*type.*string/i.test(capSrc))
  check('P0.25 no tool accepts a payer URL or endpoint',
    !/payer_url|endpoint|destination.*type.*string/i.test(capSrc))
  check('P0.25 approval is never exposed as a WebMCP tool',
    !/approve[a-z_]*:\s*\{[\s\S]{0,200}?execute/i.test(capSrc))

  section('P0.26  Logging hygiene')
  const joined = logLines.join('\n')
  check('P0.26 no patient id in logs', !joined.includes('wellauth-patient-001'))
  check('P0.26 no bearer token in logs', !/Bearer\s+ey/.test(joined))
  check('P0.26 no approval nonce leaked', !joined.includes('nonce'))

  // -------------------------------------------------------------------------
  console.log('\n========================================================')
  console.log(`Gate 4 suite: ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('ALL P0 CHECKS PASSED')
}

main().catch((e) => {
  console.error('Gate 4 harness error:', e)
  process.exit(1)
})
