# Terracotta POC

## What this is

Pre-application slice of Terracotta, a multi-agent system for subsidized-housing landlords. Core loop: money-order image → Claude Vision extracts fields → DB shortlist of candidate tenants → second Claude call reasons about the match → branches on confidence → human confirms exceptions → corrections teach the system via aliases.

This is not OCR. It is an agentic workflow: two Claude calls, a state machine, a learning loop.

The hackathon extension will add HAP PDF reconciliation and Zelle screenshot intake on top of this same codebase. **Nothing in this POC should require rewriting when we extend** — use the real table names and schema from the build spec, not simplified demo versions.

## Authoritative reference

**`docs/BUILD_SPEC.md` is the source of truth.** Read the sections relevant to the phase you are working on before writing code. When this file and the spec disagree, the spec wins. When the spec is silent, ask before inventing.

## Non-negotiables

These are the landmines. Getting any of them wrong is either a 400 at runtime, a broken prod deploy, or a breaking change at hackathon-extension time.

### Stack pins

- Prisma `^6` and `@prisma/client` `^6`. **Do NOT install Prisma 7** — it removed `datasource.directUrl` and will not parse the schema in Spec §3.
- Next.js 16 App Router. In this project, that means `/tenants/[id]/page.tsx` and all `[id]/route.ts` handlers under `/api/...` — `await params` before using it. Next's async-params rule is broader than just these surfaces; if you add metadata or image handlers later, check the Next 16 docs before assuming sync access is fine.
- `@anthropic-ai/sdk` current. Model ID exact string: `claude-opus-4-7`.
- Supabase Postgres Pro, Vercel for hosting. No object storage — money-order image goes in `ReviewItem.imageBase64` and is nulled on confirm.

### Opus 4.7 API rules

- **Never set `temperature`, `top_p`, or `top_k`.** Any non-default value returns 400. Strip them from SDK wrappers if they are injected by default.
- **Extraction call:** no thinking, `tool_choice: {type: "tool", name: "extract_money_order"}`, `max_tokens: 2048`.
- **Reasoning call:** `thinking: {type: "adaptive"}`, `output_config: {effort: "xhigh"}`, `tool_choice: {type: "auto"}`, `max_tokens: 8192`. **Forcing a tool with thinking on returns 400.** Compensate with a prompt that says "You MUST use the decide_match tool."
- `effort` lives inside `output_config`, not as a top-level parameter.
- Adaptive is the only thinking mode on 4.7. Do not use `{type: "enabled", budget_tokens: N}` — it returns 400.
- **Do not use assistant-message prefill.** Returns 400 on Opus 4.7. Use structured outputs, system instructions, or `output_config.format`.
- Both tools get `strict: true` with `additionalProperties: false` on every object schema.
- Check `stop_reason` for `"refusal"` and `"max_tokens"` **before** looking for the `tool_use` block. Refusals create `InboxItem` type `scan_refusal`; truncation fails the job with a clear error. Order matters for error attribution.
- **Do not downsample images.** Opus 4.7 supports up to 2576px / 3.75MP; serial numbers and handwriting depend on the detail.
- Task budgets (beta) exist but are not used in this POC. Do not add them.

### Data plumbing

- Every POST route accepts `X-Request-Id` or generates one, and stamps it on every row with a `requestId` column (`Job`, `LedgerEntry`, `TenantAlias`, `ReviewItem`, `InboxItem`). This is non-optional — it's how extensions will trace scans end-to-end.
- Supabase pooled `DATABASE_URL` (port 6543, Supavisor transaction mode) must end with `?pgbouncer=true&connection_limit=1`. Without the flag, the first prod query throws `prepared statement "s0" does not exist`.
- `DIRECT_DATABASE_URL` uses session pooler (port 5432) or direct connection — never transaction mode. Used only by `prisma migrate`.

### Worker async

- `/api/scan/process` returns 202 immediately and uses `after()` from `next/server` to run the worker. `export const maxDuration = 60`.
- Before deploying, confirm the Vercel project's function duration settings match or exceed 60s. If the limit is lower, `after()` promises are cancelled mid-worker.

## Build order

Follow Spec §11 exactly. Do not skip gates. **One Claude Code session per phase.** Clear context (`/clear`) between phases.

1. Scaffold + Prisma + seed. **Gate:** `GET /api/tenants` returns 6 tenants.
2. `/lib/claude.ts` with both tool definitions + `extractMoneyOrder` helper. **Gate:** helper returns structured output on a real money-order image.
3. `/lib/matching.ts` — alias lookup + Levenshtein + rent-amount inclusion. **Gate:** `"M LOPEZ"` appears in the top 3 candidates for Maria Lopez.
4. `/lib/worker.ts` + `/api/scan/process` with `after()`. **Gate:** uploading an image creates a Job and ticks it through extracting → matching → reasoning → routing.
5. `/app/page.tsx` — upload + review queue + live jobs panel polling every 1s. **Gate:** drop an image, watch the job tick through steps in the live panel, and see the ReviewItem appear in the queue.
6. `/app/tenants/[id]/page.tsx` + `/api/review/:id/confirm`. **Gate:** confirming a review item decrements balance, writes a ledger entry, and writes a `TenantAlias` row on correction.
7. `/app/inbox/page.tsx`. **Gate:** a low-confidence scan appears here.
8. Calibration pass with 3 images (clean / blurry / skewed). Tune tool descriptions if confidence doesn't branch correctly.
9. Deploy to Vercel. Set the three env vars in Production. Seed the prod DB. Verify end-to-end on the live URL.

## Scope discipline

Spec §12 is an explicit "do not build" list. Respect it:

- No auth, no login, no user model.
- No multi-property filtering in the UI.
- No Zelle, HAP, SMS, Cowork, or chatbot. Those are hackathon extensions.
- No image object storage (Dropbox, Supabase Storage) — base64 in the DB.
- No rate limiting, Sentry, or audit log.
- No retries or durable async vendor — `after()` is the POC worker.
- No tests beyond the manual gates in §11.
- No styling beyond clean, readable Tailwind. No dark mode, no animations.

If something seems useful but isn't in the spec, **ask before building**.

## Docs to fetch when uncertain

- Opus 4.7 migration guide (the authoritative source on prefill, temp/top_p/top_k, thinking): https://platform.claude.com/docs/en/about-claude/models/migration-guide
- What's new in 4.7 (high-res vision, effort, task budgets): https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
- Adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Structured outputs + strict tool use: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Tool use overview: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Next 16 async request APIs: https://nextjs.org/docs/app/guides/upgrading/version-16
- Supabase + Prisma: https://supabase.com/docs/guides/database/prisma

## Done

All seven boxes in Spec §14 must be checked. The two that Claude Code is most likely to forget:

- README includes the **exact** "Why Claude Opus 4.7" section from Spec §13 — the lead paragraph, the six bullets (adaptive thinking, strict tool use, high-res vision, literal instruction-following, alias learning loop, auditable agent loop), and the meta-note about the 134-unit portfolio.
- Confirming a review item with a *different* tenant than Claude suggested must write a `TenantAlias`, and uploading the same-named money order a second time must auto-suggest the corrected tenant. This is the learning loop — without it, the core pitch is unproven.

Don't declare done until every box is checked.
