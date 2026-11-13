# Cash Audit: free development project setup and end-to-end test

Everything here targets a **separate development project**. Production (`scjfvvwylrgpbrmdsjxb`) is never touched; the test script refuses to run against it.

## Why you need to do the first part
From the Claude session I cannot create or reach a Supabase project: the Supabase connector was disconnected (and only ever pointed at production), there is no Supabase access token or CLI, and the sandbox cannot reach any `*.supabase.co` host. Creating the project, deploying the function and running the test therefore happen on your side. Total time: about 10 minutes.

## A. Create a free project (no charges)
1. Open https://supabase.com/dashboard.
2. **Make sure it is a Free-plan organization.** Look at Organization → Billing. If your production project's organization is on Pro/Team, a second project there is billed, so create a new organization and choose the **Free** plan for it. (A Free organization is limited to 2 free projects, and free projects pause after about a week of no use.)
3. New project: name `daybook-cash-dev`, region **Sydney (ap-southeast-2)**, set a database password and save it in your password manager.
4. **Stop if the create screen shows any monthly cost above $0.** Do not click Create; tell me instead.
5. Wait until the project is ready (about 2 minutes). Note the **project reference** (the part before `.supabase.co` in its URL).

## B. Database
Dashboard → SQL Editor → New query. Run these two files **in order**, each as its own query (copy the file contents from the repo branch `claude/new-session-bvpb4w`):
1. `supabase/dev/dev_bootstrap.sql` (dev only: creates the `agent_devices` table that production already has)
2. `supabase/migrations/20261113_cash_audit_phase1.sql` (the Cash Audit migration)

Both should finish with "Success". Check: Database → Tables shows `cash_events`, `cash_pos_payments`, `agent_devices`; Storage shows a **private** bucket `cash-snapshots`.

## C. Two test users
Authentication → Users → Add user → "Create new user", tick **Auto Confirm User**:
- owner: any throwaway email and password (for example `cash-dev-owner@example.com`)
- other: a second throwaway email and password (proves owners cannot see each other's data)

## D. Deploy the gateway (development only)
On a computer with Node 20+ and the repo cloned on the branch `claude/new-session-bvpb4w`:
```bash
npx supabase login
npx supabase functions deploy agent-gateway --project-ref <DEV_PROJECT_REF> --no-verify-jwt
```
- `<DEV_PROJECT_REF>` must be the development project's reference, never `scjfvvwylrgpbrmdsjxb`.
- It deploys every file in `supabase/functions/agent-gateway/`. The function needs no secrets of its own; Supabase injects its URL and service key. (The Stockwise/Anthropic keys are not needed for Cash Audit.)
- If the CLI says it cannot find a project config, run `npx supabase init` once in the repo and do not commit the generated `supabase/config.toml`.

## E. Run the end-to-end test (synthetic data only)
Dashboard → Project Settings → API: copy the **anon / publishable** key (not the service_role key).
```bash
DEV_URL=https://<DEV_PROJECT_REF>.supabase.co \
DEV_ANON_KEY=<anon key> \
DEV_EMAIL=<owner email> DEV_PASSWORD=<owner password> \
DEV_EMAIL2=<other email> DEV_PASSWORD2=<other password> \
node tests/cash-dev/e2e.mjs
```
It registers the test store `dev-test` and a camera device, then checks (about 65 checks): authentication and boundaries, event ingestion, secret scrubbing, duplicate protection, signed uploads of synthetic images, confirm, private image viewing (public URL refused, tampered links refused, the owner can only use signed links, another user sees nothing), row-level security, the four review labels, and revocation. It exits 0 only if all pass. **Paste the output to me** and I will fix anything that fails.

(The same script already passes 65/65 against a local fake of Supabase on real PostgreSQL. The parts only a real project can prove are Storage signed uploads, signed view links and PostgREST behaviour.)

## F. Optional: let me run it for you
If you would rather I run step E and iterate on failures: give me the project reference and the anon key (a public key) plus the two throwaway dev users' credentials, and approve adding `<ref>.supabase.co` to the session network allow-list. I still cannot do steps A to D, because deploying needs an account-level token that would also reach production, which I will not accept.

## G. Handoff to GPT Work (after E passes)
| Item | Value |
|---|---|
| Development project reference | `<DEV_PROJECT_REF>` (fill in after step A) |
| Gateway base URL | `https://<DEV_PROJECT_REF>.supabase.co/functions/v1/agent-gateway` |
| Test store key | `dev-test` |
| Test data | **synthetic only.** Do not point the dev uploader at `/mnt/cash-ssd/live-events`; use generated events and generated images |
| Contract | `docs/cash-audit/api-spec.md` |

**Token provisioning (secure):**
1. Create the device token once, as the owner: sign in (`POST <URL>/auth/v1/token?grant_type=password` with the anon key) and call `POST /admin/devices` with `{"label":"gpt-work-dev","store_key":"dev-test"}` and the user token. The response contains `token` (starts `dvc_`) **once**. (Or run `node tools/make-device-token.mjs --owner <owner uuid> --store dev-test --label gpt-work-dev` and run the printed SQL.)
2. Hand it over through a password manager or secret share, never through chat, email, git or logs.
3. On the machine that runs the uploader keep it only in an environment file, for example `/etc/cash-uploader.env` with mode `600` owned by the service user: `CASH_DEVICE_TOKEN=dvc_…`, `CASH_API_BASE=…`.
4. The token fixes the owner and the store. If it leaks or the device is lost, revoke it (`POST /admin/devices/revoke`) and issue a new one; old tokens stop working immediately.
5. Production gets its **own** token later. Dev and prod tokens are different and not interchangeable.
