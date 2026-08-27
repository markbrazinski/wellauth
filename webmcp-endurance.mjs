/**
 * WebMCP terminal-transition endurance suite.
 *
 * Runs the COMPLETE Act I + Act II journey repeatedly in ONE browser process,
 * with a fresh judge session per run, and asserts the registration lifecycle
 * after every transition -- with particular attention to the final
 * REMEDIATION_APPROVED -> AUTHORIZATION_ALIGNED step, where the native WebMCP
 * implementation was intermittently reporting
 * "page configuration exceeded supported limits".
 *
 *   node webmcp-endurance.mjs [url] [runs]
 *
 * Proves, per run and cumulatively:
 *   - no configuration-limit / registration error;
 *   - no duplicate tools, ever;
 *   - no stale tools after a capability is withdrawn;
 *   - browser inventory === snapshot.availableTools at EVERY transition;
 *   - the run reaches AUTHORIZATION_ALIGNED with only read-only tools left;
 *   - registerTool calls do NOT accumulate run over run (lifecycle leakage).
 */

import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://localhost:8099'
const RUNS = Number(process.argv[3] ?? 10)

let pass = 0, fail = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++ }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const tools = (p) => p.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name).sort())
const rawTools = (p) => p.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name))
const wid = (p) => p.evaluate(() => sessionStorage.getItem('wellauth.session.workflow'))
const snap = (p) => p.evaluate(async () => {
  const w = sessionStorage.getItem('wellauth.session.workflow')
  const r = await fetch(`/workflows/${w}/snapshot`, { headers: { Accept: 'application/json' } })
  return r.json()
})
const call = (p, n, a = {}) => p.evaluate(async ([n, a]) => {
  const mc = document.modelContext
  const t = (await mc.getTools()).find((x) => x.name === n)
  if (!t) return { error: 'NOT_REGISTERED' }
  const r = await mc.executeTool(t, JSON.stringify(a))
  return typeof r === 'string' ? JSON.parse(r) : r
}, [n, a])
const diag = (p) => p.evaluate(() => ({
  registerCalls: window.__wellauthWebmcp?.registerCalls?.() ?? null,
  live: window.__wellauthWebmcp?.registered?.() ?? null,
  traces: (window.__wellauthWebmcp?.traces?.() ?? []).length,
}))
const lastTrace = (p) => p.evaluate(() => {
  const t = window.__wellauthWebmcp?.traces?.() ?? []
  return t[t.length - 1] ?? null
})

const same = (a, b) => [...a].sort().join(',') === [...b].sort().join(',')

/** Wait until the SERVER reports the expected state, then continue. */
async function waitForState(p, predicate, budgetMs = 20000) {
  let s = await snap(p)
  for (let waited = 0; waited <= budgetMs && !predicate(s); waited += 150) {
    await p.waitForTimeout(150)
    s = await snap(p)
  }
  return s
}

/** Wait for the page to settle, then assert the whole lifecycle invariant. */
async function assertTransition(p, label, run) {
  let browser = [], server = [], ok = false
  for (let waited = 0; waited <= 8000; waited += 100) {
    browser = await tools(p)
    server = [...(await snap(p)).availableTools].sort()
    if (same(browser, server)) { ok = true; break }
    await p.waitForTimeout(100)
  }
  check(`run${run} ${label} · inventory === availableTools`, ok,
    `\n        browser=${browser}\n        server =${server}`)

  const raw = await rawTools(p)
  check(`run${run} ${label} · no duplicate registrations`,
    new Set(raw).size === raw.length, raw.join(','))

  const d = await diag(p)
  check(`run${run} ${label} · local bookkeeping matches browser`,
    d.live === null || same(d.live, browser),
    `live=${d.live} browser=${browser}`)
  return browser
}

const READ_ONLY_TERMINAL = ['check_authorization_status', 'get_order_context']

async function oneRun(context, run, errors) {
  const p = await context.newPage()
  p.on('pageerror', (e) => errors.push(`run${run} pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(`run${run} console: ${m.text()}`)
  })

  await p.goto(URL, { waitUntil: 'networkidle' })
  await assertTransition(p, 'CONTEXT_READY', run)

  await call(p, 'discover_coverage_requirements')
  await waitForState(p, (s) => s.state === 'REQUIREMENTS_RESOLVED')
  await assertTransition(p, 'REQUIREMENTS_RESOLVED', run)

  for (const r of ['req-001', 'req-002', 'req-004', 'req-005', 'req-003']) {
    const f = await call(p, 'find_supporting_evidence', { requirement_id: r })
    if (!f?.candidates?.length) { check(`run${run} evidence for ${r}`, false, JSON.stringify(f).slice(0,80)); continue }
    await call(p, 'attach_evidence', { requirement_id: r, evidence_handle: f.candidates[0].evidenceHandle })
    await waitForState(p, (s) => s.bindings?.some((b) => b.requirementId === r))
    await assertTransition(p, `attach ${r}`, run)
  }

  await call(p, 'prepare_prior_authorization')
  await waitForState(p, (s) => s.state === 'PREPARED_AWAITING_APPROVAL')
  const prepared = await assertTransition(p, 'PREPARED_AWAITING_APPROVAL', run)
  check(`run${run} gate1 · no submit capability`,
    !prepared.includes('submit_prior_authorization'), prepared.join(','))

  await p.locator('[data-testid=approve-submission]').click()
  await waitForState(p, (s) => s.state === 'APPROVED')
  const approved = await assertTransition(p, 'APPROVED', run)
  check(`run${run} reveal1 · submit appeared`,
    approved.includes('submit_prior_authorization'), approved.join(','))

  await call(p, 'submit_prior_authorization')
  await waitForState(p, (s) => s.submission?.state === 'COMPLETE')
  await assertTransition(p, 'PAYER_APPROVED_COVERAGE_GAP', run)

  await call(p, 'resolve_authorization_window')
  await waitForState(p, (s) => s.act2?.phase === 'REMEDIATION_PREPARED')
  const remPrepared = await assertTransition(p, 'REMEDIATION_PREPARED', run)
  check(`run${run} gate2 · no extension capability`,
    !remPrepared.includes('submit_authorization_extension'), remPrepared.join(','))

  await p.locator('[data-testid=approve-remediation]').click()
  await waitForState(p, (s) => s.act2?.phase === 'REMEDIATION_APPROVED')
  const remApproved = await assertTransition(p, 'REMEDIATION_APPROVED', run)
  check(`run${run} reveal3 · extension submit appeared`,
    remApproved.includes('submit_authorization_extension'), remApproved.join(','))

  // ---- THE TERMINAL TRANSITION under investigation --------------------
  await call(p, 'submit_authorization_extension')
  await waitForState(p, (s) => s.act2?.phase === 'AUTHORIZATION_ALIGNED')
  const finalTools = await assertTransition(p, 'AUTHORIZATION_ALIGNED', run)

  const s = await snap(p)
  check(`run${run} final · state is AUTHORIZATION_ALIGNED`,
    s.act2?.phase === 'AUTHORIZATION_ALIGNED', String(s.act2?.phase))
  check(`run${run} final · submit_authorization_extension is GONE`,
    !finalTools.includes('submit_authorization_extension'), finalTools.join(','))
  check(`run${run} final · only terminal read-only tools remain`,
    same(finalTools, READ_ONLY_TERMINAL), finalTools.join(','))
  check(`run${run} final · WebMCP still usable (no disablement)`,
    (await p.evaluate(() => typeof document.modelContext?.getTools === 'function')))
  check(`run${run} final · no registration-failure banner`,
    (await p.locator('text=/registration failed|exceeded supported limits/i').count()) === 0)

  const d = await diag(p)
  const trace = await lastTrace(p)
  const id = await wid(p)
  await p.close()
  return { registerCalls: d.registerCalls, trace, workflowId: id, finalTools }
}

async function main() {
  const browser = await chromium.launch()
  // ONE browser process, ONE context: lifecycle leakage between runs shows up.
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const errors = []
  const perRun = []

  for (let run = 1; run <= RUNS; run++) {
    const r = await oneRun(context, run, errors)
    perRun.push(r)
    console.log(`  run ${String(run).padStart(2)}  registerTool calls (cumulative): ${r.registerCalls}` +
      `  final: ${r.finalTools.join(', ')}`)
  }

  // ---- lifecycle leakage across fresh judge sessions -------------------
  const ids = new Set(perRun.map((r) => r.workflowId))
  check('each run used a DISTINCT fresh judge session', ids.size === RUNS,
    `${ids.size} distinct of ${RUNS}`)

  // Per-run registerTool cost must be flat, not growing.
  const deltas = perRun.map((r, i) => i === 0 ? r.registerCalls : r.registerCalls - perRun[i-1].registerCalls)
  const first = deltas[1] ?? deltas[0]
  const worst = Math.max(...deltas.slice(1))
  check('registerTool calls per run do NOT accumulate',
    worst <= first * 1.5 + 2, `per-run deltas=${deltas.join(',')}`)

  const limitErrors = errors.filter((e) => /exceeded supported limits|configuration/i.test(e))
  check('no page-configuration-limit error in any run', limitErrors.length === 0,
    limitErrors.slice(0, 3).join(' | '))
  const realErrors = errors.filter((e) => !/favicon/i.test(e))
  check('no page errors across all runs', realErrors.length === 0,
    realErrors.slice(0, 5).join(' | '))

  await browser.close()

  console.log(`\n  per-run registerTool deltas: ${deltas.join(', ')}`)
  console.log(`  final inventory (last run)  : ${perRun.at(-1).finalTools.join(', ')}`)
  console.log('\n  FINAL TRANSITION TRACE (last run):')
  console.log('   ', JSON.stringify(perRun.at(-1).trace, null, 2).split('\n').join('\n    '))

  console.log('\n========================================================')
  console.log(`WebMCP endurance (${RUNS} runs): ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures.slice(0, 20)) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('ALL ENDURANCE CHECKS PASSED')
}

main().catch((e) => { console.error('harness error:', e); process.exit(1) })
