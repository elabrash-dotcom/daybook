# StockWise agent (Claude Managed Agents)

What's in this folder:
- `instructions.md`: the agent's system prompt (rules, card format, how to post to Daybook).
- `memory/rules.md`: seeded into the read-only "StockWise rules" memory store.
- `schedules.json`: cron times (Australia/Sydney) and the per-run cost cap (US cents).
- `skills/pop-scoreboard/`: the poster skill (`SKILL.md` + `render.py`).

How it's used:
- After changing anything here, run `node agents/stockwise/build.mjs`. It regenerates `supabase/functions/agent-gateway/stockwise_def.ts`.
- Then deploy `agent-gateway` and tap **Agents → ⚙️ → Update** in Daybook.
- Setup runs inside Supabase with the secret `ANTHROPIC_AGENT_API_KEY`. No key ever lives in this repo or the browser.
- New schedules are created **paused**. They only run after **Switch on** in Daybook.
