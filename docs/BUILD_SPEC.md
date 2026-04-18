# Terracotta POC — Build Spec for Claude Code (Opus 4.7)

This is a complete build specification for the **pre-application slice** of Terracotta, a multi-agent system for subsidized housing landlords. Build the full thing described below. Work incrementally, test after each major step, and ask me before making any architectural decision I haven't specified.

---

## 0. Context

I'm applying to a Claude Code hackathon. This POC is my public shipping artifact — it proves the core agentic loop works end to end. The hackathon extension will add HAP PDF reconciliation and Zelle screenshot intake on top of this same codebase. **Nothing in this POC should require rewriting when we extend** — use the real table names and schema from my architecture doc, not simplified demo versions.

The core loop being demonstrated:

> Money order image → Claude Vision extracts fields → DB looks up candidate tenants → second Claude call reasons about the match → branches on confidence → human confirms exceptions → correction teaches the system via aliases.

This is not OCR. It is an agentic workflow with two Claude calls, a state machine, and a learning loop.

---

## 1. Stack (non-negotiable)

- **Framework:** Next.js 16+ App Router + TypeScript + Tailwind. Next 16 (released October 2025) is the current stable; `after()` is stable since 15.1 and remains stable in 16. Install via `create-next-app@latest` or `npm install next@latest react@latest react-dom@latest` — as of April 2026, `next@latest` resolves to the 16.x line. **Important compat note:** on Next.js 16, async request APIs matter throughout the App Router. `params` is async in dynamic pages, layouts, default files, route handlers, and several metadata/image/sitemap handlers. `searchParams` is async where Next provides it as a prop, notably pages and `generateMetadata`. In this POC, that affects `/tenants/[id]/page.tsx` and every `[id]` route handler in `/app/api/...`; each must `await params` before using it. Pattern: `export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; ... }`. The codemod `npx @next/codemod@canary upgrade latest` handles most of this if migrating, but a fresh project scaffold already produces the correct pattern.
- **Database:** Supabase Postgres (Pro tier — $25/mo). Pro removes the inactivity pause and includes daily backups with 7-day retention, plus 8 GB DB storage and 100 K MAUs. Point-in-Time Recovery (PITR) is available as a paid add-on (requires at least the Small compute add-on), not included in Pro by default. Daily backups are enough safety net for the POC.
- **ORM:** Prisma — pin to `prisma@^6` and `@prisma/client@^6`. Do NOT install the latest without checking. Prisma 7 (released Nov 2025) removed `datasource.directUrl` in favor of `prisma.config.ts`, which would break the schema block in Section 3. Supabase's official Prisma integration guide is written for v6 patterns. Install command: `npm install -D prisma@^6 && npm install @prisma/client@^6`.
- **AI:** `@anthropic-ai/sdk` — model `claude-opus-4-7`
- **Hosting:** Vercel
- **Async:** worker triggered from the API route via `after()` from `next/server`. The API route returns 202 immediately and `after()` extends the serverless invocation lifetime until the worker finishes. During the hackathon we swap `after()` for Inngest; the `jobs` table exists from day one so the swap is non-breaking.
- **Auth:** none (public demo, fake data)
- **File storage:** no object storage; the money-order image is stored temporarily in `ReviewItem.imageBase64` for the review UI and nulled on confirm (see Section 3 schema + Section 7 worker).

## 2. Opus 4.7 API specifics — READ THIS BEFORE WRITING ANY CLAUDE CALLS

These are breaking changes and compatibility constraints from the current Anthropic docs. Several of them return 400 errors if ignored. Get them right the first time.

- **Model ID:** `claude-opus-4-7` (exact string)

- **Do NOT set `temperature`, `top_p`, or `top_k`.** Setting any of these to a non-default value returns a 400 error on Opus 4.7. Omit them entirely. Also check the SDK wrapper and any helper layer — make sure nothing is quietly injecting them.

- **Adaptive thinking + forced tool_choice are INCOMPATIBLE.** This is the single most important constraint to get right. Per the docs: when thinking is enabled, tool use only supports `tool_choice: {type: "auto"}` (default) or `{type: "none"}`. Using `{type: "tool", name: "..."}` or `{type: "any"}` with thinking returns an error. This means:
  - **Extraction call** (no thinking): use `tool_choice: {type: "tool", name: "extract_money_order"}` to force the tool. This is fine.
  - **Reasoning call** (thinking on): use `tool_choice: {type: "auto"}` with a very explicit prompt telling the model it MUST use the `decide_match` tool and must not respond in free text. Accept only `tool_use` blocks named `decide_match` in the response; if none appears, mark the job failed and surface an inbox item.

- **`effort` goes inside `output_config`**, not as a top-level parameter. Per the docs: `output_config: {effort: "xhigh"}`. Use `xhigh` on the reasoning call; omit `effort` on the extraction call (default `high` is fine for a bounded vision task).

- **Adaptive thinking is off by default.** Enable it on the reasoning call with `thinking: {type: "adaptive"}`. On Opus 4.7 this is the only supported thinking mode — do not use `{type: "enabled", budget_tokens: N}`, it returns a 400.

- **`max_tokens` must leave room for thinking.** Thinking tokens count against `max_tokens`, and Opus 4.7's new tokenizer uses up to ~35% more tokens than 4.6. Use:
  - **Extraction call:** `max_tokens: 2048` (bounded structured output, no thinking)
  - **Reasoning call:** `max_tokens: 8192` to start, raise to 16384 if you see truncation on complex cases. The docs suggest 64k as the starting point for xhigh coding workloads; for this narrow matching task 8192 is a reasonable compromise.

- **Do NOT use assistant-message prefill.** Prefilling assistant messages returns a 400 error on Claude Opus 4.7. Use structured outputs, system instructions, or `output_config.format` instead.

- **Use `strict: true` on both tool definitions.** Per the structured outputs docs, `strict: true` enforces schema validation via constrained decoding — guaranteed valid tool inputs, no retries on schema violations. Since tools are our structured-output mechanism, we want this everywhere. Note: `strict: true` requires `additionalProperties: false` on all object schemas.

- **High-resolution images supported up to 2576px / 3.75MP.** Do NOT downsample money-order images client-side — fine detail matters for serial numbers and handwriting. This is a genuine upgrade over 4.6.

- **More literal instruction following than 4.6.** Be explicit in tool descriptions and prompts. The model will not generalize from one instruction to another, and will not infer requests you didn't make. For the reasoning call especially, spell out "you must use the decide_match tool" because `tool_choice: auto` means the model could theoretically respond in text.

- **Fewer tool calls by default on 4.7.** The model is more conservative about invoking tools than 4.6. Raising effort to `xhigh` counteracts this.

- **Task budgets exist on Opus 4.7 (beta)** as an advisory budget across a full agentic loop, but they are not needed for this POC and should not be added unless we explicitly decide to control full-loop token spend.

Docs for reference (current as of this spec's creation):
- What's new in Opus 4.7: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
- Effort parameter: https://platform.claude.com/docs/en/build-with-claude/effort
- Adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Structured outputs + strict tool use: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

---

## 3. Database schema (Prisma)

Use these exact table and field names. They match the production architecture so the hackathon extension is additive, not a rewrite.

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}
// NOTE: This datasource block uses the Prisma 6.x schema syntax.
// On Prisma 7+, `url` and `directUrl` are moved out of schema.prisma
// and into `prisma.config.ts`. This spec pins Prisma 6.x — see Section 1.

model Property {
  id        String   @id @default(uuid())
  name      String
  address   String
  units     Unit[]
  createdAt DateTime @default(now())
}

model Unit {
  id          String   @id @default(uuid())
  propertyId  String
  unitNumber  String
  bedrooms    Int
  property    Property @relation(fields: [propertyId], references: [id])
  tenants     Tenant[]
  createdAt   DateTime @default(now())
  @@unique([propertyId, unitNumber])
}

model Tenant {
  id              String          @id @default(uuid())
  unitId          String
  fullName        String
  monthlyRent     Decimal         @db.Decimal(10, 2)
  currentBalance  Decimal         @db.Decimal(10, 2) @default(0)
  status          String          @default("active") // active | notice_given | moved_out
  unit            Unit            @relation(fields: [unitId], references: [id])
  ledgerEntries   LedgerEntry[]
  aliases         TenantAlias[]
  reviewItems     ReviewItem[]
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
}

model TenantAlias {
  id          String   @id @default(uuid())
  aliasText   String   // the name as it appeared on a scan, e.g. "M. LOPEZ"
  tenantId   String
  source      String   // "scan" | "manual"
  confidence  Float    // 1.0 for manual entries
  requestId   String   // UUID from the API request that created this alias
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  createdAt   DateTime @default(now())
  @@index([aliasText])
}

model LedgerEntry {
  id             String   @id @default(uuid())
  tenantId       String
  effectiveDate  DateTime @db.Date
  postedAt       DateTime @default(now())
  amount         Decimal  @db.Decimal(10, 2)
  type           String   // "payment" | "charge" | "credit" | "adjustment"
  category       String   // "rent" | "hap" | "other"
  paymentMethod  String?  // "money_order" | "zelle" | "hap_ach" | etc.
  source         String?  // "money_order_scan" | "manual" | etc.
  memo           String?
  requestId      String   // UUID from the API request
  postedBy       String   // user id or "system"
  status         String   @default("active") // active | voided
  tenant         Tenant   @relation(fields: [tenantId], references: [id])
  createdAt      DateTime @default(now())
  @@index([tenantId, effectiveDate])
}

model Job {
  id          String   @id @default(uuid())
  type        String   // "scan_processing"
  status      String   @default("queued") // queued | running | completed | failed
  step        String?  // "extracting" | "matching" | "reasoning" | "routing"
  inputData   Json?
  outputData  Json?
  error       String?
  attempts    Int      @default(0)
  maxAttempts Int      @default(3)
  requestId   String
  enqueuedAt  DateTime @default(now())
  startedAt   DateTime?
  completedAt DateTime?
}

model ReviewItem {
  id                String   @id @default(uuid())
  jobId             String   @unique
  suggestedTenantId String?
  extractedData     Json     // payee, amount, memo, serial, issuer, confidence (from vision)
  reasoningData     Json     // reasoning call output: chosen tenant id, confidence, rationale
  imageBase64       String?  @db.Text // nullable; cleared on confirm after ledger is posted
  requestId         String   // UUID from the API request that enqueued the scan
  status            String   @default("pending") // pending | confirmed | rejected
  tenant            Tenant?  @relation(fields: [suggestedTenantId], references: [id])
  createdAt         DateTime @default(now())
  resolvedAt        DateTime?
}

model InboxItem {
  id         String   @id @default(uuid())
  type       String   // "scan_low_confidence" | "scan_no_match" | "scan_refusal"
  severity   String   @default("medium")
  title      String
  summary    String
  data       Json     // full context for rendering
  requestId  String   // UUID from the API request that created this item
  status     String   @default("open") // open | resolved | dismissed
  createdAt  DateTime @default(now())
  resolvedAt DateTime?
}
```

---

## 4. Seed data

After migration, run a seed script that creates:

- **2 properties** (e.g. "1823 N Kedzie" and "4410 W Adams")
- **6 units total** (3 per property)
- **6 tenants** — one per unit. Give them varied names where fuzzy matching will be interesting. Suggested:
  - Maria Lopez, Unit 2B, rent $847
  - Terrence Williams, Unit 3A, rent $923
  - James Green, Unit 1A, rent $1,100
  - Dominique Washington, Unit 4B, rent $850
  - Sarah O'Brien, Unit 2A, rent $900
  - Michael Chen, Unit 3B, rent $975
- Each tenant starts with `currentBalance` equal to one month's rent owed.
- No initial aliases. No initial ledger entries.

---

## 5. API endpoints

```
POST /api/scan/process     — accepts { imageBase64, mediaType }; returns 202 { jobId }
GET  /api/jobs             — lists recent jobs (for live panel)
GET  /api/jobs/:id         — single job state
GET  /api/review-queue     — all ReviewItem rows with status=pending
POST /api/review/:id/confirm   — accepts { tenantId }; writes ledger + alias + sets status=confirmed
POST /api/review/:id/reject    — accepts { reason? }; sets status=rejected
GET  /api/tenants          — list
GET  /api/tenants/:id      — single tenant with ledger history
GET  /api/inbox            — InboxItem rows with status=open
POST /api/inbox/:id/status — accepts { status: "resolved" | "dismissed" }; sets resolvedAt=now
```

All POST routes must:
- Accept a `request_id` in headers (`X-Request-Id`) or generate one
- Stamp the `request_id` on any row they create that has a `requestId` column (Job, LedgerEntry, TenantAlias, ReviewItem, InboxItem)

---

## 6. Tool schemas (Claude Vision tool_use)

### Extraction call — `extract_money_order`

```typescript
{
  name: "extract_money_order",
  description: "Extract structured fields from a US money order image. Set field values to null if not legibly present. Set overall_confidence low (< 0.7) if the image is blurry, skewed, or if any field required guessing.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      payee_name_raw: {
        type: ["string", "null"],
        description: "The payee name EXACTLY as written, preserving capitalization and abbreviations (e.g. 'M. LOPEZ', 'Maria Lopez', 'LOPES M'). null if unreadable."
      },
      amount_usd: {
        type: ["number", "null"],
        description: "Dollar amount as a number, e.g. 847.00. null if unreadable."
      },
      purchaser_name: { type: ["string", "null"] },
      purchaser_address: { type: ["string", "null"] },
      serial_number: { type: ["string", "null"] },
      issue_date: {
        type: ["string", "null"],
        description: "ISO 8601 date if present, e.g. 2026-04-15. null if not present."
      },
      memo: {
        type: ["string", "null"],
        description: "Memo line text — often contains unit number or tenant reference. null if blank."
      },
      issuer: {
        type: "string",
        enum: ["USPS", "MoneyGram", "Western Union", "Other", "Unknown"]
      },
      overall_confidence: {
        type: "number",
        description: "Overall extraction confidence between 0 and 1. Below 0.7 means PM should review."
      },
      notes: {
        type: ["string", "null"],
        description: "Anything unusual about the image — blur, crossouts, ambiguity. null if nothing noteworthy."
      }
    },
    required: [
      "payee_name_raw",
      "amount_usd",
      "purchaser_name",
      "purchaser_address",
      "serial_number",
      "issue_date",
      "memo",
      "issuer",
      "overall_confidence",
      "notes"
    ]
  }
}
```

Note: `minimum`/`maximum` constraints are stripped by the strict-tools compiler and enforced via the description. Validate the returned `overall_confidence` in application code.

### Reasoning call — `decide_match`

This call receives the extracted fields + a shortlist of candidate tenants (with balances and recent payment history) and decides the best match.

```typescript
{
  name: "decide_match",
  description: "Given extracted money-order fields and a list of candidate tenants from the system, decide which tenant this payment is for. Consider name similarity (including common misspellings, initials, married/maiden names), amount alignment with rent, memo hints (unit number references), and recency of last payment. If no candidate is a strong match, set chosen_tenant_id to null.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chosen_tenant_id: {
        type: ["string", "null"],
        description: "UUID of the best-match tenant, or null if no candidate meets the bar."
      },
      match_confidence: {
        type: "number",
        description: "Confidence in the chosen match, between 0 and 1. >= 0.85 = auto-route to review queue. 0.6-0.84 = review queue with warning. < 0.6 = inbox item."
      },
      rationale: {
        type: "string",
        description: "One or two sentences explaining the decision. Reference specific signals used."
      },
      alternative_ids: {
        type: "array",
        items: { type: "string" },
        description: "Other tenant ids considered, in descending likelihood. Empty array if no alternatives."
      }
    },
    required: ["chosen_tenant_id", "match_confidence", "rationale", "alternative_ids"]
  }
}
```

**Important: tool_choice differs between the two calls.**
- **Extraction call:** `tool_choice: {type: "tool", name: "extract_money_order"}` — safe because no thinking.
- **Reasoning call:** `tool_choice: {type: "auto"}` — required because thinking is enabled and forced tool_choice is incompatible. Compensate with a very explicit prompt: "You MUST use the decide_match tool. Do not respond in free text. If no candidate is strong enough, call the tool with chosen_tenant_id = null." In application code, accept only `tool_use` blocks named `decide_match`; if none appears, mark the job failed and create an InboxItem of type `scan_no_match` with a note that the model did not call the tool.

---

## 7. The worker — state machine spec

Triggered from `/api/scan/process` via `after()` from `next/server`. The route returns 202 immediately; `after()` extends the serverless invocation lifetime until the worker finishes. In the hackathon extension this becomes an Inngest function; the shape of each step stays the same.

**Why `after()` and not fire-and-forget:** Vercel serverless functions terminate when the response is sent. A plain `asyncWorker()` call with no `await` will get killed mid-flight. `after()` tells the runtime "extend my lifetime until this promise settles." This is the documented pattern for post-response work on Next.js 15.1+ (including 16.x).

```typescript
// /app/api/scan/process/route.ts
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { runScanWorker } from "@/lib/worker";

// after() only runs within this function's configured max duration.
// Vercel will terminate the function when its timeout is reached, and
// promises passed to after()/waitUntil() are cancelled with it.
// Set a generous limit here and verify your project's actual duration
// settings in the Vercel dashboard before deploying — defaults vary by
// plan and by whether Fluid Compute is enabled on the project.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { imageBase64, mediaType } = await req.json();
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  const job = await prisma.job.create({
    data: { type: "scan_processing", status: "queued", requestId,
            inputData: { mediaType } /* do not log imageBase64 */ },
  });

  // Extend serverless lifetime until worker completes
  after(async () => {
    await runScanWorker({ jobId: job.id, imageBase64, mediaType, requestId });
  });

  return Response.json({ jobId: job.id }, { status: 202 });
}
```

The worker itself:

```
1. START WORKER (inside after() callback)
   - Set Job.status=running, Job.startedAt=now, step="extracting"

2. EXTRACT (Claude call #1)
   - Model: claude-opus-4-7
   - max_tokens: 2048
   - Message: image first, then text "Extract this money order's fields. Use the extract_money_order tool."
   - tools: [extractMoneyOrderTool] (with strict: true)
   - tool_choice: { type: "tool", name: "extract_money_order" }
   - No thinking, no output_config
   - Response handling (check in this order):
     - If response.stop_reason === "refusal": fail job with error="extraction refused", create InboxItem type="scan_refusal", return
     - If response.stop_reason === "max_tokens": fail job with error="extraction truncated at max_tokens", return
     - Find content block with type === "tool_use" AND name === "extract_money_order"
     - If not found: fail job with error="extraction did not return tool_use", return
     - On success: update Job.outputData.extraction, set step="matching"

3. MATCH (DB query, no Claude)
   - Alias lookup: SELECT * FROM tenant_aliases WHERE lower(alias_text) = lower(extracted.payee_name_raw)
   - If exact alias hit: pass that tenant as the #1 candidate with a boost flag
   - Fuzzy fallback: fetch all active tenants, compute Levenshtein distance between extracted.payee_name_raw and tenant.fullName, take top 3
   - Also include any tenant whose monthlyRent matches extracted.amount_usd within $5
   - Deduplicate, cap at 5 candidates
   - Update Job.outputData.candidates, set step="reasoning"

4. REASON (Claude call #2)
   - Model: claude-opus-4-7
   - max_tokens: 8192 (POC default — this is a latency/cost tradeoff; the docs recommend 64k as a starting point for xhigh coding workloads. If you see truncation in testing, bump to 16384. Hackathon extension: on stop_reason="max_tokens", retry once with max_tokens: 16384 before failing.)
   - thinking: { type: "adaptive" }
   - output_config: { effort: "xhigh" }
   - tools: [decideMatchTool] (with strict: true)
   - tool_choice: { type: "auto" }   ← NOT forced, thinking is on
   - Message content (single user message, text only):
     Part 1: "You MUST use the decide_match tool to answer. Do not respond in free text. If no candidate is a strong match, call the tool with chosen_tenant_id = null."
     Part 2: JSON.stringify({ extracted: <extraction result>, candidates: <candidate array with id, fullName, unitNumber, monthlyRent, currentBalance, lastPaymentDate> })
   - Response handling (check in this order — order matters for accurate error messages):
     - If response.stop_reason === "refusal": fail job with error="reasoning refused", create InboxItem type="scan_refusal", return
     - If response.stop_reason === "max_tokens": fail job with error="reasoning truncated at max_tokens (consider raising budget)", return
     - Find content block with type === "tool_use" AND name === "decide_match"
     - If NOT found: fail job with error="reasoning did not invoke decide_match tool", create InboxItem type="scan_no_match", return
     - On success: update Job.outputData.decision = block.input, set step="routing"

5. ROUTE (was "BRANCH" — just naming the step)
   - If decision.match_confidence >= 0.85 AND decision.chosen_tenant_id:
       → create ReviewItem (status=pending, requestId, imageBase64), route to review queue
   - Else if decision.match_confidence >= 0.6:
       → create ReviewItem (status=pending, requestId, imageBase64, warning flag in extractedData)
   - Else:
       → create InboxItem (type="scan_low_confidence" if chosen_tenant_id set, "scan_no_match" otherwise, requestId)
   - Either way: Job.status=completed, step=null, completedAt=now

6. APPLY (happens on PM confirmation — separate endpoint, NOT part of the worker)
   - POST /api/review/:id/confirm with { tenantId }
   - If tenantId != decision.chosen_tenant_id → treat as a correction:
       → insert TenantAlias (aliasText=extracted.payee_name_raw, tenantId=confirmed, source="scan", confidence=1.0, requestId=current request)
   - Insert LedgerEntry (type="payment", category="rent", paymentMethod="money_order", source="money_order_scan", amount, memo, requestId=current request)
   - Decrement tenant.currentBalance by the amount
   - Set ReviewItem.status=confirmed, resolvedAt=now, imageBase64=null (clear the blob now that ledger is posted)
```

Failure handling (minimal for POC):
- Claude API errors (non-200) → Job.status=failed, Job.error=<message>, create InboxItem type="scan_no_match"
- Refusals (stop_reason="refusal") → InboxItem type="scan_refusal" so PM sees this as a distinct operational signal, not a no-match
- Truncation (stop_reason="max_tokens") → Job failed with clear message; no retry in POC. Hackathon extension adds retry-with-larger-budget via Inngest.
- No retries in POC. Hackathon extension adds retry via Inngest.

### Reference API calls (use these shapes exactly)

**Extraction call** (no thinking, forced tool):

```typescript
const extraction = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 2048,
  tools: [extractMoneyOrderTool], // strict: true
  tool_choice: { type: "tool", name: "extract_money_order" },
  messages: [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType, // "image/jpeg" | "image/png"
            data: imageBase64,
          },
        },
        {
          type: "text",
          text: "Extract this money order's fields. Use the extract_money_order tool.",
        },
      ],
    },
  ],
});

// Check stop_reason BEFORE looking for tool_use — order matters for error attribution
if (extraction.stop_reason === "refusal") {
  await failJob(jobId, "extraction refused");
  await createInboxItem({ type: "scan_refusal", requestId, ... });
  return;
}
if (extraction.stop_reason === "max_tokens") {
  await failJob(jobId, "extraction truncated at max_tokens");
  return;
}

const extractionBlock = extraction.content.find(
  (b) => b.type === "tool_use" && b.name === "extract_money_order"
);
if (!extractionBlock) {
  await failJob(jobId, "extraction did not return tool_use block");
  return;
}
const extracted = extractionBlock.input;
```

**Reasoning call** (adaptive thinking ON, tool_choice auto, strong prompt):

```typescript
const reasoning = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 8192,
  thinking: { type: "adaptive" },
  output_config: { effort: "xhigh" },
  tools: [decideMatchTool], // strict: true
  tool_choice: { type: "auto" }, // CANNOT force when thinking is on
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "You MUST use the decide_match tool to answer. Do not respond in free text. If no candidate is a strong match, call the tool with chosen_tenant_id = null.",
        },
        {
          type: "text",
          text: JSON.stringify({
            extracted,
            candidates, // array of { id, fullName, unitNumber, monthlyRent, currentBalance, lastPaymentDate }
          }),
        },
      ],
    },
  ],
});

// Check stop_reason BEFORE looking for tool_use — order matters for error attribution
if (reasoning.stop_reason === "refusal") {
  await failJob(jobId, "reasoning refused");
  await createInboxItem({ type: "scan_refusal", requestId, ... });
  return;
}
if (reasoning.stop_reason === "max_tokens") {
  await failJob(jobId, "reasoning truncated at max_tokens — consider raising budget");
  return;
}

const decisionBlock = reasoning.content.find(
  (b) => b.type === "tool_use" && b.name === "decide_match"
);
if (!decisionBlock) {
  // Model responded in text instead of calling the tool. Fail the job.
  await failJob(jobId, "reasoning call did not invoke decide_match tool");
  await createInboxItem({ type: "scan_no_match", requestId, ... });
  return;
}
const decision = decisionBlock.input;
```

Do NOT set `temperature`, `top_p`, or `top_k` anywhere. If the SDK wrapper auto-injects them, strip them.

---

## 8. UI pages

Keep it minimal and clean. Tailwind only. No component library.

### `/` — Review Queue (home)
- Top: a file drop zone. "Drop a money order image here." Accepts PNG/JPEG.
- Below: table of pending ReviewItems.
  - Columns: image thumbnail | extracted payee | amount | suggested tenant | confidence badge | actions
  - Confidence badge: green ≥ 0.85, yellow 0.6–0.84, red < 0.6
  - Actions: Confirm (if auto-match), Change Match (dropdown of all tenants), Reject
- Side panel or footer: **live jobs panel** — shows last 5 jobs with their current step ticking through. Poll `/api/jobs` every 1 second. This is the agentic visibility.

### `/tenants/[id]` — Tenant detail
- Header: name, unit, monthly rent, **current balance** (large)
- Table below: ledger history, most recent first. Columns: date | type | amount | method | memo | request_id (small gray)

### `/inbox` — Exceptions
- Table of open InboxItems. Title, summary, created_at, resolve/dismiss buttons.

No navigation bar needed. Three pages, link between them with plain `<a>` tags.

---

## 9. File structure

```
/app
  /api
    /scan/process/route.ts
    /jobs/route.ts
    /jobs/[id]/route.ts
    /review-queue/route.ts
    /review/[id]/confirm/route.ts
    /review/[id]/reject/route.ts
    /tenants/route.ts
    /tenants/[id]/route.ts
    /inbox/route.ts
    /inbox/[id]/status/route.ts
  /page.tsx                       // review queue + upload
  /tenants/[id]/page.tsx
  /inbox/page.tsx
  /layout.tsx
/lib
  /claude.ts                      // Anthropic client + the two tool definitions
  /worker.ts                      // the state machine from section 7
  /matching.ts                    // alias lookup + fuzzy match
  /prisma.ts                      // singleton Prisma client
/prisma
  /schema.prisma
  /seed.ts
/public                           // nothing for now
```

---

## 10. Environment variables

`.env.local`:
```
ANTHROPIC_API_KEY=
DATABASE_URL=            # Supabase pooled URL (Supavisor transaction mode, port 6543) + ?pgbouncer=true&connection_limit=1
DIRECT_DATABASE_URL=     # Supabase session-pooler URL (port 5432) OR direct connection
```

**CRITICAL — Prisma + Supabase connection string quirks** (these will break the build if missed):

1. **The `?pgbouncer=true` flag on `DATABASE_URL` is required, not optional.** Supavisor transaction mode does not support prepared statements, and Prisma creates them by default. Without the flag, the first runtime query in production throws `prepared statement "s0" does not exist`. **Also add `&connection_limit=1`** — per Supabase's Prisma troubleshooting guide, serverless setups should start with a very low pool size to avoid exhausting Supavisor's connection budget during concurrent invocations. Example: `postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`

2. **`DIRECT_DATABASE_URL` is used for `prisma migrate`** and must NOT use transaction mode. Use either the session pooler (port 5432 on the same pooler hostname) or the direct connection. Note that Supabase direct connections are IPv6-only by default — if your migration environment lacks IPv6, use session-pooler instead.

3. **Map these in `prisma/schema.prisma`:**
   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")
     directUrl = env("DIRECT_DATABASE_URL")
   }
   ```

Add the same three env vars to Vercel Production before deploying.

---

## 11. Build order

Do these in order. Run the app after each step and verify before moving on.

1. Scaffold Next.js, install deps, init Prisma, wire Supabase URLs, run first migration, run seed. **Gate: can see 6 tenants via `/api/tenants`.**
2. Build `/lib/claude.ts` with both tool definitions and a simple `extractMoneyOrder(imageBase64, mediaType)` helper. Test in a throwaway script with a real money order image. **Gate: function returns structured output.**
3. Build `/lib/matching.ts` — alias lookup + fuzzy match. Unit-test with a few hand-coded cases. **Gate: "M LOPEZ" matches "Maria Lopez" in top 3.**
4. Build `/lib/worker.ts` — full state machine. Wire from `/api/scan/process`. **Gate: uploading an image creates a Job, a ReviewItem, and updates them through the steps.**
5. Build `/app/page.tsx` — upload + review queue + live jobs panel. **Gate: drop image, watch job tick through steps, see it appear in queue.**
6. Build `/app/tenants/[id]/page.tsx` and confirm endpoint. **Gate: confirming a review item updates tenant balance and writes an alias.**
7. Build `/app/inbox/page.tsx`. **Gate: low-confidence scan shows up here.**
8. Test with 3 money-order images (clean / blurry / skewed). Verify the confidence actually branches correctly. Iterate the tool descriptions if calibration is off.
9. **Before deploying:** confirm the project's Vercel function duration settings in the dashboard match or exceed the `maxDuration = 60` set on `/api/scan/process`. Defaults vary by plan and by whether Fluid Compute is enabled. If the project's limit is lower, functions will be killed mid-worker and promises in `after()` will be cancelled. Then deploy to Vercel, seed the prod DB, and verify end-to-end on the live URL.

---

## 12. What NOT to build (explicit scope cuts)

- No authentication. No login page. No user model.
- No multi-property filtering in the UI — just show everything.
- No Zelle, no HAP, no SMS, no Cowork, no chatbot. Hackathon extensions.
- No image storage in Dropbox or Supabase Storage — base64 in the DB for now.
- No rate limiting, no Sentry, no audit log — add during hackathon.
- No retries or durable async vendor — `after()`-triggered worker is fine for POC.
- No tests beyond the manual gates in section 11.
- No styling polish beyond clean, readable Tailwind. No dark mode, no animations.

**One operational note (not a build item):** On Supabase Pro, the project does not pause for inactivity, and daily backups with 7-day retention run automatically. If you want finer-grained rollback (seconds of granularity instead of daily snapshots), PITR is available as a paid add-on, but daily backups are sufficient safety for this POC. No keep-alive cron needed. The demo URL will be live whenever the reviewer clicks it.

If in doubt about whether to build something, don't. Ask me.

---

## 13. README requirements

Write a README.md containing:

- **Title:** `terracotta-poc`

- **One-paragraph pitch:** Subsidized housing landlords pay $300+/month for legacy tenant ledger platforms and still spend hours on clerical work — keying in money orders, logging receipts, matching HAP deposits. This is one slice of Terracotta, a system I'm building to replace that work. Claude Opus 4.7 reads the money order, the system finds the tenant, Claude reasons about the match, and a human confirms exceptions. Every correction makes the next scan smarter.

- **Stack line:** Next.js 16+ · TypeScript · Tailwind · Supabase · Prisma · Claude Opus 4.7 · Vercel. Built with Claude Code.

- **The loop:** a 5-line description of the state machine (extracting → matching → reasoning → routing → apply).

- **Why Claude Opus 4.7 section** — IMPORTANT, write this exactly as structured below. These are the model-specific capabilities this project uses. Write it as its own `## Why Claude Opus 4.7` section:

  **Lead paragraph:**
  > Terracotta isn't OCR glued to a database. Opus 4.7 first does high-resolution visual extraction from the money order, then a second adaptive-thinking reasoning pass decides which tenant the payment belongs to — weighing name similarity (including misspellings, initials, married names), amount alignment with rent owed, memo hints like unit numbers, and ledger context like last payment date. The workflow is built around strict tool use and an auditable state machine, so Claude is not just generating text — it's driving an agent loop with structured outputs, confidence-based routing, and human review when uncertainty is high.

  **Then a bulleted list of the specific capabilities used** (keep these as separate bullets, not merged):

  - **Adaptive thinking with `xhigh` effort** on the tenant-matching reasoning step. Adaptive thinking is the only supported thinking mode on Opus 4.7, and `xhigh` is the recommended effort level for agentic work.
  - **Strict tool use (`strict: true`)** on both the extraction and decision tools. Guarantees schema-valid tool inputs via grammar-constrained decoding — no retries, no JSON parsing failures.
  - **High-resolution vision** preserved end-to-end. Opus 4.7 supports up to 2576px images; we deliberately skip downsampling because serial numbers, handwriting, and memo lines depend on fine detail.
  - **Model-specific prompt engineering.** Opus 4.7 follows instructions more literally than 4.6 and is incompatible with forced `tool_choice` when thinking is on. The reasoning call uses `tool_choice: auto` with explicit "you MUST use the decide_match tool" instructions, plus `stop_reason`-first fallback handling for truncation and refusals.
  - **Alias learning loop.** Every human correction writes to a `tenant_aliases` table, so the second scan of a misspelled name auto-routes. The system compounds accuracy over time without schema changes — this is the "gets smarter the more you use it" property, powered by Claude's reasoning plus a lightweight learning surface.
  - **Auditable agent loop.** A `jobs` table with a step state machine (extracting → matching → reasoning → routing), end-to-end `request_id` propagation, and distinct operational categories for `scan_no_match` vs `scan_refusal` vs `scan_low_confidence`. Refusals are handled as a first-class operational signal, not swept under a generic failure bucket.

  **Meta-note line at the end:**
  > Built with Claude Code, for a Claude Code hackathon, to automate work my father still does by hand across his 134-unit Section 8 portfolio.

- **Screenshot or gif** — leave a placeholder for me to drop one in.

- **Run locally:** the three env vars, `npm install`, `npx prisma migrate dev`, `npx prisma db seed`, `npm run dev`.

---

## 14. Done criteria

The POC is done when all of these are true:

- [ ] I can drop a money order image on the home page and watch a Job tick through extracting → matching → reasoning → routing in the live panel.
- [ ] A high-confidence scan lands in the review queue with a suggested tenant.
- [ ] A low-confidence scan lands in the inbox.
- [ ] Confirming a review item updates the tenant's balance and inserts a ledger entry visible on their detail page.
- [ ] Confirming a review item with a *different* tenant than Claude suggested writes a TenantAlias row. Uploading the same-named money order a second time auto-suggests the corrected tenant.
- [ ] Deployed to Vercel at a public URL.
- [ ] README committed with the pitch, stack, and run instructions.

Don't declare done until every box is checked.
