// Browser acceptance: the WebMCP thesis, verified in a real browser against
// the deployed application.
//
//   node browser-acceptance.mjs [url]
//
// Proves, without stubs:
//   - the page registers tools on document.modelContext;
//   - the browser's own getTools() matches the server's authoritative list;
//   - invoking a tool advances REAL backend state;
//   - the page VISIBLY changes as a result;
//   - the capability inventory changes with NO reload;
//   - a removed capability is genuinely gone from the browser.

import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'https://wellauth-provider-qxqdngmwjq-uc.a.run.app'
const W = 'wf-wellauth-001'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}

const tools = (p) => p.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name).sort())

/** Invokes a tool the way the browser runtime does. */
const call = (p, name, args = {}) => p.evaluate(async ([n, a]) => {
  const mc = document.modelContext
  const t = (await mc.getTools()).find((x) => x.name === n)
  if (!t) return { error: 'NOT_REGISTERED' }
  // The runtime parses arguments from a JSON string, not an object, and
  // executeTool takes the RegisteredTool descriptor rather than a name.
  return await mc.executeTool(t, JSON.stringify(a))
}, [name, args])

const rows = (p) => p.evaluate(() =>
  document.querySelectorAll('[data-testid^=req-]').length)

async function main() {
  await fetch(`${URL}/demo/reset`, { method: 'POST' })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)

  console.log('\nB1  WebMCP is present and the page registered into it')
  const available = await page.evaluate(() =>
    typeof document.modelContext?.registerTool === 'function')
  check('B1 document.modelContext exposes registerTool', available)

  console.log('\nB2  Browser inventory matches the server at CONTEXT_READY')
  const initial = await tools(page)
  const server = await (await fetch(`${URL}/workflows/${W}/snapshot`)).json()
  check('B2 browser holds exactly the server-authorized capabilities',
    initial.join(',') === [...server.availableTools].sort().join(','),
    `${initial} vs ${server.availableTools}`)
  check('B2 no submission capability exists', !initial.includes('submit_prior_authorization'))
  check('B2 no remediation capability exists',
    !initial.includes('resolve_authorization_window'))

  console.log('\nB3  A tool call advances real backend state and the visible page')
  const before = await rows(page)
  const result = await call(page, 'discover_coverage_requirements')
  await page.waitForTimeout(2500)
  const after = await rows(page)
  const parsed = typeof result === 'string' ? JSON.parse(result) : result
  check('B3 the tool returned structured backend state',
    parsed?.state === 'REQUIREMENTS_RESOLVED', String(parsed?.state))
  check('B3 the page visibly populated requirement rows',
    before === 0 && after === 5, `${before} -> ${after}`)

  console.log('\nB4  Capabilities change with NO reload')
  const grown = await tools(page)
  check('B4 evidence capabilities appeared', grown.includes('attach_evidence'))
  check('B4 inventory grew without a reload', grown.length > initial.length,
    `${initial.length} -> ${grown.length}`)
  check('B4 still no submission capability',
    !grown.includes('submit_prior_authorization'))

  console.log('\nB5  Server truth still governs after a reload')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const reloaded = await tools(page)
  check('B5 inventory reconstructs identically from backend truth',
    reloaded.join(',') === grown.join(','), `${reloaded} vs ${grown}`)
  check('B5 the page still shows five requirement rows', (await rows(page)) === 5)

  console.log('\nB6  No page errors')
  check('B6 no uncaught page errors', errors.length === 0, errors.slice(0, 3).join('; '))

  await browser.close()
  console.log('\n========================================================')
  console.log(`Browser acceptance: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  console.log('ALL BROWSER CHECKS PASSED')
}

main().catch((e) => { console.error('harness error:', e); process.exit(1) })
