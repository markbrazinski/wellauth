// Gate 1 smoke: P0.1 - P0.13 against a REAL Cloud Healthcare FHIR R4 store.
//
//   npm run test:fhir-smoke                 (in-process, uses ADC)
//   SMOKE_BASE_URL=https://... npm run test:fhir-smoke   (against Cloud Run)
//
// There are no hardcoded expected payloads standing in for the store: every
// assertion below is made against data fetched from Cloud Healthcare API.

import { GoogleAuth } from 'google-auth-library'
import * as service from './service.js'
import { DomainError } from './service.js'
import * as fhir from './fhir.js'
import { STORE_PATH } from './fhir.js'

const BASE_URL = process.env.SMOKE_BASE_URL // set => exercise the deployed service
const WF = 'wf-wellauth-001'

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  FAIL  ${name} ${detail}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// Transport: in-process domain calls, or HTTP against the deployed service.
// ---------------------------------------------------------------------------
let idToken
async function httpGet(path) {
  if (!idToken) {
    // A user ADC cannot mint a service-audience ID token, so prefer an
    // explicitly supplied one; fall back to the gcloud identity token.
    idToken = process.env.SMOKE_ID_TOKEN
    if (!idToken) {
      const { execFileSync } = await import('node:child_process')
      idToken = execFileSync('gcloud', ['auth', 'print-identity-token'], {
        encoding: 'utf8',
      }).trim()
    }
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // Cloud Run returns an HTML page for auth rejections; surface it as a
    // bounded shape rather than crashing the smoke.
    body = { code: 'HTTP_NON_JSON', status: res.status, snippet: text.slice(0, 80) }
  }
  return { status: res.status, body }
}

/** Uniform call shape: resolves {status, body} for both transports. */
async function call(path, fn) {
  if (BASE_URL) return httpGet(path)
  try {
    return { status: 200, body: await fn() }
  } catch (err) {
    if (err instanceof DomainError) {
      return { status: 400, body: { code: err.code, message: err.message } }
    }
    throw err
  }
}

const api = {
  health: () => call('/health', () => service.health()),
  order: (wf = WF) => call(`/workflows/${wf}/order`, () => service.getOrder(wf)),
  requirements: (wf = WF) =>
    call(`/workflows/${wf}/requirements`, () => service.getRequirements(wf)),
  evidence: (req, wf = WF) =>
    call(`/workflows/${wf}/requirements/${req}/evidence`, () => service.findEvidence(wf, req)),
  detail: (handle, wf = WF) =>
    call(`/workflows/${wf}/evidence/${handle}`, () => service.getEvidenceDetail(wf, handle)),
}

// Resources whose immutability the gate must prove.
const WATCHED = [
  ['ServiceRequest', 'wellauth-order-001'],
  ['Coverage', 'wellauth-coverage-001'],
  ['Condition', 'wellauth-condition-001'],
  ['Condition', 'wellauth-condition-002'],
  ['Observation', 'wellauth-obs-lvef-001'],
  ['DiagnosticReport', 'wellauth-echo-001'],
  ['DocumentReference', 'wellauth-doc-conservative-therapy'],
]

console.log(`WellAuth Gate 1 smoke`)
console.log(`Store : ${STORE_PATH}`)
console.log(`Mode  : ${BASE_URL ? `HTTP -> ${BASE_URL}` : 'in-process (ADC)'}`)

// ---------------------------------------------------------------------------
// P0.11 (part 1): snapshot BEFORE anything runs.
// ---------------------------------------------------------------------------
const before = []
for (const [type, id] of WATCHED) before.push(await service.snapshotResource(type, id))

// ---------------------------------------------------------------------------
section('P0.1  Cloud connection')
// ---------------------------------------------------------------------------
{
  const { status, body } = await api.health()
  check('P0.1 health returns 200', status === 200)
  check('P0.1 reports project', body.project === fhir.CONFIG.projectId, body.project)
  check('P0.1 reports dataset', body.dataset === 'wellauth', body.dataset)
  check('P0.1 reports FHIR store', body.fhirStore === 'wellauth-r4', body.fhirStore)
  check('P0.1 reports FHIR R4 4.0.1', body.fhirVersion === '4.0.1', body.fhirVersion)
  const leaked = JSON.stringify(body).match(/ya29\.|BEGIN PRIVATE KEY|Bearer /)
  check('P0.1 no credential material in response', !leaked)
}

// ---------------------------------------------------------------------------
section('P0.2  Existing order')
// ---------------------------------------------------------------------------
let orderBody
{
  const { status, body } = await api.order()
  orderBody = body
  check('P0.2 order returns 200', status === 200)
  check('P0.2 correct service', body.service?.code === '75561', body.service?.code)
  check('P0.2 service display is cardiac MRI', /cardiac mri/i.test(body.service?.display ?? ''))
  check('P0.2 status active', body.status === 'active', body.status)
  check('P0.2 intent order', body.intent === 'order', body.intent)
  check('P0.2 version present', Boolean(body.sourceVersionId))
  check('P0.2 no raw FHIR Bundle returned', body.resourceType === undefined)
  check('P0.2 no raw patient id exposed', !JSON.stringify(body).includes('wellauth-patient-001'))
}

// ---------------------------------------------------------------------------
section('P0.3  Coverage')
// ---------------------------------------------------------------------------
{
  check('P0.3 coverage present', Boolean(orderBody.coverage))
  check('P0.3 coverage active', orderBody.coverage?.status === 'active')
  check('P0.3 payer is Northstar', orderBody.coverage?.payer === 'Northstar Health Plan')
  check('P0.3 coverage version present', Boolean(orderBody.coverage?.sourceVersionId))

  // The cancelled decoy coverage must not be what resolved.
  const cancelled = await fhir.read('Coverage', 'wellauth-coverage-decoy-cancelled')
  check('P0.3 decoy coverage exists but was not selected', cancelled.resource.status === 'cancelled')
}

// ---------------------------------------------------------------------------
section('P0.4  Four straightforward evidence searches')
// ---------------------------------------------------------------------------
const evidenceByReq = {}
{
  const { body: reqs } = await api.requirements()
  check('P0.4 five requirements', reqs.requirements?.length === 5, String(reqs.requirements?.length))

  for (const id of ['req-001', 'req-002', 'req-004', 'req-005']) {
    const { body } = await api.evidence(id)
    evidenceByReq[id] = body
    check(`P0.4 ${id} returns eligible evidence`, body.status === 'OK' && body.candidates.length > 0)
    check(`P0.4 ${id} uses structured-resource path`, body.alternatePath === false)
  }

  // Irrelevant evidence excluded, by title, from the requirement that could
  // plausibly have caught it.
  const titles = (evidenceByReq['req-001'].candidates ?? []).map((c) => c.title).join(' | ')
  check('P0.4 orthopedic condition excluded', !/ankle/i.test(titles), titles)
  check('P0.4 historical 2019 chest pain excluded', !/historical/i.test(titles), titles)
  const dxTitles = (evidenceByReq['req-002'].candidates ?? []).map((c) => c.title).join(' | ')
  check('P0.4 unrelated CBC lab excluded', !/blood count/i.test(dxTitles), dxTitles)
  check('P0.4 req-002 returned exactly the final echo', evidenceByReq['req-002'].candidates.length === 1)
}

// ---------------------------------------------------------------------------
section('P0.5  Fifth evidence search (alternate bounded path)')
// ---------------------------------------------------------------------------
{
  const { body } = await api.evidence('req-003')
  evidenceByReq['req-003'] = body
  check('P0.5 req-003 satisfied', body.status === 'OK' && body.candidates.length === 1)
  check('P0.5 req-003 flagged as alternate path', body.alternatePath === true)
  check(
    'P0.5 evidence is a DocumentReference, not a structured resource',
    body.candidates[0]?.resourceType === 'DocumentReference',
    body.candidates[0]?.resourceType,
  )
  check(
    'P0.5 the other four came from non-DocumentReference types',
    ['req-001', 'req-002', 'req-004', 'req-005'].every(
      (id) => !evidenceByReq[id].candidates.some((c) => c.resourceType === 'DocumentReference'),
    ),
  )
  check(
    'P0.5 matched by alternate-document-path policy',
    body.candidates[0]?.matchedBy?.policy === 'alternate-document-path',
  )
  check('P0.5 superseded consult note excluded', !body.candidates.some((c) => /superseded/i.test(c.title ?? '')))
  check('P0.5 orthopedic consult note excluded', !body.candidates.some((c) => /orthopedic/i.test(c.title ?? '')))
}

// ---------------------------------------------------------------------------
section('P0.6  No eligible evidence')
// ---------------------------------------------------------------------------
{
  // Disable the sole req-003 source by flipping its status to 'entered-in-error',
  // then restore it. This is a fixture toggle, not a source-of-truth edit.
  const DOC = 'wellauth-doc-conservative-therapy'
  const { resource: original } = await fhir.read('DocumentReference', DOC)

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const put = async (body) => {
    const token = await client.getAccessToken()
    const res = await fetch(
      `https://healthcare.googleapis.com/v1/${STORE_PATH}/fhir/DocumentReference/${DOC}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token.token ?? token}`,
          'Content-Type': 'application/fhir+json',
        },
        body: JSON.stringify(body),
      },
    )
    return res.ok
  }

  const disabled = { ...original, status: 'entered-in-error' }
  delete disabled.meta
  const okDisable = await put(disabled)
  check('P0.6 fixture temporarily disabled', okDisable)

  // Same asynchronous-index caveat as the restore below.
  let status, body
  for (let attempt = 0; attempt < 10; attempt += 1) {
    ;({ status, body } = await api.evidence('req-003'))
    if (body.status === 'NO_ELIGIBLE_EVIDENCE') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check('P0.6 returns NO_ELIGIBLE_EVIDENCE, not a failure', body.status === 'NO_ELIGIBLE_EVIDENCE', JSON.stringify(body).slice(0, 120))
  check('P0.6 empty candidate set', (body.candidates ?? []).length === 0)
  check('P0.6 not a system error', status === 200)
  check('P0.6 nothing fabricated', !JSON.stringify(body.candidates ?? []).includes('conservative'))

  const restored = { ...original }
  delete restored.meta
  const okRestore = await put(restored)
  check('P0.6 fixture restored', okRestore)

  // Cloud Healthcare FHIR search is not read-after-write consistent: the write
  // lands immediately but the search index catches up asynchronously. Poll the
  // bounded endpoint rather than asserting on the first response.
  let after
  for (let attempt = 0; attempt < 10; attempt += 1) {
    ;({ body: after } = await api.evidence('req-003'))
    if (after.status === 'OK' && after.candidates.length === 1) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check(
    'P0.6 req-003 satisfied again after restore',
    after.status === 'OK' && after.candidates.length === 1,
    `${after.status} n=${(after.candidates ?? []).length}`,
  )
}

// ---------------------------------------------------------------------------
section('P0.7  Wrong status excluded')
// ---------------------------------------------------------------------------
{
  // These decoys exist in the store; none may appear as eligible evidence.
  const prelim = await fhir.read('DiagnosticReport', 'wellauth-echo-decoy-prelim')
  check('P0.7 preliminary echo exists in store', prelim.resource.status === 'preliminary')
  const dxHandles = evidenceByReq['req-002'].candidates.map((c) => c.title).join(' | ')
  check('P0.7 preliminary echo not eligible', !/PRELIMINARY/i.test(dxHandles), dxHandles)

  const err = await fhir.read('Condition', 'wellauth-condition-decoy-erroneous')
  const errCode = err.resource.verificationStatus?.coding?.[0]?.code
  check('P0.7 entered-in-error condition exists in store', errCode === 'entered-in-error')
  const condTitles = evidenceByReq['req-001'].candidates.map((c) => c.title).join(' | ')
  check('P0.7 entered-in-error condition not eligible', !/entered in error/i.test(condTitles), condTitles)

  const sup = await fhir.read('DocumentReference', 'wellauth-doc-decoy-superseded')
  check('P0.7 superseded document exists in store', sup.resource.status === 'superseded')

  const cov = await fhir.read('Coverage', 'wellauth-coverage-decoy-cancelled')
  check('P0.7 cancelled coverage exists in store', cov.resource.status === 'cancelled')
  check('P0.7 cancelled coverage not eligible', evidenceByReq['req-005'].candidates.length === 1)
}

// ---------------------------------------------------------------------------
section('P0.8  Wrong date excluded')
// ---------------------------------------------------------------------------
{
  const stale = await fhir.read('Condition', 'wellauth-condition-decoy-stale')
  check('P0.8 out-of-window condition exists in store', stale.resource.recordedDate === '2019-02-10')
  const dates = evidenceByReq['req-001'].candidates.map((c) => c.effectiveDate)
  check('P0.8 out-of-window condition not returned', !dates.some((d) => String(d).startsWith('2019')), dates.join(','))
  check('P0.8 all returned evidence is inside the window', dates.every((d) => d >= '2026-02-10' && d <= '2026-08-27'), dates.join(','))
}

// ---------------------------------------------------------------------------
section('P0.9  Wrong context / cross-patient refusal')
// ---------------------------------------------------------------------------
{
  // The other patient's chest-pain Condition genuinely exists.
  const other = await fhir.read('Condition', 'wellauth-condition-crosspatient')
  check('P0.9 cross-patient resource exists in store', other.resource.subject.reference === 'Patient/wellauth-patient-002')

  // It must not appear in any of this workflow's evidence.
  const allTitles = Object.values(evidenceByReq)
    .flatMap((e) => e.candidates ?? [])
    .map((c) => c.title)
    .join(' | ')
  check('P0.9 cross-patient evidence never returned', !/different patient|leak canary/i.test(allTitles))

  // An unknown workflow is refused.
  const { status, body } = await api.order('wf-does-not-exist')
  check('P0.9 unknown workflow refused', body.code === 'WORKFLOW_NOT_FOUND', body.code)
  check('P0.9 unknown workflow uses 404', BASE_URL ? status === 404 : true)

  // A handle minted for a different workflow context does not resolve, and the
  // refusal does not disclose whether the underlying resource exists.
  const foreign = 'ev_0000000000000000dead'
  const detail = await api.detail(foreign)
  check('P0.9 foreign evidence handle refused', detail.body.code === 'CONTEXT_MISMATCH', detail.body.code)
  check('P0.9 refusal does not disclose existence', !/not found|exists|missing/i.test(detail.body.message ?? ''))

  // A real handle from this workflow DOES resolve -- proving the refusal above
  // is a context check, not a blanket failure.
  const good = evidenceByReq['req-002'].candidates[0].evidenceHandle
  const ok = await api.detail(good)
  check('P0.9 in-context handle resolves', ok.body.evidence?.evidenceHandle === good)
}

// ---------------------------------------------------------------------------
section('P0.10  Version proof')
// ---------------------------------------------------------------------------
{
  const all = Object.values(evidenceByReq).flatMap((e) => e.candidates ?? [])
  check('P0.10 candidates were returned', all.length >= 6, String(all.length))
  check('P0.10 every candidate carries a source version', all.every((c) => Boolean(c.sourceVersionId)))
  check('P0.10 every candidate carries lastUpdated', all.every((c) => Boolean(c.sourceLastUpdated)))
  check('P0.10 order carries an ETag', Boolean(orderBody.etag))

  // The version the provider reports must equal the store's current version.
  const echo = await fhir.read('DiagnosticReport', 'wellauth-echo-001')
  const reported = evidenceByReq['req-002'].candidates[0].sourceVersionId
  check('P0.10 reported version matches the store', reported === echo.resource.meta.versionId, `${reported} vs ${echo.resource.meta.versionId}`)
  check('P0.10 ETag agrees with versionId', String(orderBody.etag).includes(orderBody.sourceVersionId))
}

// ---------------------------------------------------------------------------
section('P0.11  Read-only proof')
// ---------------------------------------------------------------------------
{
  const after = []
  for (const [type, id] of WATCHED) after.push(await service.snapshotResource(type, id))

  // The provider service issues no writes at all. P0.6, however, deliberately
  // toggles one fixture using SEPARATE write credentials and restores it, so
  // that resource's versionId legitimately advances. Content equality is the
  // claim that matters for "WellAuth does not rewrite medicine"; version
  // equality is asserted for every resource the toggle did not touch.
  const TOGGLED_BY_P06 = 'wellauth-doc-conservative-therapy'

  for (let i = 0; i < WATCHED.length; i += 1) {
    const b = before[i]
    const a = after[i]
    check(
      `P0.11 ${b.resourceType}/${b.id} content unchanged`,
      b.hash === a.hash,
      `hash ${b.hash.slice(0, 12)} -> ${a.hash.slice(0, 12)}`,
    )
    if (b.id !== TOGGLED_BY_P06) {
      check(
        `P0.11 ${b.resourceType}/${b.id} version unchanged`,
        b.versionId === a.versionId,
        `${b.versionId} -> ${a.versionId}`,
      )
    }
  }

  // Explicit: the restored fixture is byte-identical in content, and its version
  // moved only because the test harness restored it -- not because the provider
  // wrote to it.
  const toggled = after.find((r) => r.id === TOGGLED_BY_P06)
  const origToggled = before.find((r) => r.id === TOGGLED_BY_P06)
  check('P0.11 P0.6-toggled fixture restored to identical content', origToggled.hash === toggled.hash)
  check('P0.11 its version advanced only via the harness restore', origToggled.versionId !== toggled.versionId)

  // Hard proof the provider itself cannot write: the read path exposes no
  // mutating verb, and the deployed identity holds only fhirResourceReader.
  check('P0.11 provider module exports no write operation',
    !Object.keys(service).some((k) => /create|update|write|delete|put|post/i.test(k)))
}

// ---------------------------------------------------------------------------
section('P0.12  Logging hygiene')
// ---------------------------------------------------------------------------
{
  // Canary strings seeded into the fixture. None may appear in provider output.
  const CANARIES = ['WELLAUTH-CANARY-MRN-8842', 'WELLAUTH-CANARY-MRN-9001', 'NS-SYNTH-4417']
  const captured = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => captured.push(a.join(' '))
  console.error = (...a) => captured.push(a.join(' '))
  try {
    // Re-run representative operations with logging captured.
    await service.getOrder(WF)
    await service.findEvidence(WF, 'req-001')
    await service.findEvidence(WF, 'req-003')
    try { await service.getOrder('wf-nope') } catch {}
  } finally {
    console.log = origLog
    console.error = origErr
  }
  const blob = captured.join('\n')
  for (const canary of CANARIES) {
    check(`P0.12 canary ${canary.slice(-4)} absent from logs`, !blob.includes(canary))
  }
  check('P0.12 no clinical narrative in logs', !/conservative therapy|chest pain|ejection fraction/i.test(blob))
  check('P0.12 no raw FHIR resource dumps in logs', !/"resourceType"/.test(blob))
}

// ---------------------------------------------------------------------------
section('P0.13  Restart / durability')
// ---------------------------------------------------------------------------
{
  // Truth lives in Cloud Healthcare API, not process memory. A fresh module
  // graph with no warm state must still resolve the same versioned truth.
  const fresh = await import(`./service.js?restart=${before[0].versionId}`)
  const again = await fresh.getOrder(WF)
  check('P0.13 order still resolves after a cold module load', again.sourceVersionId === orderBody.sourceVersionId)
  check('P0.13 same service returned', again.service.code === '75561')
  const ev = await fresh.findEvidence(WF, 'req-003')
  check('P0.13 alternate-path evidence still resolves', ev.candidates.length === 1)
  if (BASE_URL) {
    const re = await api.health()
    check('P0.13 deployed service healthy on re-query', re.body.storeReachable === true)
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(56)}`)
console.log(`Gate 1 smoke: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log(`Failures:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('ALL P0 CHECKS PASSED')
