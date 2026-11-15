// Mobile UI test for Phase 2 reconciliation: statuses, manual review, POS exceptions, daily text report. Mocked backend.
// Usage: node cash_recon_ui.js <dir-with-node_modules/@supabase/supabase-js>   (serve the repo on :8765)
const { chromium, devices } = require('playwright');
const path = require('path');
const S = process.argv[2];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 36000;
const tok = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', exp, role:'authenticated', aud:'authenticated'}) + '.sig';
const user = {id:'u1', aud:'authenticated', role:'authenticated', email:'x@example.com', app_metadata:{}, user_metadata:{}, created_at:'2026-01-01T00:00:00Z'};
const sess = {access_token:tok, refresh_token:'r', expires_in:36000, expires_at:exp, token_type:'bearer', user};
const now = Date.now(), id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const base = (n, o = {}) => ({id:id(n), preserve:false, store_key:'mcc', event_uid:'ev-' + n, detected_at:new Date(now - n * 60e3).toISOString(), kind:'cash', confidence:0.7, track_id:String(n), bbox:null, detections:[], frame_width:1920, frame_height:1080,
  snapshot_raw_path:null, snapshot_annotated_path:'u1/a.jpg', clip_path:null, match_status:'pending', matched_payment_id:null, match_delta_seconds:null, match_locked:false, match_note:null, label:null, label_note:null, matched_payment:null, ...o});
const pay = (n, o = {}) => ({id:id(100 + n), store_key:'mcc', source_ref:'INV' + n, paid_at:new Date(now - n * 60e3 + 20e3).toISOString(), cash_amount:25, total_amount:25, reconciliation_status:'pending', matched_event_id:null, ...o});
const events = [
  base(1, {match_status:'matched', matched_payment_id:id(101), match_delta_seconds:-20, matched_payment:{source_ref:'INV1', cash_amount:25, total_amount:25, paid_at:new Date(now - 60e3 + 20e3).toISOString()}}),
  base(2, {match_status:'unmatched'}), base(3, {match_status:'needs_review'}), base(4, {match_status:'pending'}),
  base(5, {match_status:'unmatched'}),
];
const payments = [pay(1, {reconciliation_status:'matched', matched_event_id:id(1)}), pay(2), pay(9, {reconciliation_status:'pos_without_detection'}), pay(8, {reconciliation_status:'needs_review'})];
const reports = [{id:'r1', store_key:'mcc', store_name:'MCC Eastern Creek', business_date:new Date(now - 86400e3).toLocaleDateString('en-CA', {timeZone:'Australia/Sydney'}), pos_cash_count:3, pos_cash_amount:75, camera_event_count:4, matched_count:2, unmatched_camera_count:1, pos_without_detection_count:1, needs_review_count:0, created_at:new Date(now).toISOString(),
  body_text:'Cash Audit — MCC Eastern Creek\nPOS cash transactions: 3\nMatched transactions: 2\n\nExceptions:\n- INV9 · $25.00 — POS without camera detection'}];
const reviews = [], errors = [];
(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({...devices['iPhone 13']});
  await ctx.addInitScript(([k, v]) => { try{ localStorage.setItem(k, v); }catch(_){} }, ['sb-scjfvvwylrgpbrmdsjxb-auth-token', JSON.stringify(sess)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: S + '/node_modules/@supabase/supabase-js/dist/umd/supabase.js', contentType:'application/javascript'}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
  await ctx.route('https://img.test/**', r => r.fulfill({path: path.resolve(__dirname, '../../icon-512.png'), contentType:'image/png'}));
  await ctx.route('https://scjfvvwylrgpbrmdsjxb.supabase.co/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method(), sp = u.searchParams;
    const H = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','access-control-expose-headers':'content-range'};
    const J = (o, st=200) => r.fulfill({status:st, contentType:'application/json', headers:H, body: JSON.stringify(o)});
    if(m === 'OPTIONS') return r.fulfill({status:204, headers:H});
    if(u.pathname.endsWith('/cash/review')){ reviews.push(JSON.parse(r.request().postData())); return J({ok:true}); }
    if(u.pathname.endsWith('/cash/images')){ const ids = JSON.parse(r.request().postData()).event_ids; const items = {}; ids.forEach(i => items[i] = {raw:null, annotated:'https://img.test/a.png', clip:null}); return J({ok:true, items}); }
    if(u.pathname.startsWith('/functions/v1/agent-gateway')) return J({ok:true});
    if(u.pathname.startsWith('/auth/v1/user')) return J(user);
    const cr = list => r.fulfill({status:200, contentType:'application/json', headers:{...H, 'content-range':`0-${Math.max(0,list.length-1)}/${list.length}`}, body: m === 'HEAD' ? '' : JSON.stringify(list)});
    if(u.pathname === '/rest/v1/cash_events') return cr(events);
    if(u.pathname === '/rest/v1/cash_pos_payments') return cr(payments);
    if(u.pathname === '/rest/v1/cash_daily_reports') return cr(reports);
    if(u.pathname === '/rest/v1/agents') return J([{id:'a1', slug:'stockwise', name:'StockWise', description:'', status:'active'}]);
    if(u.pathname.startsWith('/rest/v1/')) return J([]);
    return J({});
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { if(!/rt-settings-app|realtime/.test(e.message)) errors.push(e.message); });
  const ok = (c, m) => { if(!c){ console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  await pg.goto('http://localhost:8765/index.html');
  await pg.waitForSelector('[data-cash]', {timeout: 20000}); await pg.click('[data-cash]'); await pg.waitForSelector('.cashcard');
  const txt = await pg.locator('.cashcard').allInnerTexts();
  ok(txt.some(t => /Matched/.test(t) && /INV1/.test(t) && /\$25\.00/.test(t)), 'matched event shows invoice number and amount');
  ok(txt.some(t => /No POS Match/.test(t)), 'unmatched event shows No POS Match');
  ok(txt.some(t => /Needs Review/.test(t)), 'ambiguous event shows Needs Review');
  ok(txt.some(t => /Pending/.test(t)), 'recent event shows Pending');
  ok(await pg.locator('text=POS exceptions').count() === 1 && await pg.locator('text=POS Without Detection').count() === 1 && await pg.locator('text=Ambiguous camera match').count() === 1, 'POS exceptions block lists POS-without-detection and ambiguous payments');
  ok(await pg.locator('details.agcard').count() === 1 && /1 matched|2 matched/.test(await pg.locator('details.agcard summary').innerText()), 'daily text report summary card shown');
  await pg.locator('details.agcard summary').click(); ok(/Exceptions/.test(await pg.locator('details.agcard .agbody').innerText()) && await pg.locator('details.agcard img').count() === 0, 'report body is text only (no image)');
  // manual review on the unmatched event
  await pg.click(`[data-cashopen="${id(2)}"]`); await pg.waitForSelector('.cashdet');
  ok(await pg.locator('[data-cashmatch]').count() >= 1, 'unmatched event offers POS candidates within the window');
  await pg.click('[data-cashmatch]'); await pg.waitForTimeout(300);
  ok(reviews.length === 1 && reviews[0].action === 'match' && reviews[0].event_id === id(2) && /^0{8}-0000-4000-8000-/.test(reviews[0].payment_id), 'manual match posts event + payment to /cash/review');
  await pg.click(`[data-cashopen="${id(2)}"]`).catch(() => {}); await pg.waitForSelector('[data-cashreview="needs_review"]', {timeout: 3000}).catch(() => {});
  if(!await pg.locator('[data-cashreview="needs_review"]').count()) await pg.click(`[data-cashopen="${id(2)}"]`);
  await pg.click('[data-cashreview="needs_review"]'); await pg.waitForTimeout(300);
  ok(reviews.length === 2 && reviews[1].action === 'needs_review', 'Mark Needs Review posts to /cash/review');
  await pg.click(`[data-cashopen="${id(1)}"]`); await pg.waitForSelector('[data-cashreview="clear"]');
  await pg.click('[data-cashreview="clear"]'); await pg.waitForTimeout(300);
  ok(reviews.length === 3 && reviews[2].action === 'clear' && reviews[2].event_id === id(1), 'Clear POS match posts to /cash/review');
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); ok(!overflow, 'no horizontal scroll at phone width');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-recon.png'});
  await br.close();
})();
