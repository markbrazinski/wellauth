// Gate 5 suite: judge-session determinism + read-only non-mutation (P0-1).
//
//   npm run test:gate5
//
// Against REAL Firestore and REAL Cloud Healthcare FHIR. Nothing is stubbed.
//
// WHAT THIS GATE PROVES
//   1. A fresh judge session begins at CONTEXT_READY, with no state inherited
//      from any previous session -- no approval, no submission, no payer
//      result, no mutation capability.
//   2. Two concurrent sessions are genuinely isolated: advancing one does not
//      move the other.
//   3. A "reload" (re-reading the same workflow id) preserves state exactly --
//      same state, same revision, same bindings.
//   4. Every read-only tool leaves state, revision, bindings, approval and
//      submission/remediation posture byte-identical. They cannot reset,
//      advance, regress, reconcile or reseed.
//   5. A session id is an identity, never an authorization: it resolves to the
//      one canonical clinical context and cannot widen access.

import { randomUUID } from 'node:crypto'
import * as service from './service.js'
import * as workflow from './workflow.js'
import * as submission from './submission.js'
import { capabilitiesFor } from './capabilities.js'
import { derivePosture } from './remediation.js'
import { DomainError } from './service.js'
import { SESSION_PREFIX, contextFor, isSessionWorkflowId } from './policy.js'
import { purgeWorkflow, workflowRef, bindingsCol } from './store.js'

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}
const section = (t) => console.log(`\n${t}`)

const newSession = () => `${SESSION_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 20)}`
const created = []
async function session() {
  const id = newSession()
  created.push(id)
  await workflow.createWorkflow(id)
  return id
}

/**
 * The complete observable posture of a workflow. Any read-only call that
 * changes ANY of this has mutated state.
 */
async function fingerprint(id) {
  const wf = await workflow.getWorkflow(id)
  const bindings = (await bindingsCol(id).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const raw = (await workflowRef(id).get()).data()
  const posture = derivePosture(raw, null)
  return JSON.stringify({
    state: wf.state,
    revision: wf.revision,
    completeness: wf.completeness,
    packetHash: wf.packetHash ?? null,
    approval: wf.approval ?? null,
    preparedRevision: wf.preparedRevision ?? null,
    manifestRevision: wf.manifestRevision ?? null,
    submission: raw.submission ?? null,
    remediation: raw.remediation ?? null,
    phase: posture.phase,
    bindings,
  })
}

try {
  // -----------------------------------------------------------------------
  section('G5.1  A fresh judge session starts deterministically at CONTEXT_READY')

  const a = await session()
  const wfA = await workflow.getWorkflow(a)
  check('G5.1 fresh session is CONTEXT_READY', wfA.state === 'CONTEXT_READY', wfA.state)
  check('G5.1 fresh session is at revision 1', wfA.revision === 1, String(wfA.revision))
  check('G5.1 fresh session has no evidence attached',
    wfA.completeness.satisfied === 0, String(wfA.completeness.satisfied))
  check('G5.1 fresh session has no approval', !wfA.approval)
  check('G5.1 fresh session has no packet hash', !wfA.packetHash)

  const rawA = (await workflowRef(a).get()).data()
  check('G5.1 fresh session has no submission', !rawA.submission)
  check('G5.1 fresh session has no remediation', !rawA.remediation)
  check('G5.1 fresh session has no payer result',
    !rawA.submission?.receipt && !rawA.submission?.payerStatus)

  const capsA = capabilitiesFor(rawA, derivePosture(rawA, null))
  check('G5.1 fresh session exposes NO submit capability',
    !capsA.includes('submit_prior_authorization'), capsA.join(','))
  check('G5.1 fresh session exposes NO extension capability',
    !capsA.includes('submit_authorization_extension'))
  check('G5.1 fresh session exposes NO remediation capability',
    !capsA.includes('resolve_authorization_window'))
  check('G5.1 fresh session exposes NO prepare capability',
    !capsA.includes('prepare_prior_authorization'))
  check('G5.1 fresh session exposes NO evidence mutation',
    !capsA.includes('attach_evidence'))

  // -----------------------------------------------------------------------
  section('G5.2  A previous session cannot leak into a new one')

  // Advance session A well past CONTEXT_READY.
  await workflow.resolveRequirements(a)
  const advA = await workflow.getWorkflow(a)
  check('G5.2 session A advanced', advA.state === 'REQUIREMENTS_RESOLVED', advA.state)

  const b = await session()
  const wfB = await workflow.getWorkflow(b)
  check('G5.2 the NEXT session still starts at CONTEXT_READY',
    wfB.state === 'CONTEXT_READY', wfB.state)
  check('G5.2 the next session starts at revision 1', wfB.revision === 1)
  check('G5.2 the two sessions are distinct documents', a !== b)

  const capsB = capabilitiesFor((await workflowRef(b).get()).data(), {})
  check('G5.2 the next session has no inherited mutation capability',
    !capsB.includes('attach_evidence') && !capsB.includes('submit_prior_authorization'))

  // -----------------------------------------------------------------------
  section('G5.3  Sessions are isolated: advancing one never moves another')

  const beforeB = await fingerprint(b)
  await workflow.resolveRequirements(b)
  const afterA = await workflow.getWorkflow(a)
  check('G5.3 advancing B left A at its own revision',
    afterA.revision === advA.revision, `${afterA.revision} vs ${advA.revision}`)
  check('G5.3 A and B hold independent state', beforeB !== (await fingerprint(a)))

  // -----------------------------------------------------------------------
  section('G5.4  Reload preserves an active session exactly')

  const beforeReload = await fingerprint(a)
  // A reload is exactly this: the same id re-read, plus the page's ensureWorkflow.
  await workflow.createWorkflow(a)
  const afterReload = await fingerprint(a)
  check('G5.4 reload preserved state, revision and bindings byte-for-byte',
    beforeReload === afterReload)
  check('G5.4 createWorkflow on an existing session is idempotent',
    (await workflow.getWorkflow(a)).revision === advA.revision)

  // -----------------------------------------------------------------------
  section('G5.5  Read-only tools mutate NOTHING')

  // Drive a session to a rich posture so there is real state to disturb.
  const c = await session()
  await workflow.resolveRequirements(c)
  const ev = await service.findEvidence(c, 'req-001')
  await workflow.attachEvidence(c, {
    requirementId: 'req-001',
    evidenceHandle: ev.candidates[0].evidenceHandle,
    expectedRevision: (await workflow.getWorkflow(c)).revision,
  })

  const READ_ONLY = [
    ['get_order_context', () => service.getOrder(c)],
    ['find_supporting_evidence', () => service.findEvidence(c, 'req-002')],
    ['find_supporting_evidence (alternate path)', () => service.findEvidence(c, 'req-003')],
    ['inspect_evidence', async () =>
      service.getEvidenceDetail(c, ev.candidates[0].evidenceHandle)],
    ['check_authorization_status', () => submission.checkAuthorizationStatus(c)],
    ['get_workflow (snapshot read)', () => workflow.getWorkflow(c)],
    ['get_requirements', () => service.getRequirements(c)],
    ['get_patient', () => service.getPatient(c)],
  ]

  const before = await fingerprint(c)
  for (const [name, call] of READ_ONLY) {
    try { await call() } catch (e) {
      // A bounded refusal is fine; an unexpected throw is not.
      if (!(e instanceof DomainError)) throw e
    }
    const after = await fingerprint(c)
    check(`G5.5 ${name} left workflow state unchanged`, after === before)
  }

  // Repeat the whole read-only set many times: a mutation that only shows up
  // on the Nth call is still a mutation.
  for (let i = 0; i < 3; i++) {
    for (const [, call] of READ_ONLY) {
      try { await call() } catch (e) { if (!(e instanceof DomainError)) throw e }
    }
  }
  check('G5.5 repeated read-only calls still changed nothing',
    (await fingerprint(c)) === before)

  // Explicit negative: read-only calls cannot RESET or RESEED.
  const cState = await workflow.getWorkflow(c)
  check('G5.5 read-only calls did not reset state to CONTEXT_READY',
    cState.state !== 'CONTEXT_READY', cState.state)
  check('G5.5 read-only calls did not regress the revision',
    cState.revision >= 3, String(cState.revision))
  check('G5.5 read-only calls did not drop the attached binding',
    cState.completeness.satisfied === 1, String(cState.completeness.satisfied))

  // -----------------------------------------------------------------------
  section('G5.6  A session id is an identity, not an authorization')

  check('G5.6 a session id resolves to the canonical clinical context',
    contextFor(a).patientId === contextFor('wf-wellauth-001').patientId)
  check('G5.6 a session id cannot name another patient',
    contextFor(a).patientId === 'wellauth-patient-001')
  check('G5.6 a malformed id resolves to nothing', contextFor('../etc/passwd') === undefined)
  check('G5.6 an unknown id resolves to nothing', contextFor('wf-not-real') === undefined)
  check('G5.6 a session id is recognised', isSessionWorkflowId(a))
  check('G5.6 the canonical id is NOT a session id', !isSessionWorkflowId('wf-wellauth-001'))

  let refused = false
  try { await workflow.getWorkflow('wf-not-real') } catch (e) { refused = e instanceof DomainError }
  check('G5.6 an unknown workflow id is refused', refused)

} finally {
  // This gate creates its own sessions; it cleans up exactly those.
  for (const id of created) {
    try { await purgeWorkflow(id) } catch { /* best effort */ }
  }
}

console.log('\n========================================================')
console.log(`Gate 5 suite: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('ALL GATE 5 CHECKS PASSED')
