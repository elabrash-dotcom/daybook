// Mobile UI test: per-schedule on/off switches in Agents > Setup > Times. Mocked backend.
// Usage: node agent_sched_ui.js <dir-with-node_modules/@supabase/supabase-js>   (serve the repo on :8765)
const { chromium, devices } = require('playwright');
const S = process.argv[2];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 36000;
const tok = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', exp, role:'authenticated', aud:'authenticated'}) + '.sig';
const user = {id:'u1', aud:'authenticated', role:'authenticated', email:'x@example.com', app_metadata:{}, user_metadata:{}, created_at:'2026-01-01T00:00:00Z'};
const sess = {access_token:tok, refresh_token:'r', expires_in:36000, expires_at:exp, token_type:'bearer', user};
const scheds = [
  {label:'cash_sync', name:'Cash Audit POS sync', cron:'*/15 9-18 * * *', status:'not set up', next:null},
  {label:'morning', name:'Morning brief', cron:'30 8 * * *', status:'active', next:null},
  {label:'early', name:'Early read', cron:'0 11 * * *', status:'paused', next:null},
];
const calls = [], errors = []; let failNext = false;
(async () => {
  const br = await chromium.launch(); const ctx = await br.newContext({...devices['iPhone 13']});
  await ctx.addInitScript(([k, v]) => { try{ localStorage.setItem(k, v); }catch(_){} }, ['sb-scjfvvwylrgpbrmdsjxb-auth-token', JSON.stringify(sess)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: S + '/node_modules/@supabase/supabase-js/dist/umd/supabase.js', contentType:'application/javascript'}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
  await ctx.route('https://scjfvvwylrgpbrmdsjxb.supabase.co/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method();
    const H = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'};
    const J = (o, st=200) => r.fulfill({status:st, contentType:'application/json', headers:H, body: JSON.stringify(o)});
    if(m === 'OPTIONS') return r.fulfill({status:204, headers:H});
    if(u.pathname.endsWith('/admin/schedule')){ const b = JSON.parse(r.request().postData()); calls.push(b); if(failNext){ failNext = false; return J({error:'boom'}, 500); } const x = scheds.find(s => s.label === b.label); x.status = b.on ? 'active' : 'paused'; return J({ok:true, label:b.label, status:x.status}); }
    if(u.pathname.endsWith('/status')) return J({key:true, webhook_key:true, webhook_url:'x', setup:true, setup_at:new Date().toISOString(), stockwise:true, stockwise_at:new Date().toISOString(), schedules_on:true, schedules:scheds, synced:0});
    if(u.pathname.endsWith('/feed')) return J({cards:[], has_more:false, unread:0});
    if(u.pathname.startsWith('/functions/v1/')) return J({ok:true});
    if(u.pathname.startsWith('/auth/v1/user')) return J(user);
    if(u.pathname === '/rest/v1/agents') return J([{id:'a1', slug:'stockwise', name:'StockWise', description:'', status:'active'}]);
    if(u.pathname.startsWith('/rest/v1/')) return J([]);
    return J({});
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { if(!/rt-settings-app|realtime/.test(e.message)) errors.push(e.message); });
  const ok = (c, m) => { if(!c){ console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  await pg.goto('http://localhost:8765/index.html');
  await pg.waitForSelector('[data-agents]', {timeout: 20000}); await pg.click('[data-agents]');
  await pg.click('[data-agtab="setup"]'); await pg.waitForSelector('[data-agtimes]');
  if(await pg.locator('[data-agtimes][aria-expanded="false"]').count()) await pg.click('[data-agtimes]');
  await pg.waitForSelector('.agrr');
  const rows = await pg.locator('.agrr').allInnerTexts();
  ok(rows[0].includes('Every 15 min') && rows[0].includes('9am–6:45pm'), 'cash sync shows "Every 15 min · 9am–6:45pm": ' + rows[0].replace(/\n/g, ' '));
  ok(/not set up/.test(rows[0]) && await pg.locator('.agrr').nth(0).locator('[data-agschedt]').count() === 0, 'unset schedule explains itself and has no switch');
  ok(await pg.locator('[data-agschedt="morning"][aria-checked="true"]').count() === 1 && await pg.locator('[data-agschedt="early"][aria-checked="false"]').count() === 1, 'switches show On/Off from the server state');
  await pg.click('[data-agschedt="morning"]'); await pg.waitForTimeout(300);
  ok(calls.length === 1 && calls[0].label === 'morning' && calls[0].on === false, 'switching Morning brief off posts {label, on:false}');
  ok(await pg.locator('[data-agschedt="morning"][aria-checked="false"]').count() === 1, 'switch moves immediately');
  await pg.click('[data-agschedt="early"]'); await pg.waitForTimeout(300);
  ok(calls[1].label === 'early' && calls[1].on === true && await pg.locator('[data-agschedt="early"][aria-checked="true"]').count() === 1, 'switching Early read on works');
  failNext = true; await pg.click('[data-agschedt="early"]'); await pg.waitForTimeout(400);
  ok(await pg.locator('[data-agschedt="early"][aria-checked="true"]').count() === 1, 'a failed change snaps the switch back');
  ok(!(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal scroll at phone width');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/sched.png'});
  await br.close();
})();
