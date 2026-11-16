// Mobile UI test for Cash audit -> Training data (false detections). Mocked backend.
// Usage: node cash_training_ui.js <dir-with-node_modules/@supabase/supabase-js>   (serve the repo on :8765)
const { chromium, devices } = require('playwright');
const S = process.argv[2];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 36000;
const tok = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', exp, role:'authenticated', aud:'authenticated'}) + '.sig';
const user = {id:'u1', aud:'authenticated', role:'authenticated', email:'x@example.com', app_metadata:{}, user_metadata:{}, created_at:'2026-01-01T00:00:00Z'};
const sess = {access_token:tok, refresh_token:'r', expires_in:36000, expires_at:exp, token_type:'bearer', user};
const now = Date.now();
const EID = '00000000-0000-4000-8000-000000000001';
const ev = { id:EID, preserve:false, store_key:'mcc', event_uid:'e1', detected_at:new Date(now - 600e3).toISOString(), kind:'cash', confidence:0.7, track_id:'1', bbox:null, detections:[], frame_width:1920, frame_height:1080,
  snapshot_raw_path:'u1/mcc/d/e1/raw.jpg', snapshot_annotated_path:'u1/mcc/d/e1/annotated.jpg', clip_path:null, match_status:'pending', matched_payment_id:null, match_delta_seconds:null, match_locked:false, match_note:null, label:null, label_note:null, matched_payment:null };
const train = [];      // rows of cash_training_examples (the database trigger is simulated by the PATCH handler)
let tableMissing = false, exportMode = 'ok';
const reviews = [], patches = [], zipReqs = [], errors = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ZIP = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');   // an empty but valid ZIP

(async () => {
  const br = await chromium.launch(); const ctx = await br.newContext({...devices['iPhone 13'], acceptDownloads:true});
  await ctx.addInitScript(([k, v]) => { try{ localStorage.setItem(k, v); }catch(_){} }, ['sb-scjfvvwylrgpbrmdsjxb-auth-token', JSON.stringify(sess)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: S + '/node_modules/@supabase/supabase-js/dist/umd/supabase.js', contentType:'application/javascript'}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
  await ctx.route('http://localhost:8765/_img/**', r => r.fulfill({body: PNG, contentType:'image/png'}));
  await ctx.route('https://scjfvvwylrgpbrmdsjxb.supabase.co/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method();
    const H = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','access-control-expose-headers':'content-range, content-disposition, x-training-included, x-training-total, x-training-truncated, x-training-missing-images'};
    const J = (o, st=200) => r.fulfill({status:st, contentType:'application/json', headers:H, body: JSON.stringify(o)});
    if(m === 'OPTIONS') return r.fulfill({status:204, headers:H});
    const p = u.pathname;
    if(p.endsWith('/cash/sync/status')) return J({ok:true, ready:true, active:null, last_job:null, last_ok:null, scheduled:[], server_time:new Date().toISOString()});
    if(p.endsWith('/cash/images')) return J({ok:true, items:{[EID]:{raw:'http://localhost:8765/_img/raw.png', annotated:'http://localhost:8765/_img/ann.png', clip:null}}});
    if(p.endsWith('/cash/training/review')){ const b = JSON.parse(r.request().postData()); reviews.push(b); const t = train.find(x => x.id === b.id);
      if(t){ t.status = b.action === 'reviewed' ? 'reviewed' : b.action === 'excluded' ? 'excluded' : 'collected'; } return J({ok:true, id:b.id}); }
    if(p.endsWith('/cash/training/export')){ zipReqs.push(u.search);
      if(exportMode === 'fail') return J({ok:false, error:'could not build the export'}, 500);
      return r.fulfill({status:200, headers:{...H, 'content-type':'application/zip', 'content-disposition':'attachment; filename="daybook-false-detections-2026-11-16.zip"', 'x-training-included':String(train.length), 'x-training-total':String(train.length), 'x-training-truncated':'false', 'x-training-missing-images':'1'}, body: ZIP}); }
    if(p.startsWith('/functions/v1/agent-gateway')) return J({ok:true});
    if(p.startsWith('/auth/v1/user')) return J(user);
    const cr = list => r.fulfill({status:200, contentType:'application/json', headers:{...H, 'content-range':`0-0/${list.length}`}, body: m === 'HEAD' ? '' : JSON.stringify(list)});
    if(p === '/rest/v1/cash_training_examples'){
      if(tableMissing) return J({code:'42P01', message:'relation does not exist'}, 404);
      const sf = (u.searchParams.get('status') || '').match(/in\.\((.*)\)/); let rows = train.filter(t => !sf || sf[1].split(',').includes(t.status));
      const st = u.searchParams.get('store_key'); if(st && st.startsWith('eq.')) rows = rows.filter(t => t.store_key === st.slice(3));
      return cr(rows);
    }
    if(p === '/rest/v1/cash_events'){
      if(m === 'PATCH'){ const b = JSON.parse(r.request().postData() || '{}'); patches.push(b); ev.label = b.label; ev.label_note = b.label_note;
        if(b.label === 'false_detection' && !train.some(t => t.event_id === EID)) train.push({id:'t1', event_id:EID, event_uid:'e1', store_key:'mcc', camera_label:'MCC Jetson D3', device_id:'d1', class_name:'cash', detected_at:ev.detected_at, confidence:0.7, model_version:'yolo-cash-v3', reason:b.label_note, image_state:'ok', status:'collected', review_note:null});
        return r.fulfill({status:204, headers:H}); }
      return cr([ev]);
    }
    if(p === '/rest/v1/agents') return J([{id:'a1', slug:'stockwise', name:'StockWise', description:'', status:'active'}]);
    if(p.startsWith('/rest/v1/')) return cr([]);
    return J({});
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { if(!/rt-settings-app|realtime/.test(e.message)) errors.push(e.message); });
  const ok = (c, m) => { if(!c){ console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  const open = async (sel = '[data-cashview]') => { await pg.goto('http://localhost:8765/index.html'); await pg.waitForSelector('[data-cash]', {timeout: 20000}); await pg.click('[data-cash]'); await pg.waitForSelector(sel); };
  await open();
  ok(/Training data \(0\)/.test(await pg.locator('.cashtabs').innerText()), 'tab shows 0 collected before anything is marked false');

  // 1. mark a detection False in the Events view -> the database collects it -> the count updates
  await pg.click('[data-cashopen]'); await pg.waitForSelector('[data-cashlabel="false_detection"]'); await pg.click('[data-cashlabel="false_detection"]');
  await pg.waitForFunction(() => /Training data \(1\)/.test(document.querySelector('.cashtabs').innerText), null, {timeout: 8000});
  ok(patches.length === 1 && patches[0].label === 'false_detection', 'marking False saves the label exactly as before (one update, same fields)');
  ok(true, 'the Training data count refreshed to 1 after the label was saved');

  // 2. the dataset screen: grouped by camera / date / class
  await pg.click('[data-cashview="training"]'); await pg.waitForSelector('[data-trainopen]');
  const list = await pg.locator('.agpage').innerText();
  ok(/MCC · MCC Jetson D3/i.test(list) && /cash\s*\(1\)/i.test(list), 'grouped by camera, date and class with a count: ' + list.replace(/\n/g, ' | ').slice(0, 160));
  ok(/To review/.test(list), 'new example is marked To review');

  // 3. review: open -> frames shown
  await pg.click('[data-trainopen]'); await pg.waitForSelector('.trimgs img', {timeout: 8000});
  const det = await pg.locator('.cashdet').innerText();
  ok(await pg.locator('.trimgs img').count() === 2 && /Original/.test(det) && /Annotated/.test(det), 'original and annotated frames are shown side by side');
  ok(/yolo-cash-v3/.test(det) && /70%/.test(det), 'model version and confidence are shown');

  // 4. mark reviewed
  await pg.click('[data-trainact="reviewed"]'); await pg.waitForFunction(() => /Reviewed/.test(document.querySelector('.agpage').innerText), null, {timeout: 8000});
  ok(reviews.length === 1 && reviews[0].action === 'reviewed' && reviews[0].id === 't1', 'Mark reviewed calls the gateway once');

  // 5. exclude -> leaves Active, shows under Excluded with Include again
  await pg.waitForSelector('[data-trainact="excluded"]'); await pg.click('[data-trainact="excluded"]');   // the card stays open after Mark reviewed
  await pg.waitForFunction(() => /No training examples/.test(document.querySelector('.agpage').innerText), null, {timeout: 8000});
  ok(/Training data \(0\)/.test(await pg.locator('.cashtabs').innerText()), 'excluded example leaves the active count');
  await pg.click('[data-trainf="status.excluded"]'); await pg.waitForSelector('[data-trainopen]'); await pg.click('[data-trainopen]');
  ok(await pg.locator('[data-trainact="include"]').count() === 1, 'excluded examples can be included again');
  await pg.click('[data-trainact="include"]'); await pg.waitForFunction(() => /No training examples|Nothing matches/.test(document.querySelector('.agpage').innerText), null, {timeout: 8000});
  await pg.click('[data-trainf="status.active"]'); await pg.waitForSelector('[data-trainopen]');

  // 6. export ZIP downloads a file
  const [dl] = await Promise.all([pg.waitForEvent('download', {timeout: 8000}), pg.click('[data-trainexport]')]);
  ok(dl.suggestedFilename() === 'daybook-false-detections-2026-11-16.zip', 'Export ZIP downloads the ZIP: ' + dl.suggestedFilename());
  await pg.waitForFunction(() => /Exported 1 of 1/.test(document.querySelector('.cashsync').innerText), null, {timeout: 8000});
  const note = await pg.locator('.cashsync').innerText();
  ok(/1 frame missing/.test(note), 'missing frames are reported after the export: ' + note.replace(/\n/g, ' | ').slice(0, 140));
  ok(zipReqs.length === 1 && /status=collected%2Creviewed/.test(zipReqs[0]), 'export asks for the active examples only');

  // 7. export failure is explained
  exportMode = 'fail'; await pg.click('[data-trainexport]'); await pg.waitForFunction(() => /Export failed/.test(document.querySelector('.cashsync').innerText), null, {timeout: 8000});
  ok(/could not build the export/.test(await pg.locator('.cashsync').innerText()), 'a failed export shows its reason and nothing is downloaded');
  exportMode = 'ok';

  // 8. missing frame example shows a warning
  train[0].image_state = 'missing'; train[0].status = 'collected'; await pg.click('[data-trainrefresh], [data-trainf="status.active"]'); await pg.waitForSelector('[data-trainopen]');
  ok(/⚠ frame/i.test(await pg.locator('.agpage').innerText()), 'an example with a missing frame is flagged in the list');
  await pg.click('[data-trainopen]'); await pg.waitForSelector('.trwarn');
  ok(/No frame was uploaded/.test(await pg.locator('.trwarn').innerText()), 'and explained in the detail');
  ok(!(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal scroll at phone width');
  await pg.screenshot({path: (process.env.SHOTS || '/tmp') + '/cash-training.png'});

  // 9. the table is not there yet (migration not applied): the Events screen works and the tab is hidden
  tableMissing = true; await open('[data-cashopen]'); await pg.waitForTimeout(800);
  ok(await pg.locator('[data-cashview]').count() === 0 && await pg.locator('[data-cashopen]').count() === 1, 'without the migration the tab is hidden and Events still work');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  await br.close();
})();
