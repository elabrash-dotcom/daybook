// Mobile UI test for "Sync POS Now" in Cash audit. Mocked backend with a job lifecycle.
// Usage: node cash_sync_ui.js <dir-with-node_modules/@supabase/supabase-js>   (serve the repo on :8765)
const { chromium, devices } = require('playwright');
const path = require('path');
const S = process.argv[2];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 36000;
const tok = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', exp, role:'authenticated', aud:'authenticated'}) + '.sig';
const user = {id:'u1', aud:'authenticated', role:'authenticated', email:'x@example.com', app_metadata:{}, user_metadata:{}, created_at:'2026-01-01T00:00:00Z'};
const sess = {access_token:tok, refresh_token:'r', expires_in:36000, expires_at:exp, token_type:'bearer', user};
const now = Date.now();
const ev = { id:'00000000-0000-4000-8000-000000000001', preserve:false, store_key:'mcc', event_uid:'e1', detected_at:new Date(now - 600e3).toISOString(), kind:'cash', confidence:0.7, track_id:'1', bbox:null, detections:[], frame_width:1920, frame_height:1080,
  snapshot_raw_path:null, snapshot_annotated_path:null, clip_path:null, match_status:'pending', matched_payment_id:null, match_delta_seconds:null, match_locked:false, match_note:null, label:null, label_note:null, matched_payment:null };
let phase = 'idle', polls = 0, ready = true, conflict = false, failMode = false;
const posts = [], errors = []; let eventReads = 0;
const base = () => ({ok:true, ready, last_ok:{at:new Date(now - 3600e3).toISOString(), new_count:0, accepted:2}, scheduled:[], server_time:new Date().toISOString()});
const status = () => {
  if(phase === 'running'){ polls++; if(polls >= 3){ phase = 'done'; } }
  if(phase === 'running') return {...base(), active:{job_id:'j1', status:'running', started_at:new Date(now).toISOString()}, last_job:null};
  if(phase === 'done') return {...base(), active:null, last_ok:{at:new Date().toISOString(), new_count:2, accepted:3}, last_job:failMode ? {job_id:'j1', status:'failed', started_at:new Date(now).toISOString(), error:'StockWise did not respond', imported:0, accepted:0} : {job_id:'j1', status:'done', started_at:new Date(now).toISOString(), finished_at:new Date().toISOString(), imported:2, accepted:3}};
  return {...base(), active:null, last_job:null};
};
(async () => {
  const br = await chromium.launch(); const ctx = await br.newContext({...devices['iPhone 13']});
  await ctx.addInitScript(([k, v]) => { try{ localStorage.setItem(k, v); }catch(_){} }, ['sb-scjfvvwylrgpbrmdsjxb-auth-token', JSON.stringify(sess)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: S + '/node_modules/@supabase/supabase-js/dist/umd/supabase.js', contentType:'application/javascript'}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
  await ctx.route('https://scjfvvwylrgpbrmdsjxb.supabase.co/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method();
    const H = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','access-control-expose-headers':'content-range'};
    const J = (o, st=200) => r.fulfill({status:st, contentType:'application/json', headers:H, body: JSON.stringify(o)});
    if(m === 'OPTIONS') return r.fulfill({status:204, headers:H});
    if(u.pathname.endsWith('/cash/sync/status')) return J(status());
    if(u.pathname.endsWith('/cash/sync') && m === 'POST'){ posts.push(Date.now()); if(conflict) return J({ok:false, reason:'already_running', error:'A sync is already running. Wait for it to finish.'}, 409); phase = 'running'; polls = 0; return J({ok:true, job_id:'j1'}, 202); }
    if(u.pathname.startsWith('/functions/v1/agent-gateway')) return J({ok:true});
    if(u.pathname.startsWith('/auth/v1/user')) return J(user);
    const cr = list => r.fulfill({status:200, contentType:'application/json', headers:{...H, 'content-range':`0-0/${list.length}`}, body: m === 'HEAD' ? '' : JSON.stringify(list)});
    if(u.pathname === '/rest/v1/cash_events'){ if(m === 'GET') eventReads++; return cr([ev]); }
    if(u.pathname === '/rest/v1/agents') return J([{id:'a1', slug:'stockwise', name:'StockWise', description:'', status:'active'}]);
    if(u.pathname.startsWith('/rest/v1/')) return cr([]);
    return J({});
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { if(!/rt-settings-app|realtime/.test(e.message)) errors.push(e.message); });
  const ok = (c, m) => { if(!c){ console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  await pg.goto('http://localhost:8765/index.html');
  await pg.waitForSelector('[data-cash]', {timeout: 20000}); await pg.click('[data-cash]'); await pg.waitForSelector('[data-cashsync]');
  const idle = await pg.locator('.cashsync').innerText();
  ok(/Sync POS Now/.test(idle) && /Last successful sync/.test(idle) && /0 new cash payments/.test(idle), 'idle: button, last successful sync time and imported count: ' + idle.replace(/\n/g, ' | ').slice(0, 120));
  ok(/1:00 PM and 6:45 PM/.test(idle), 'shows the two scheduled sync times');
  const readsBefore = eventReads;
  await pg.click('[data-cashsync]'); await pg.waitForSelector('[data-cashsync][disabled]');
  ok(posts.length === 1, 'pressing the button starts exactly one sync (POST /cash/sync)');
  ok(/Syncing…/.test(await pg.locator('[data-cashsync]').innerText()) && /Fetching from StockWise/.test(await pg.locator('.cashsync').innerText()), 'progress is shown while it runs');
  await pg.locator('[data-cashsync]').click({force:true, timeout:1500}).catch(() => {});
  ok(posts.length === 1, 'pressing again while running does not start a second run');
  await pg.waitForFunction(() => /Last manual sync/.test(document.querySelector('.cashsync').innerText), null, {timeout: 15000});
  const done = await pg.locator('.cashsync').innerText();
  ok(/2 new cash payments/.test(done) && !(await pg.locator('[data-cashsync]').isDisabled()), 'success: imported count shown and the button is available again: ' + done.replace(/\n/g, ' | ').slice(0, 140));
  await pg.waitForTimeout(500);
  ok(eventReads > readsBefore, 'the reconciliation screen is refreshed after the sync finishes (' + readsBefore + ' -> ' + eventReads + ' event reads)');
  // conflict (another sync already running)
  phase = 'idle'; conflict = true; await pg.click('[data-cashsync]'); await pg.waitForTimeout(500);
  ok(/already running/i.test(await pg.locator('.cashsync').innerText()) && posts.length === 2, 'a refused start (409) shows the reason');
  // failure
  conflict = false; failMode = true; phase = 'idle'; await pg.reload(); await pg.waitForSelector('[data-cash]'); await pg.click('[data-cash]'); await pg.waitForSelector('[data-cashsync]');
  await pg.click('[data-cashsync]'); await pg.waitForFunction(() => /failed/.test(document.querySelector('.cashsync').innerText), null, {timeout: 15000});
  ok(/StockWise did not respond/.test(await pg.locator('.cashsync').innerText()), 'failure is shown with its reason');
  // not set up
  failMode = false; phase = 'idle'; ready = false; await pg.reload(); await pg.waitForSelector('[data-cash]'); await pg.click('[data-cash]'); await pg.waitForSelector('[data-cashsync]');
  ok(await pg.locator('[data-cashsync]').isDisabled() && /Not set up yet/.test(await pg.locator('.cashsync').innerText()), 'not set up: button disabled with a hint');
  ok(!(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal scroll at phone width');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-sync.png'});
  await br.close();
})();
