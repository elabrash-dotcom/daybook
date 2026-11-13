const { chromium, devices } = require('playwright');
// Usage: node cash_ui.js <dir-containing node_modules/@supabase/supabase-js> [ok|missing]   (needs playwright; serve the repo on :8765)
const S = process.argv[2]; const MODE = process.argv[3] || 'ok';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 36000;
const tok = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', exp, role:'authenticated', aud:'authenticated'}) + '.sig';
const user = {id:'u1', aud:'authenticated', role:'authenticated', email:'x@example.com', app_metadata:{}, user_metadata:{}, created_at:'2026-01-01T00:00:00Z'};
const sess = {access_token:tok, refresh_token:'r', expires_in:36000, expires_at:exp, token_type:'bearer', user};
const now = Date.now();
const mk = (i, o = {}) => ({id:'00000000-0000-4000-8000-' + String(i).padStart(12,'0'), store_key: i % 3 === 0 ? 'mobiletek' : 'mcc', event_uid:'jet-' + i,
  detected_at: new Date(now - i * 25 * 60e3).toISOString(), kind:'cash_handover', confidence: 0.5 + (i % 5) / 10, track_id: String(i + 3),
  bbox:{x:0.25,y:0.3,w:0.2,h:0.25,norm:true}, detections:[{x:0.25,y:0.3,w:0.2,h:0.25,norm:true,label:'cash'}], frame_width:1920, frame_height:1080,
  snapshot_raw_path:'u1/mcc/d/e/raw.jpg', snapshot_annotated_path:'u1/mcc/d/e/annotated.jpg', clip_path:null, match_status:'pending', matched_payment_id:null, match_delta_seconds:null, label:null, label_note:null, ...o});
let events = Array.from({length: 30}, (_, i) => mk(i));
events[1] = mk(1, {snapshot_raw_path:null, bbox:null, detections:[], confidence:null, track_id:null, frame_width:null, frame_height:null});   // legacy: annotated only, no boxes
events[2] = mk(2, {snapshot_raw_path:null, snapshot_annotated_path:null});                                                                    // no snapshot yet
events[4] = mk(4, {bbox:{x:200,y:150,w:300,h:200,norm:false}, detections:[]});                                                                 // pixel boxes
events.push({...mk(99), store_key:'fairfield', event_uid:'ff'});                                                                               // must never show
const patches = [], imageCalls = [], errors = [], baseline = [];
(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({...devices['iPhone 13']});
  await ctx.addInitScript(([k, v]) => { try{ localStorage.setItem(k, v); }catch(_){} }, ['sb-scjfvvwylrgpbrmdsjxb-auth-token', JSON.stringify(sess)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: S + '/node_modules/@supabase/supabase-js/dist/umd/supabase.js', contentType:'application/javascript'}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
  await ctx.route('https://img.test/**', r => r.fulfill({path: '/home/user/daybook/icon-512.png', contentType:'image/png'}));
  await ctx.route('https://scjfvvwylrgpbrmdsjxb.supabase.co/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method(), sp = u.searchParams;
    const H = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','access-control-expose-headers':'content-range'};
    const J = (o, st=200, extra={}) => r.fulfill({status:st, contentType:'application/json', headers:{...H, ...extra}, body: JSON.stringify(o)});
    if(m === 'OPTIONS') return r.fulfill({status:204, headers:H});
    if(u.pathname === '/functions/v1/agent-gateway/cash/images'){
      const ids = JSON.parse(r.request().postData()).event_ids; imageCalls.push(ids);
      const items = {}; ids.forEach(id => { const e = events.find(x => x.id === id); if(e) items[id] = {raw: e.snapshot_raw_path ? 'https://img.test/raw.png?i=' + id : null, annotated: e.snapshot_annotated_path ? 'https://img.test/ann.png?i=' + id : null, clip: null}; });
      return J({ok:true, items});
    }
    if(u.pathname.startsWith('/functions/v1/agent-gateway')) return J({ok:true});
    if(u.pathname.startsWith('/auth/v1/user')) return J(user);
    if(u.pathname === '/rest/v1/cash_events'){
      if(MODE === 'missing') return J({code:'42P01', message:'relation "public.cash_events" does not exist'}, 404);
      if(m === 'PATCH'){ patches.push({q: u.search, body: JSON.parse(r.request().postData())}); const id = (sp.get('id') || '').replace('eq.', ''); const e = events.find(x => x.id === id); if(e) Object.assign(e, JSON.parse(r.request().postData())); return r.fulfill({status:204, headers:H}); }
      let list = events.filter(e => !/fairfield/i.test(e.store_key));
      sp.getAll('store_key').forEach(c => { if(c.startsWith('eq.')) list = list.filter(e => e.store_key === c.slice(3)); });
      sp.getAll('detected_at').forEach(c => { if(c.startsWith('gte.')) list = list.filter(e => e.detected_at >= c.slice(4)); if(c.startsWith('lt.')) list = list.filter(e => e.detected_at < c.slice(3)); });
      const lb = sp.get('label'); if(lb === 'is.null') list = list.filter(e => !e.label); else if(lb && lb.startsWith('eq.')) list = list.filter(e => e.label === lb.slice(3));
      list.sort((a, b) => b.detected_at.localeCompare(a.detected_at));
      const head = m === 'HEAD';
      const lim = +(sp.get('limit') || 1000);
      return r.fulfill({status:200, contentType:'application/json', headers:{...H, 'content-range': `0-${Math.max(0, list.length - 1)}/${list.length}`}, body: head ? '' : JSON.stringify(list.slice(0, lim))});
    }
    if(u.pathname === '/rest/v1/agents') return J([{id:'a1', slug:'stockwise', name:'StockWise', description:'', status:'active'}]);
    if(u.pathname.startsWith('/rest/v1/settings')) return J(m==='GET' && sp.get('id') ? null : []);
    if(u.pathname.startsWith('/rest/v1/')) return J([]);
    return J({});
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { if(!/rt-settings-app|realtime/.test(e.message)) errors.push('pageerror ' + e.message); else baseline.push(e.message); });
  pg.on('console', c => { if(c.type() === 'error' && !/Failed to load resource|cash_events|404|WebSocket|tunnel|realtime:rt-/.test(c.text())) errors.push('console ' + c.text()); });
  const ok = (c, m) => { if(!c){ console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  await pg.goto('http://localhost:8765/index.html');
  if(MODE === 'missing'){
    await pg.waitForSelector('[data-agents]', {timeout: 20000}); await pg.waitForTimeout(1500);
    ok(await pg.locator('[data-cash]').count() === 0, 'tile hidden when the cash_events table does not exist (current production)');
    ok(errors.length === 0, 'no JS errors without the table: ' + errors.join(' | '));
    await br.close(); return;
  }
  await pg.waitForSelector('[data-cash]', {timeout: 20000});
  ok(true, 'Cash tile shown when events exist');
  const tileTxt = await pg.locator('[data-cash]').innerText(); ok(/to review today/.test(tileTxt), 'tile subtitle: ' + tileTxt.replace(/\n/g, ' '));
  await pg.click('[data-cash]'); await pg.waitForSelector('.cashcard');
  const n = await pg.locator('.cashcard').count(); ok(n >= 1 && n <= 20, 'list loaded (' + n + ' cards, page size 20)');
  ok(await pg.locator('text=Fairfield').count() === 0 && !(await pg.content()).includes('jet-99'), 'Fairfield event never shown');
  ok(imageCalls.length === 0, 'no image links requested until an event is opened');
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-list.png'});
  // filters
  await pg.click('[data-cashf="store.mcc"]'); await pg.waitForTimeout(300);
  ok(await pg.locator('.cashcard .agshop.mt').count() === 0 && await pg.locator('.cashcard').count() > 0, 'store filter: MCC only');
  await pg.click('[data-cashf="store.all"]'); await pg.waitForTimeout(300);
  await pg.click('[data-cashf="range.all"]'); await pg.waitForTimeout(300);
  ok(await pg.locator('.cashcard').count() === 20 && await pg.locator('[data-cashmore]').count() === 1, 'All range: paged 20 with "Show more"');
  await pg.click('[data-cashmore]'); await pg.waitForTimeout(300);
  ok(await pg.locator('.cashcard').count() === 30, 'Show more loads the rest (30, Fairfield excluded)');
  await pg.click('[data-cashf="range.today"]'); await pg.waitForTimeout(300);
  const dayStr = new Date(now - 86400e3).toLocaleDateString('en-CA', {timeZone:'Australia/Sydney'});
  await pg.fill('#cashDay', dayStr); await pg.dispatchEvent('#cashDay', 'change'); await pg.waitForTimeout(400);
  ok(await pg.locator('.agdatel.on').count() === 1, 'date picker sets a day filter');
  await pg.click('[data-cashf="range.today"]'); await pg.waitForTimeout(300);
  // event with snapshots
  const first = pg.locator('[data-cashopen]').first(); await first.click(); await pg.waitForSelector('.cashdet');
  await pg.waitForSelector('img.cashimg'); ok(imageCalls.length === 1 && imageCalls[0].length === 1, 'signed links requested for just the opened event');
  ok(await pg.locator('.cashseg [data-cashside="raw"][aria-pressed="true"]').count() === 1, 'raw is the default view when available');
  ok(await pg.locator('svg.cashov rect').count() >= 1, 'raw view draws bounding boxes');
  ok((await pg.locator('img.cashimg').getAttribute('src')).includes('raw.png'), 'raw image shown');
  await pg.click('[data-cashside="annotated"]'); await pg.waitForSelector('img.cashimg[src*="ann.png"]');
  ok(await pg.locator('svg.cashov').count() === 0, 'annotated view has no overlay (boxes already drawn)');
  await pg.click('[data-cashside="raw"]'); await pg.click('[data-cashboxes]'); ok(await pg.locator('svg.cashov').count() === 0, 'boxes toggle hides overlay');
  const det = await pg.locator('.cashkv').innerText(); ok(/Confidence/.test(det) && /Track ID/.test(det) && /POS match\s*\n?.*not checked yet/s.test(det), 'details: confidence, track id, POS match placeholder');
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-detail.png', fullPage: false});
  // labels
  for (const [v, t] of [['confirmed_cash','Confirmed cash'], ['false_detection','False detection'], ['unsure','Unsure'], ['other','Other']]) {
    await pg.click(`[data-cashlabel="${v}"]`); await pg.waitForTimeout(250);
    ok(patches.length && patches[patches.length - 1].body.label === v, 'label saved: ' + t);
  }
  await pg.click('[data-cashlabel="other"]'); await pg.waitForTimeout(250);
  ok(patches[patches.length - 1].body.label === null, 'tapping the active label clears it');
  await pg.click('[data-cashlabel="unsure"]'); await pg.fill('#cashNote', 'customer paid at the till'); await pg.click('[data-cashnote]'); await pg.waitForTimeout(250);
  ok(patches[patches.length - 1].body.label_note === 'customer paid at the till', 'note saved');
  // legacy event (annotated only, no boxes/confidence/track)
  await pg.click('[data-cashf="range.all"]'); await pg.waitForTimeout(300);
  await pg.click(`[data-cashopen="${events[1].id}"]`); await pg.waitForSelector('.cashdet');
  await pg.waitForSelector('img.cashimg');
  ok((await pg.locator('img.cashimg').getAttribute('src')).includes('ann.png'), 'legacy event falls back to the annotated snapshot');
  ok(await pg.locator('text=Older event: only the annotated snapshot was saved').count() === 1, 'legacy event explains itself');
  ok(await pg.locator('.cashseg [data-cashside="raw"]').isDisabled(), 'Raw button disabled when no raw snapshot');
  ok(!/Confidence|Track ID|Frame/.test(await pg.locator('.cashkv').innerText()), 'missing confidence/track/frame fields are simply omitted');
  await pg.click(`[data-cashopen="${events[2].id}"]`); await pg.waitForSelector('.cashnone');
  ok(await pg.locator('text=No snapshot uploaded for this event yet').count() === 1, 'event without any snapshot shows a clear message');
  await pg.click(`[data-cashopen="${events[4].id}"]`); await pg.waitForSelector('img.cashimg');
  if(await pg.locator('[data-cashboxes][aria-pressed="false"]').count()) await pg.click('[data-cashboxes]');
  await pg.waitForSelector('svg.cashov');
  const r = await pg.locator('svg.cashov rect').first().getAttribute('x'); ok(Math.abs(+r - 104.2) < 0.5, 'pixel boxes are scaled by frame size (x=' + r + ')');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); ok(!overflow, 'no horizontal scroll at phone width');
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-legacy.png'});
  await br.close();
})();
