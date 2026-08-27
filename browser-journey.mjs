/**
 * FULL Act I + Act II browser journey, in a real browser, with NO reload.
 *
 *   node browser-journey.mjs [url]
 *
 * Proves the commission's central WebMCP invariant:
 *
 *     native browser WebMCP inventory === snapshot.availableTools
 *
 * after EVERY capability transition -- including the second human approval,
 * where the audit saw WebMCP become unavailable.
 *
 * Also proves, in the same unbroken page session:
 *   - a fresh session starts at CONTEXT_READY with no inherited state;
 *   - a reload preserves the ACTIVE session;
 *   - read-only tools never move workflow state or revision;
 *   - exactly one payer submission and exactly one extension submission;
 *   - the final status payload agrees with the page.
 */

import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://localhost:8099'

let pass = 0, fail = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}
const section = (t) => console.log(`\n${t}`)

const tools = (p) => p.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name).sort())

/** Invokes a tool exactly the way a browser agent runtime does. */
const call = (p, name, args = {}) => p.evaluate(async ([n, a]) => {
  const mc = document.modelContext
  const t = (await mc.getTools()).find((x) => x.name === n)
  if (!t) return { error: 'NOT_REGISTERED' }
  const raw = await mc.executeTool(t, JSON.stringify(a))
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}, [name, args])

/** The workflow id this tab minted, so the harness can read the same truth. */
const workflowId = (p) => p.evaluate(() =>
  sessionStorage.getItem('wellauth.session.workflow'))

const snapshot = async (p) =>
  (await fetch(`${URL}/workflows/${await workflowId(p)}/snapshot`)).json()

const text = (p, sel) => p.evaluate((s) =>
  document.querySelector(s)?.textContent?.trim() ?? null, sel)

/** Wait for rendered text to match, so a DOM assertion never races React. */
async function waitForText(p, sel, re, budgetMs = 6000) {
  let t = await text(p, sel)
  for (let waited = 0; waited <= budgetMs && !re.test(t ?? ''); waited += 150) {
    await p.waitForTimeout(150)
    t = await text(p, sel)
  }
  return t
}

const sameSet = (a, b) => [...a].sort().join(',') === [...b].sort().join(',')

/**
 * THE invariant: browser inventory must equal the server's list.
 *
 * Registration is asynchronous (the page re-reads the snapshot, then syncs
 * WebMCP), so the assertion waits for the page to go QUIESCENT rather than
 * sampling at an arbitrary instant -- sampling mid-sync measures the harness's
 * timing, not the application's correctness. Convergence is bounded: if the
 * inventory has not matched within the budget, that IS a real failure.
 *
 * The budget is deliberately generous relative to the ~200ms observed worst
 * case, so a pass means "converged", never "raced and got lucky".
 */
const SETTLE_BUDGET_MS = 6000

async function assertInventoryMatches(p, label) {
  let browser = []
  let server = []
  let settledIn = -1
  for (let waited = 0; waited <= SETTLE_BUDGET_MS; waited += 100) {
    browser = await tools(p)
    server = [...(await snapshot(p)).availableTools].sort()
    if (sameSet(browser, server)) { settledIn = waited; break }
    await p.waitForTimeout(100)
  }
  check(`${label} · browser inventory === snapshot.availableTools`,
    settledIn >= 0,
    `did not converge in ${SETTLE_BUDGET_MS}ms` +
    `\n        browser=${browser}\n        server =${server}`)
  check(`${label} · no duplicate registrations`,
    new Set(browser).size === browser.length, browser.join(','))
  if (settledIn > 0) console.log(`        (converged in ${settledIn}ms)`)
  return browser
}

/** Wait until the server reports the expected state before asserting on it. */
async function waitForState(p, predicate, budgetMs = 8000) {
  let snap = await snapshot(p)
  for (let waited = 0; waited <= budgetMs && !predicate(snap); waited += 150) {
    await p.waitForTimeout(150)
    snap = await snapshot(p)
  }
  return snap
}

const trace = []

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors = []
  const consoleErrors = []
  const failedRequests = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`) })

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  // =======================================================================
  section('J1  A fresh judge session starts at CONTEXT_READY')
  const wid = await workflowId(page)
  check('J1 the tab minted its own session workflow id',
    Boolean(wid) && wid.startsWith('wf-wellauth-s-'), String(wid))
  let snap = await snapshot(page)
  check('J1 fresh session is CONTEXT_READY', snap.state === 'CONTEXT_READY', snap.state)
  check('J1 fresh session has no approval', !snap.approval)
  check('J1 fresh session has no submission', !snap.submission)
  check('J1 fresh session has no payer result', !snap.submission?.payerStatus)
  check('J1 fresh session shows no mutation capability',
    !snap.availableTools.includes('submit_prior_authorization') &&
    !snap.availableTools.includes('submit_authorization_extension'))
  trace.push(['CONTEXT_READY', await assertInventoryMatches(page, 'J1 CONTEXT_READY')])

  // =======================================================================
  section('J2  Read-only tools mutate nothing')
  const beforeRev = snap.revision
  const beforeState = snap.state
  for (const t of ['get_order_context']) await call(page, t)
  await page.waitForTimeout(1200)
  snap = await snapshot(page)
  check('J2 get_order_context left state unchanged', snap.state === beforeState, snap.state)
  check('J2 get_order_context left revision unchanged',
    snap.revision === beforeRev, `${beforeRev} -> ${snap.revision}`)

  // =======================================================================
  section('J3  Requirements discovered -> the page populates')
  const rowsBefore = await page.locator('[data-testid^=req-req-]').count()
  await call(page, 'discover_coverage_requirements')
  await page.waitForTimeout(2000)
  const rowsAfter = await page.locator('[data-testid^=req-req-]').count()
  check('J3 requirement rows appeared', rowsBefore === 0 && rowsAfter === 5,
    `${rowsBefore} -> ${rowsAfter}`)
  trace.push(['REQUIREMENTS_RESOLVED', await assertInventoryMatches(page, 'J3 REQUIREMENTS_RESOLVED')])

  // =======================================================================
  section('J4  Four of five requirements satisfied')
  for (const r of ['req-001', 'req-002', 'req-004', 'req-005']) {
    const found = await call(page, 'find_supporting_evidence', { requirement_id: r })
    const handle = found?.candidates?.[0]?.evidenceHandle
    if (!handle) { check(`J4 evidence found for ${r}`, false, JSON.stringify(found).slice(0, 160)); continue }
    await call(page, 'attach_evidence', { requirement_id: r, evidence_handle: handle })
    await page.waitForTimeout(600)
  }
  snap = await waitForState(page, (x) => x.completeness?.satisfied === 4)
  check('J4 four requirements are satisfied', snap.completeness.satisfied === 4,
    String(snap.completeness.satisfied))
  const c4 = await waitForText(page, '[data-testid=counter]', /4\s*\/\s*5/)
  check('J4 the counter reads 4 / 5', /4\s*\/\s*5/.test(c4 ?? ''), String(c4))
  check('J4 prepare is NOT yet available',
    !snap.availableTools.includes('prepare_prior_authorization'))
  trace.push(['4 of 5', await assertInventoryMatches(page, 'J4 4-of-5')])

  // =======================================================================
  section('J5  The fifth beat: alternate evidence path')
  const alt = await call(page, 'find_supporting_evidence', { requirement_id: 'req-003' })
  check('J5 req-003 is served by the alternate path', alt?.alternatePath === true,
    JSON.stringify(alt?.alternatePath))
  const altHandle = alt?.candidates?.[0]?.evidenceHandle
  check('J5 authoritative evidence was located elsewhere in the record', Boolean(altHandle))
  await call(page, 'attach_evidence', { requirement_id: 'req-003', evidence_handle: altHandle })
  snap = await waitForState(page, (x) => x.completeness?.satisfied === 5)
  check('J5 five of five satisfied', snap.completeness.satisfied === 5,
    String(snap.completeness.satisfied))
  const c5 = await waitForText(page, '[data-testid=counter]', /5\s*\/\s*5/)
  check('J5 the counter reads 5 / 5', /5\s*\/\s*5/.test(c5 ?? ''), String(c5))
  // P1-1: the beat must be VISIBLE, not just true in the data.
  const altText = await text(page, '[data-testid=alt-path-req-003]')
  check('J5 the page explains WHY req-003 was satisfied differently',
    Boolean(altText) && /elsewhere|notes|structured/i.test(altText), String(altText))
  check('J5 prepare became available',
    snap.availableTools.includes('prepare_prior_authorization'))
  trace.push(['5 of 5 / PACKET_COMPLETE', await assertInventoryMatches(page, 'J5 PACKET_COMPLETE')])

  // =======================================================================
  section('J6  Prepare -> the human gate closes on the agent')
  await call(page, 'prepare_prior_authorization')
  snap = await waitForState(page, (x) => x.state === 'PREPARED_AWAITING_APPROVAL')
  check('J6 workflow is PREPARED_AWAITING_APPROVAL',
    snap.state === 'PREPARED_AWAITING_APPROVAL', snap.state)
  const preparedTools = await assertInventoryMatches(page, 'J6 PREPARED_AWAITING_APPROVAL')
  check('J6 the agent has NO submission capability while awaiting approval',
    !preparedTools.includes('submit_prior_authorization'), preparedTools.join(','))
  check('J6 the proposed disclosure is shown for review',
    (await page.locator('[data-testid=disclosure-items]').count()) === 1)
  trace.push(['PREPARED_AWAITING_APPROVAL', preparedTools])

  // A refusal proof: the capability is genuinely absent, not merely hidden.
  const forged = await call(page, 'submit_prior_authorization')
  check('J6 submitting before approval is impossible from the browser',
    forged?.error === 'NOT_REGISTERED', JSON.stringify(forged).slice(0, 120))

  // =======================================================================
  section('J7  Human approval unlocks submit -- with NO reload')
  await page.locator('[data-testid=approve-submission]').click()
  snap = await waitForState(page, (x) => x.state === 'APPROVED')
  check('J7 workflow is APPROVED', snap.state === 'APPROVED', snap.state)
  check('J7 approval is bound to a workforce user',
    snap.approval?.approvedBy === 'A. Reyes', String(snap.approval?.approvedBy))
  const approvedTools = await assertInventoryMatches(page, 'J7 APPROVED')
  check('J7 submit_prior_authorization appeared without a reload',
    approvedTools.includes('submit_prior_authorization'), approvedTools.join(','))
  trace.push(['APPROVED', approvedTools])

  // =======================================================================
  section('J8  Exactly one payer submission')
  await call(page, 'submit_prior_authorization')
  snap = await waitForState(page, (x) => x.submission?.state === 'COMPLETE')
  check('J8 the payer answered', snap.submission?.state === 'COMPLETE',
    String(snap.submission?.state))
  check('J8 the simulated payer approved', snap.submission?.payerStatus === 'approved',
    String(snap.submission?.payerStatus))
  check('J8 exactly ONE transmission was made', snap.submission?.attempts === 1,
    String(snap.submission?.attempts))
  check('J8 payer reference is NS-40192', snap.submission?.payerReference === 'NS-40192',
    String(snap.submission?.payerReference))
  trace.push(['SUBMITTED / payer approved', await assertInventoryMatches(page, 'J8 payer answered')])

  // =======================================================================
  section('J9  Act II: the window mismatch opens a NEW capability')
  check('J9 the payer approved but the window misses the MRI',
    snap.act2?.phase === 'PAYER_APPROVED_COVERAGE_GAP', String(snap.act2?.phase))
  check('J9 the page states the scheduled date is not covered',
    /not cover/i.test(await text(page, '[data-testid=coverage-state]') ?? ''),
    await text(page, '[data-testid=coverage-state]'))
  const gapTools = await assertInventoryMatches(page, 'J9 PAYER_APPROVED_COVERAGE_GAP')
  check('J9 resolve_authorization_window appeared from EXTERNAL payer state',
    gapTools.includes('resolve_authorization_window'), gapTools.join(','))
  trace.push(['PAYER_APPROVED_COVERAGE_GAP', gapTools])

  // =======================================================================
  section('J10 Remediation prepared -> second human gate')
  await call(page, 'resolve_authorization_window')
  snap = await waitForState(page, (x) => x.act2?.phase === 'REMEDIATION_PREPARED')
  check('J10 remediation is prepared', snap.act2?.phase === 'REMEDIATION_PREPARED',
    String(snap.act2?.phase))
  const remPrepTools = await assertInventoryMatches(page, 'J10 REMEDIATION_PREPARED')
  check('J10 the agent has NO extension-submission capability yet',
    !remPrepTools.includes('submit_authorization_extension'), remPrepTools.join(','))
  trace.push(['REMEDIATION_PREPARED', remPrepTools])

  // =======================================================================
  section('J11 THE AUDIT FAILURE POINT: second approval -> WebMCP must survive')
  await page.locator('[data-testid=approve-remediation]').click()
  await waitForState(page, (x) => x.act2?.phase === 'REMEDIATION_APPROVED')

  // WebMCP itself must still be present and usable -- this is exactly where
  // the audit saw it become unavailable.
  const mcAlive = await page.evaluate(() =>
    typeof document.modelContext?.getTools === 'function')
  check('J11 document.modelContext is STILL available after the 2nd approval', mcAlive)
  const noRegFailure = await page.locator('text=WebMCP registration failed').count()
  check('J11 no WebMCP registration failure is shown', noRegFailure === 0)

  snap = await snapshot(page)
  check('J11 remediation is approved', snap.act2?.phase === 'REMEDIATION_APPROVED',
    String(snap.act2?.phase))
  const remApprTools = await assertInventoryMatches(page, 'J11 REMEDIATION_APPROVED')
  check('J11 submit_authorization_extension appeared with NO reload',
    remApprTools.includes('submit_authorization_extension'), remApprTools.join(','))
  trace.push(['REMEDIATION_APPROVED', remApprTools])

  // =======================================================================
  section('J12 Exactly one extension submission -> authorization aligned')
  await call(page, 'submit_authorization_extension')
  snap = await waitForState(page, (x) => x.act2?.phase === 'AUTHORIZATION_ALIGNED')
  check('J12 authorization is aligned', snap.act2?.phase === 'AUTHORIZATION_ALIGNED',
    String(snap.act2?.phase))
  check('J12 validity now runs through Oct 3',
    snap.remediation?.currentValidThrough === '2026-10-03',
    String(snap.remediation?.currentValidThrough))
  check('J12 exactly ONE extension transmission',
    (snap.remediation?.submission?.attempts ?? 1) === 1,
    String(snap.remediation?.submission?.attempts))
  trace.push(['AUTHORIZATION_ALIGNED', await assertInventoryMatches(page, 'J12 AUTHORIZATION_ALIGNED')])

  // =======================================================================
  section('J13 FINAL TRUTH: every surface agrees')
  const status = await call(page, 'check_authorization_status')
  check('J13 status reports validity through 2026-10-03',
    status?.validThrough === '2026-10-03', String(status?.validThrough))
  check('J13 status reports the scheduled MRI as 2026-09-18',
    status?.scheduledServiceDate === '2026-09-18', String(status?.scheduledServiceDate))
  check('J13 status reports coversScheduledServiceDate = true',
    status?.coversScheduledServiceDate === true, String(status?.coversScheduledServiceDate))
  check('J13 status reports payer reference NS-40192',
    status?.payerReference === 'NS-40192', String(status?.payerReference))
  check('J13 status reports payer Northstar Health Plan',
    status?.payer === 'Northstar Health Plan', String(status?.payer))
  check('J13 status reports the payer decision as approved',
    status?.payerStatus === 'approved', String(status?.payerStatus))
  check('J13 status reports administrative readiness = ready',
    status?.administrativeReadiness === 'ready', String(status?.administrativeReadiness))
  check('J13 the ORIGINAL Sep 12 receipt is preserved as history',
    status?.originalAuthorization?.authorizationPeriod?.end === '2026-09-12',
    JSON.stringify(status?.originalAuthorization?.authorizationPeriod))
  check('J13 status is still labelled SIMULATED', status?.simulated === true)

  // The UI must agree with the tool.
  const finalValidity = await text(page, '.final-validity')
  check('J13 the page shows the same Oct 3 validity',
    /Oct 3/.test(finalValidity ?? ''), String(finalValidity))
  check('J13 the page shows the MRI as covered',
    /covered/i.test(await text(page, '[data-testid=final-coverage]') ?? ''),
    await text(page, '[data-testid=final-coverage]'))
  check('J13 the page shows administrative readiness Ready',
    /ready/i.test(await text(page, '[data-testid=final-readiness]') ?? ''),
    await text(page, '[data-testid=final-readiness]'))

  console.log('\n  FINAL check_authorization_status payload:')
  console.log(JSON.stringify(status, null, 2).split('\n').map((l) => `    ${l}`).join('\n'))

  // =======================================================================
  section('J14 A reload PRESERVES this active session')
  const beforeReload = await snapshot(page)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2800)
  const sameId = await workflowId(page)
  check('J14 the reload kept the SAME session id', sameId === wid, `${wid} -> ${sameId}`)
  const afterReload = await snapshot(page)
  check('J14 state survived the reload',
    afterReload.state === beforeReload.state && afterReload.revision === beforeReload.revision,
    `${beforeReload.state}/${beforeReload.revision} -> ${afterReload.state}/${afterReload.revision}`)
  check('J14 Act II phase survived the reload',
    afterReload.act2?.phase === 'AUTHORIZATION_ALIGNED', String(afterReload.act2?.phase))
  await assertInventoryMatches(page, 'J14 after reload')

  // =======================================================================
  section('J15 A NEW tab is a NEW judge, at CONTEXT_READY')
  const page2 = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page2.goto(URL, { waitUntil: 'networkidle' })
  await page2.waitForTimeout(2500)
  const wid2 = await workflowId(page2)
  check('J15 the new tab minted a DIFFERENT session', wid2 !== wid, `${wid} vs ${wid2}`)
  const snap2 = await snapshot(page2)
  check('J15 the new judge starts at CONTEXT_READY', snap2.state === 'CONTEXT_READY', snap2.state)
  check('J15 the new judge inherits NO approval', !snap2.approval)
  check('J15 the new judge inherits NO submission', !snap2.submission)
  check('J15 the new judge inherits NO payer result', !snap2.submission?.payerStatus)
  check('J15 the new judge has NO submit capability',
    !snap2.availableTools.includes('submit_prior_authorization'))
  check('J15 the FIRST judge is still aligned and untouched',
    (await snapshot(page)).act2?.phase === 'AUTHORIZATION_ALIGNED')
  await page2.close()

  // =======================================================================
  section('J16 Console / network hygiene')
  check('J16 no uncaught page errors', errors.length === 0, errors.slice(0, 3).join('; '))
  const realFailures = failedRequests.filter((f) => !/favicon/i.test(f))
  check('J16 no failed requests', realFailures.length === 0, realFailures.slice(0, 3).join('; '))
  const realConsole = consoleErrors.filter((c) => !/favicon/i.test(c))
  check('J16 no console errors', realConsole.length === 0, realConsole.slice(0, 3).join('; '))

  await browser.close()

  // =======================================================================
  console.log('\nWebMCP INVENTORY TRACE')
  for (const [label, inv] of trace) {
    console.log(`  ${label.padEnd(32)} ${inv.length} :: ${inv.join(', ')}`)
  }

  console.log('\n========================================================')
  console.log(`Browser journey: ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('FULL ACT I + ACT II JOURNEY PASSED')
}

main().catch((e) => { console.error('harness error:', e); process.exit(1) })
