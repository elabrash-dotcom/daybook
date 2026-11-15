import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { estimateClockOffset, matchEvents } from "./cash_match.ts";

export type Reply = (body: unknown, status?: number) => Response;
export type CashAgent = { id: string; owner_id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_KEY = /^[a-z0-9_-]{1,40}$/;
const MCC_POS_STORE_ID = "744a2cca-638a-41ee-ae7c-9930877b7c7c";
const MAX_SYNC_ROWS = 100;

const parts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(d).map((x) => [x.type, x.value]));
const dateKey = (d = new Date()) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sydOffset = (t: number) => { const p = parts(new Date(t)); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000; };
const sydMidnight = (s: string) => { const [y,m,d] = s.split("-").map(Number), guess = Date.UTC(y,m-1,d); const first = guess - sydOffset(guess); return new Date(guess - sydOffset(first)).toISOString(); };
const money = (v: unknown) => "$" + (Number(v) || 0).toLocaleString("en-AU", {minimumFractionDigits:2,maximumFractionDigits:2});
const time = (iso: string) => new Intl.DateTimeFormat("en-AU", {timeZone:"Australia/Sydney",hour:"numeric",minute:"2-digit"}).format(new Date(iso));
const displayDate = (s: string) => new Intl.DateTimeFormat("en-AU", {timeZone:"Australia/Sydney",day:"numeric",month:"short",year:"numeric"}).format(new Date(s + "T12:00:00Z"));

function cleanPayment(v: unknown) {
  const x = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const storeId=String(x.store_id||""), storeKey=String(x.store_key||"").toLowerCase(), sourceUuid=String(x.source_uuid||""), ref=String(x.invoice_number||x.source_ref||"");
  const paidAt=String(x.paid_at||""), businessDate=String(x.business_date||""), method=String(x.payment_method||"").toLowerCase(), status=String(x.status||"").toLowerCase();
  const cash=Number(x.cash_amount), total=x.total_amount == null ? null : Number(x.total_amount);
  if(!UUID.test(storeId)||!STORE_KEY.test(storeKey)||!sourceUuid||sourceUuid.length>160||!ref||ref.length>80||!Number.isFinite(Date.parse(paidAt))||!DATE.test(businessDate)) return null;
  if(method!=="cash"||status!=="completed"||!(cash>0)||cash>1e7||(total!==null&&(!Number.isFinite(total)||total<0||total>1e7))) return null;
  if(storeKey!=="mcc"||storeId!==MCC_POS_STORE_ID) return null; // Fairfield and stores without detector coverage are refused.
  return {store_id:storeId,store_key:storeKey,source:"invoice",source_uuid:sourceUuid,source_ref:ref,payment_ref:String(x.payment_ref||"").slice(0,100),paid_at:new Date(paidAt).toISOString(),business_date:businessDate,cash_amount:cash,bank_amount:0,total_amount:total,payment_method:"cash",staff:String(x.staff||"").slice(0,120)||null,raw:{stockwise_status:"completed",stockwise_payment_method:"cash"},fetched_at:new Date().toISOString()};
}

export async function reconcileStore(sb: SupabaseClient, ownerId: string, storeKey: string, now = new Date()) {
  const {data:cfg,error:ce}=await sb.from("cash_reconciliation_settings").select("window_seconds,ambiguity_seconds,pending_minutes,clock_offset_seconds").eq("owner_id",ownerId).eq("store_key",storeKey).eq("coverage_active",true).maybeSingle();
  if(ce) throw ce; if(!cfg) return {store_key:storeKey,skipped:"coverage inactive"};
  const to=new Date(now.getTime()+3600e3).toISOString(), from=new Date(now.getTime()-72*3600e3).toISOString();
  const [{data:events,error:ee},{data:payments,error:pe}]=await Promise.all([
    sb.from("cash_events").select("id,store_key,detected_at,received_at,match_status,match_delta_seconds,match_locked,label").eq("owner_id",ownerId).eq("store_key",storeKey).gte("detected_at",from).lt("detected_at",to),
    sb.from("cash_pos_payments").select("id,store_key,paid_at,cash_amount").eq("owner_id",ownerId).eq("store_key",storeKey).gte("paid_at",from).lt("paid_at",to),
  ]);
  if(ee) throw ee; if(pe) throw pe;
  const unlocked=(events||[]).filter((e)=>!e.match_locked&&e.label!=="false_detection");
  const prior=(events||[]).filter((e)=>e.match_status==="matched"&&e.match_delta_seconds!=null).map((e)=>Number(e.match_delta_seconds));
  const offset=estimateClockOffset(prior,Number(cfg.clock_offset_seconds)||0);
  const result=matchEvents(unlocked,payments||[],{windowSeconds:cfg.window_seconds,ambiguitySeconds:cfg.ambiguity_seconds,clockOffsetSeconds:offset});
  const {data,error}=await sb.rpc("cash_apply_reconciliation",{p_owner:ownerId,p_store:storeKey,p_from:from,p_to:to,p_matches:result.matched,p_review_events:result.needs_review_events,p_review_payments:result.ambiguous_payments,p_clock_offset:offset,p_now:now.toISOString()});
  if(error) throw error;
  return {store_key:storeKey,events:unlocked.length,payments:(payments||[]).length,matched:result.matched.length,needs_review:result.needs_review_events.length,offset_seconds:offset,applied:data};
}

export async function reconcileAll(sb: SupabaseClient, now = new Date()) {
  const {data,error}=await sb.from("cash_reconciliation_settings").select("owner_id,store_key").eq("coverage_active",true);
  if(error) throw error; const out=[];
  for(const x of data||[]) out.push(await reconcileStore(sb,x.owner_id,x.store_key,now));
  return out;
}

export async function handleCashSync(req: Request, agent: CashAgent, sb: SupabaseClient, reply: Reply) {
  const raw=await req.text(); if(raw.length>300000) return reply({error:"body too large"},413);
  let body:Record<string,unknown>; try{body=JSON.parse(raw);}catch(_){return reply({error:"body must be JSON"},400);}
  const rows=Array.isArray(body.payments)?body.payments:[]; if(rows.length>MAX_SYNC_ROWS) return reply({error:`max ${MAX_SYNC_ROWS} payments`},413);
  const clean=rows.map(cleanPayment); if(clean.some((x)=>!x)) return reply({error:"every payment must be a completed MCC Eastern Creek cash invoice with valid IDs, amount and timestamps"},400);
  await sb.from("cash_reconciliation_settings").upsert({owner_id:agent.owner_id,store_key:"mcc",pos_store_id:MCC_POS_STORE_ID,store_name:"MCC Eastern Creek",coverage_active:true},{onConflict:"owner_id,store_key"});
  if(clean.length){ const {error}=await sb.from("cash_pos_payments").upsert(clean.map((x)=>({...x,owner_id:agent.owner_id})),{onConflict:"owner_id,source,source_uuid,payment_ref"}); if(error) throw error; }
  const result=await reconcileStore(sb,agent.owner_id,"mcc");
  return reply({ok:true,accepted:clean.length,reconciliation:result});
}

export async function handleCashReview(req: Request, ownerId: string, sb: SupabaseClient, reply: Reply) {
  const b=await req.json().catch(()=>null), eventId=b?.event_id, action=b?.action, paymentId=b?.payment_id??null, note=typeof b?.note==="string"?b.note.trim().slice(0,500):null;
  if(!UUID.test(eventId||"")||!["match","clear","needs_review"].includes(action)||action==="match"&&!UUID.test(paymentId||"")) return reply({error:"bad review request"},400);
  const {data,error}=await sb.rpc("cash_manual_reconciliation",{p_owner:ownerId,p_event:eventId,p_action:action,p_payment:paymentId,p_note:note});
  if(error) return reply({error:error.message.includes("already matched")?"payment already matched to another event":"review could not be saved"},409);
  return reply(data);
}

export async function generateDailyReport(sb: SupabaseClient, ownerId: string, storeKey: string, day: string, force=false) {
  if(!force){const {data}=await sb.from("cash_daily_reports").select("id").eq("owner_id",ownerId).eq("store_key",storeKey).eq("business_date",day).maybeSingle(); if(data)return {skipped:"already created",id:data.id};}
  const {data:cfg}=await sb.from("cash_reconciliation_settings").select("store_name").eq("owner_id",ownerId).eq("store_key",storeKey).eq("coverage_active",true).single();
  const from=sydMidnight(day),to=sydMidnight(addDays(day,1));
  const [{data:ev,error:ee},{data:pay,error:pe}]=await Promise.all([
    sb.from("cash_events").select("id,detected_at,match_status,matched_payment_id,label").eq("owner_id",ownerId).eq("store_key",storeKey).gte("detected_at",from).lt("detected_at",to).order("detected_at"),
    sb.from("cash_pos_payments").select("id,source_ref,paid_at,cash_amount,total_amount,reconciliation_status,matched_event_id").eq("owner_id",ownerId).eq("store_key",storeKey).eq("business_date",day).order("paid_at"),
  ]); if(ee)throw ee;if(pe)throw pe;
  if(!cfg) throw new Error("cash coverage setting not found");
  const events=ev||[],payments=pay||[],matched=events.filter((x)=>x.match_status==="matched").length,unmatched=events.filter((x)=>x.match_status==="unmatched").length;
  const reviewE=events.filter((x)=>x.match_status==="needs_review"),reviewP=payments.filter((x)=>x.reconciliation_status==="needs_review"),posMissing=payments.filter((x)=>x.reconciliation_status==="pos_without_detection");
  const amount=payments.reduce((n,x)=>n+Number(x.total_amount??x.cash_amount??0),0), exceptions:string[]=[];
  for(const x of events.filter((e)=>e.match_status==="unmatched")) exceptions.push(`Camera ${time(x.detected_at)} — no POS invoice within the matching window`);
  for(const x of posMissing) exceptions.push(`${x.source_ref} · ${money(x.total_amount??x.cash_amount)} · ${time(x.paid_at)} — POS without camera detection`);
  for(const x of reviewP) exceptions.push(`${x.source_ref} · ${money(x.total_amount??x.cash_amount)} · ${time(x.paid_at)} — needs manual review`);
  for(const x of reviewE) exceptions.push(`Camera ${time(x.detected_at)} — needs manual review`);
  const body=[`Cash Audit — ${cfg.store_name} — ${displayDate(day)}`,`POS cash transactions: ${payments.length}`,`POS cash amount: ${money(amount)}`,`Camera cash events: ${events.length}`,`Matched transactions: ${matched}`,`Unmatched camera events: ${unmatched}`,`POS cash transactions without camera detection: ${posMissing.length}`,`Items needing manual review: ${reviewE.length+reviewP.length}`,"", "Exceptions:",...(exceptions.length?exceptions.map((x)=>`- ${x}`):["- None"]),"","Mismatches are review alerts, not proof of wrongdoing. Camera confidence is detection confidence only."].join("\n");
  const {data:agent}=await sb.from("agents").select("id").eq("owner_id",ownerId).eq("slug","stockwise").single();
  if(!agent) throw new Error("StockWise agent not found");
  const severity=exceptions.length?"watch":"info";
  const {data:card,error:cardErr}=await sb.from("agent_cards").insert({owner_id:ownerId,agent_id:agent.id,kind:"report",severity,shop:cfg.store_name,headline:`Cash Audit: ${matched} matched · ${exceptions.length} exception${exceptions.length===1?"":"s"}`,glance:`${payments.length} POS cash · ${events.length} camera · ${matched} matched · ${exceptions.length} review alert${exceptions.length===1?"":"s"}`,summary:`Daily text-only Cash Audit report for ${displayDate(day)}.`,body_md:body,data:{cash_audit:true,business_date:day,store_key:storeKey}}).select("id").single(); if(cardErr)throw cardErr;
  if(!card) throw new Error("report card was not created");
  const report={owner_id:ownerId,store_key:storeKey,store_name:cfg.store_name,business_date:day,pos_cash_count:payments.length,pos_cash_amount:amount,camera_event_count:events.length,matched_count:matched,unmatched_camera_count:unmatched,pos_without_detection_count:posMissing.length,needs_review_count:reviewE.length+reviewP.length,body_text:body,card_id:card.id,updated_at:new Date().toISOString()};
  const {data,error}=await sb.from("cash_daily_reports").upsert(report,{onConflict:"owner_id,store_key,business_date"}).select("id").single();if(error)throw error;
  return {id:data.id,card_id:card.id,matched,exceptions:exceptions.length};
}

export async function runCashTick(sb: SupabaseClient, now=new Date(), forceReport=false) {
  const reconciliation=await reconcileAll(sb,now), p=parts(now), reports=[];
  if(forceReport||(Number(p.hour)===19&&Number(p.minute)>=5)){
    const {data}=await sb.from("cash_reconciliation_settings").select("owner_id,store_key").eq("coverage_active",true);
    for(const x of data||[]) reports.push(await generateDailyReport(sb,x.owner_id,x.store_key,`${p.year}-${p.month}-${p.day}`,forceReport));
  }
  return {ok:true,reconciliation,reports,server_time:now.toISOString(),sydney_time:`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`};
}
