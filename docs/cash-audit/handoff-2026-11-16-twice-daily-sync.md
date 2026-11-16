# Cash Audit: twice-daily POS sync + "Sync POS Now" (2026-11-16)

Repo `elabrash-dotcom/daybook` · Production Supabase `scjfvvwylrgpbrmdsjxb` · UI merged to `main` as [PR #10](https://github.com/elabrash-dotcom/daybook/pull/10) (`0098680`) · Service-worker cache `daybook-v41` · Agent gateway **v16** · Migration `20261116_cash_sync.sql`

## Status at a glance
| Item | Status |
|---|---|
| Code, tests, migration, gateway v16, UI merge | Done |
| New schedules created in Anthropic | **Pending: Idris must tap Agents → Setup → Times → Update (or Create)** |
| Old 15-minute `cash_sync` archived | **Pending, same tap** (still running until then) |
| Real manual-fetch test | **Pending, needs the tap first** |
| 7:05 PM report gating verified live | Pending (first evening after the tap) |

## What changed
1. **Schedules** (`agents/stockwise/schedules.json`, regenerated `stockwise_def.ts` via `agents/stockwise/build.mjs`), all on the existing StockWise agent, timezone `Australia/Sydney` (DST-aware):
   - `cash_sync_1pm` `0 13 * * *`
   - `cash_sync_645pm` `45 18 * * *`
   - `cash_sync_manual`: no cron, never fires on its own, used only by the button
   - Legacy `cash_sync` (15 min) is retired by `setup()` (archive, pause as fallback; failure to do either raises an error). Other 7 schedules unchanged.
2. **Sync POS Now** (Daybook → Cash Audit)
   - `POST /cash/sync` and `GET /cash/sync/status`, Daybook login only (`cashGate`: camera/other devices get 403).
   - Starts the manual deployment, so the agent does a real StockWise fetch and posts to the existing `/ingest/cash-sync`; the gateway then reconciles (deterministic, no AI).
   - One run at a time: `cash_sync_claim` (advisory lock + unique partial index); refused while a scheduled sync is running; stale jobs time out after 20 min.
   - UI shows progress, success/failure, last successful sync time, new invoices imported, and refreshes the screen.
   - `/internal/cash/ops` (cron key only): `sync`, `status`, `schedules` (live Anthropic view).
3. **Report gating** (`cash_sync_core.ts`, `cash_phase2.ts`): 7:05 PM text-only report waits for a running 6:45 PM sync until 7:30 PM, then is sent with a ⚠️ "POS incomplete" banner. It is regenerated (same card) if a later sync completes the data. Never presents stale POS data as complete.
4. **DB** (additive): `cash_sync_jobs`, `cash_sync_log`, `cash_daily_reports.pos_sync_state/pos_synced_at`, RLS owner-read only, `cash_sync_settle`, `cash_sync_claim`. Backup: `cash_backup_20261115.cash_daily_reports_20261116`.

## Unchanged
Jetson events/images, 5-minute gateway reconciliation (no AI), manual review, audit history, retention, matching rules, MCC Eastern Creek only, report is text only. Jetson detector/uploader and StockWise POS not touched.

## Tests
- 90 Node/Postgres tests pass (schedules, DST, report gating, lock under 8 parallel presses, settle/timeout, RLS, permissions).
- 4 mobile UI suites pass (`cash_ui`, `cash_recon_ui`, `agent_sched_ui`, `cash_sync_ui`), with mocked Supabase.
- Live: after v16 deploy `/internal/cash/ops {schedules}` returned 200 and showed the new schedules "not set up" and `cash_sync` still in config (expected before the tap). Byte-for-byte parity of the deployed files was not re-checked this time.

## Next steps after Idris taps Update
1. Check `agents.config` and `/internal/cash/ops {action:'schedules'}`: expect 1 PM + 6:45 PM active, manual deployment present, `cash_sync` archived, no 15-minute runs.
2. Run a real fetch via `{action:'sync'}` and the button; check `cash_sync_jobs` and `cash_sync_log`.
3. Confirm the 6:45 PM run and the 7:05 PM report banner/complete state.

## Open caveats
- Retention worker still on Mac-2 (should move to the Jetson).
- Mixed cash+card invoices are excluded.
- Storage region / overseas processing not verified (flag, not assumed).
- Camera heartbeat only updates when the uploader calls in.
