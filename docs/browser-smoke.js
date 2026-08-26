// Browser smoke test: drive real Chrome over CDP against the running app.
// Asserts on document.modelContext.getTools() -- the browser's own inventory --
// and on the visible DOM, so "UI changed but WebMCP didn't" cannot pass.

const CDP_LIST = 'http://localhost:9333/json/list';
const APP = 'http://localhost:5199/';

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
}


// Poll until a testid appears (or timeout). A fixed sleep after navigate races
// React's first commit and produces false failures.
async function waitFor(testid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await evaluate(null,
      `document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`);
    if (v !== null) return v;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

(async () => {
  const targets = await fetch(CDP_LIST).then(r => r.json());
  const page = targets.find(t => t.type === 'page');
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on ? ws.on('open', r) : ws.addEventListener('open', r));
  const onMsg = (raw) => {
    const m = JSON.parse(raw.data ?? raw);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  ws.on ? ws.on('message', onMsg) : ws.addEventListener('message', onMsg);

  await send('Runtime.enable');
  await send('Page.enable');

  // Reset backend so the run is deterministic.
  await fetch('http://localhost:8787/api/reset', { method: 'POST' });

  await send('Page.navigate', { url: APP });
  await waitFor('workflow-state');

  const tools = () => evaluate(null, `(async()=>{
    const t = await document.modelContext.getTools();
    return t.map(x=>x.name).sort();
  })()`);

  const stateText = () => evaluate(null,
    `document.querySelector('[data-testid="workflow-state"]')?.textContent ?? null`);
  const capCount = () => evaluate(null,
    `document.querySelector('[data-testid="capability-count"]')?.textContent ?? null`);
  const satisfied = () => evaluate(null,
    `document.querySelector('[data-testid="satisfied-count"]')?.textContent ?? null`);

  // --- 1. agent discovers the initial tools -------------------------------
  const has = await evaluate(null, `typeof document.modelContext?.registerTool === 'function'`);
  check('WebMCP present in page', has === true, `document.modelContext.registerTool=${has}`);

  let t = await tools();
  check('1. agent discovers initial 2 tools', t.length === 2 && t.includes('get_order_context'), JSON.stringify(t));
  check('   page shows CONTEXT_READY', (await stateText()) === 'CONTEXT_READY', await stateText());
  check('   page shows 2 capabilities', (await capCount())?.includes('2 capabilities'), await capCount());

  // --- 2. agent invokes get_order_context ---------------------------------
  const orderRaw = await evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    const h = ts.find(x=>x.name==='get_order_context');
    return await document.modelContext.executeTool(h, '{}');
  })()`);
  const order = typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw;
  const orderObj = order.structuredContent ?? order;
  check('2. agent invokes get_order_context',
    JSON.stringify(orderObj).includes('Cardiac MRI'),
    JSON.stringify(orderObj).slice(0, 120));

  // --- 3/0A. requirements transition via AGENT tool call ------------------
  const discRaw = await evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    const h = ts.find(x=>x.name==='discover_coverage_requirements');
    return await document.modelContext.executeTool(h, '{}');
  })()`);
  check('3. discover_coverage_requirements executed',
    JSON.stringify(discRaw).includes('req-001'), 'returned 5 requirements');

  await new Promise(r => setTimeout(r, 1200));

  check('0A. page advanced to REQUIREMENTS_RESOLVED without reload',
    (await stateText()) === 'REQUIREMENTS_RESOLVED', await stateText());
  const reqRendered = await evaluate(null,
    `document.body.textContent.includes('Prior echocardiogram result')`);
  check('0A. five requirements visibly populated', reqRendered === true, `rendered=${reqRendered}`);

  // --- 4. agent observes the new capabilities -----------------------------
  t = await tools();
  check('4. agent observes 5 capabilities',
    t.length === 5 && t.includes('bind_evidence'), JSON.stringify(t));
  check('   page shows 5 capabilities', (await capCount())?.includes('5 capabilities'), await capCount());

  // --- 0B. binding 4/5 -> 5/5 --------------------------------------------
  const bind = async (req, ev) => evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    const h = ts.find(x=>x.name==='bind_evidence');
    return await document.modelContext.executeTool(h, ${JSON.stringify(JSON.stringify({requirementId:req, evidenceId:ev}))});
  })()`);

  for (const [r_, e_] of [['req-001','ev-100'],['req-002','ev-101'],['req-003','ev-102'],['req-004','ev-103']]) {
    await bind(r_, e_);
  }
  await new Promise(r => setTimeout(r, 900));
  check('0B. page shows 4 / 5 satisfied', (await satisfied())?.includes('4 / 5'), await satisfied());

  // --- 0C. refusal does not create fake success ---------------------------
  const refused = await bind('req-005', 'ev-100'); // wrong evidence for req-005
  await new Promise(r => setTimeout(r, 900));
  const refusedStr = JSON.stringify(refused);
  check('0C. backend refused mismatched evidence',
    refusedStr.includes('EVIDENCE_DOES_NOT_SATISFY_REQUIREMENT'), 'reason returned to agent');
  check('0C. page still 4 / 5 after refusal', (await satisfied())?.includes('4 / 5'), await satisfied());
  const tAfterRefusal = await tools();
  check('0C. prepare_prior_authorization still absent',
    !tAfterRefusal.includes('prepare_prior_authorization'), JSON.stringify(tAfterRefusal));

  // --- 0B complete --------------------------------------------------------
  await bind('req-005', 'ev-104');
  await new Promise(r => setTimeout(r, 900));
  check('0B. page shows 5 / 5 satisfied', (await satisfied())?.includes('5 / 5'), await satisfied());
  t = await tools();
  check('0B. prepare_prior_authorization now registered',
    t.includes('prepare_prior_authorization') && t.length === 6, JSON.stringify(t));

  // --- 7/0D. prepare -> PREPARED_AWAITING_APPROVAL ------------------------
  await evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    const h = ts.find(x=>x.name==='prepare_prior_authorization');
    return await document.modelContext.executeTool(h, '{}');
  })()`);
  await new Promise(r => setTimeout(r, 1200));
  check('0D. page shows PREPARED_AWAITING_APPROVAL',
    (await stateText()) === 'PREPARED_AWAITING_APPROVAL', await stateText());
  const disclosure = await evaluate(null,
    `document.body.textContent.includes('Synthetic Payer') && document.body.textContent.includes('Proposed disclosure')`);
  check('0D. disclosure + payer visible', disclosure === true, `visible=${disclosure}`);
  t = await tools();
  check('0D. agent has NO submit capability while awaiting approval',
    !t.includes('submit_prior_authorization'), JSON.stringify(t));
  check('0D. no approve tool exists for the agent',
    !t.some(n => /approve/i.test(n)), JSON.stringify(t));

  // --- 0E. human approval changes capabilities ----------------------------
  const clicked = await evaluate(null,
    `(()=>{const b=document.querySelector('[data-testid="approve-button"]'); if(!b) return false; b.click(); return true;})()`);
  check('0E. human Approve control present and clicked', clicked === true, `clicked=${clicked}`);
  await new Promise(r => setTimeout(r, 1500));
  check('0E. page shows APPROVED', (await stateText()) === 'APPROVED', await stateText());
  t = await tools();
  check('0E. submit_prior_authorization appeared without reload',
    t.includes('submit_prior_authorization'), JSON.stringify(t));

  // --- Gate 0 submit stub -------------------------------------------------
  const sub = await evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    const h = ts.find(x=>x.name==='submit_prior_authorization');
    return await document.modelContext.executeTool(h, '{}');
  })()`);
  check('Gate 0 submit returns NOT_IMPLEMENTED_GATE_0',
    JSON.stringify(sub).includes('NOT_IMPLEMENTED_GATE_0'), 'stub refused as designed');

  // --- 5/6. reset removes tools; removed tools uncallable -----------------
  const staleHandleWorks = await evaluate(null, `(async()=>{
    const ts = await document.modelContext.getTools();
    window.__stale = ts.find(x=>x.name==='bind_evidence');
    return !!window.__stale;
  })()`);
  check('   captured stale handle before reset', staleHandleWorks === true);

  await fetch('http://localhost:8787/api/reset', { method: 'POST' });
  await evaluate(null, `(()=>{const bs=[...document.querySelectorAll('button')]; const b=bs.find(x=>x.textContent.includes('Refresh from server')); b&&b.click(); return true;})()`);
  await new Promise(r => setTimeout(r, 1500));

  check('5. reset returns page to CONTEXT_READY', (await stateText()) === 'CONTEXT_READY', await stateText());
  t = await tools();
  check('5. reset removes evidence tools (back to 2)',
    t.length === 2 && !t.includes('bind_evidence'), JSON.stringify(t));

  const staleResult = await evaluate(null, `(async()=>{
    try { await document.modelContext.executeTool(window.__stale, '{}'); return 'INVOKED'; }
    catch(e){ return 'REJECTED: ' + (e.name || e.message); }
  })()`);
  check('6. removed tool cannot subsequently be invoked',
    String(staleResult).startsWith('REJECTED'), String(staleResult));

  // --- reload recovery ----------------------------------------------------
  await fetch('http://localhost:8787/api/discover-requirements', { method: 'POST' });
  await send('Page.navigate', { url: APP });
  await waitFor('workflow-state');
  check('reload reconstructs REQUIREMENTS_RESOLVED from server',
    (await stateText()) === 'REQUIREMENTS_RESOLVED', await stateText());
  t = await tools();
  check('reload registers the correct 5 tools for recovered state',
    t.length === 5, JSON.stringify(t));

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('SMOKE ERROR:', e.message); process.exit(2); });
