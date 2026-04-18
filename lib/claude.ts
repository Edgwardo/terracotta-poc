import Anthropic from "@anthropic-ai/sdk";

export const MODEL_ID = "claude-opus-4-7";

export const anthropic = new Anthropic();

export type MoneyOrderMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type ExtractedMoneyOrder = {
  payee_name_raw: string | null;
  amount_usd: number | null;
  purchaser_name: string | null;
  purchaser_address: string | null;
  serial_number: string | null;
  issue_date: string | null;
  memo: string | null;
  issuer: "USPS" | "MoneyGram" | "Western Union" | "Other" | "Unknown";
  overall_confidence: number;
  notes: string | null;
};

export type DecideMatchOutput = {
  chosen_tenant_id: string | null;
  match_confidence: number;
  rationale: string;
  alternative_ids: string[];
};

export const extractMoneyOrderTool = {
  name: "extract_money_order",
  description:
    "Extract structured fields from a US money order image. Set field values to null if not legibly present. Set overall_confidence low (< 0.7) if the image is blurry, skewed, or if any field required guessing.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      payee_name_raw: {
        type: ["string", "null"],
        description:
          "The payee name EXACTLY as written, preserving capitalization and abbreviations (e.g. 'M. LOPEZ', 'Maria Lopez', 'LOPES M'). null if unreadable.",
      },
      amount_usd: {
        type: ["number", "null"],
        description: "Dollar amount as a number, e.g. 847.00. null if unreadable.",
      },
      purchaser_name: { type: ["string", "null"] },
      purchaser_address: { type: ["string", "null"] },
      serial_number: { type: ["string", "null"] },
      issue_date: {
        type: ["string", "null"],
        description: "ISO 8601 date if present, e.g. 2026-04-15. null if not present.",
      },
      memo: {
        type: ["string", "null"],
        description:
          "Memo line text — often contains unit number or tenant reference. null if blank.",
      },
      issuer: {
        type: "string",
        enum: ["USPS", "MoneyGram", "Western Union", "Other", "Unknown"],
      },
      overall_confidence: {
        type: "number",
        description:
          "Overall extraction confidence between 0 and 1. Below 0.7 means PM should review.",
      },
      notes: {
        type: ["string", "null"],
        description:
          "Anything unusual about the image — blur, crossouts, ambiguity. null if nothing noteworthy.",
      },
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
      "notes",
    ],
  },
} as const;

export const decideMatchTool = {
  name: "decide_match",
  description:
    "Given extracted money-order fields and a list of candidate tenants from the system, decide which tenant this payment is for. Consider name similarity (including common misspellings, initials, married/maiden names), amount alignment with rent, memo hints (unit number references), and recency of last payment. If no candidate is a strong match, set chosen_tenant_id to null.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chosen_tenant_id: {
        type: ["string", "null"],
        description:
          "UUID of the best-match tenant, or null if no candidate meets the bar.",
      },
      match_confidence: {
        type: "number",
        description:
          "Confidence in the chosen match, between 0 and 1. >= 0.85 = auto-route to review queue. 0.6-0.84 = review queue with warning. < 0.6 = inbox item.",
      },
      rationale: {
        type: "string",
        description:
          "One or two sentences explaining the decision. Reference specific signals used.",
      },
      alternative_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Other tenant ids considered, in descending likelihood. Empty array if no alternatives.",
      },
    },
    required: [
      "chosen_tenant_id",
      "match_confidence",
      "rationale",
      "alternative_ids",
    ],
  },
} as const;

export type ExtractMoneyOrderResult =
  | { kind: "ok"; data: ExtractedMoneyOrder }
  | { kind: "refusal" }
  | { kind: "max_tokens" }
  | { kind: "missing_tool_use" };

export async function extractMoneyOrder(
  imageBase64: string,
  mediaType: MoneyOrderMediaType,
): Promise<ExtractMoneyOrderResult> {
  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 2048,
    tools: [extractMoneyOrderTool as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: "extract_money_order" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
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

  if (response.stop_reason === "refusal") return { kind: "refusal" };
  if (response.stop_reason === "max_tokens") return { kind: "max_tokens" };

  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === "extract_money_order",
  );
  if (!block) return { kind: "missing_tool_use" };

  return { kind: "ok", data: block.input as ExtractedMoneyOrder };
}
