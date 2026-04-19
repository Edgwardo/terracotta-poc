import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL_ID, decideMatchTool, extractMoneyOrder } from "./claude";
import type {
  DecideMatchOutput,
  ExtractedMoneyOrder,
  MoneyOrderMediaType,
} from "./claude";
import { findCandidates } from "./matching";
import type { Candidate } from "./matching";
import { prisma } from "./prisma";

type RunScanWorkerArgs = {
  jobId: string;
  imageBase64: string;
  mediaType: MoneyOrderMediaType;
  requestId: string;
};

export async function runScanWorker(args: RunScanWorkerArgs): Promise<void> {
  const { jobId, imageBase64, mediaType, requestId } = args;

  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "running", startedAt: new Date(), step: "extracting" },
    });

    // Step 2 — EXTRACT
    const extraction = await extractMoneyOrder(imageBase64, mediaType);

    if (extraction.kind === "refusal") {
      await failJob(jobId, "extraction refused");
      await prisma.inboxItem.create({
        data: {
          type: "scan_refusal",
          severity: "high",
          title: "Money order scan refused during extraction",
          summary:
            "Claude declined to extract fields from the uploaded money order image.",
          data: { stage: "extraction", jobId },
          requestId,
        },
      });
      return;
    }
    if (extraction.kind === "max_tokens") {
      await failJob(jobId, "extraction truncated at max_tokens");
      return;
    }
    if (extraction.kind === "missing_tool_use") {
      await failJob(jobId, "extraction did not return tool_use block");
      return;
    }

    const extracted: ExtractedMoneyOrder = extraction.data;

    await prisma.job.update({
      where: { id: jobId },
      data: {
        step: "matching",
        outputData: { extraction: extracted } as object,
      },
    });

    // Step 3 — MATCH (purchaser_name, per Phase 3 clarification)
    const candidates: Candidate[] = await findCandidates(
      extracted.purchaser_name,
      extracted.amount_usd,
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        step: "reasoning",
        outputData: {
          extraction: extracted,
          candidates,
        } as object,
      },
    });

    // Step 4 — REASON
    const reasoning = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      tools: [decideMatchTool as unknown as Anthropic.Tool],
      tool_choice: { type: "auto" },
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
              text: JSON.stringify({ extracted, candidates }),
            },
          ],
        },
      ],
    });

    if (reasoning.stop_reason === "refusal") {
      await failJob(jobId, "reasoning refused");
      await prisma.inboxItem.create({
        data: {
          type: "scan_refusal",
          severity: "high",
          title: "Money order scan refused during reasoning",
          summary:
            "Claude declined to decide a match for the extracted money-order fields.",
          data: { stage: "reasoning", jobId, extracted, candidates },
          requestId,
        },
      });
      return;
    }
    if (reasoning.stop_reason === "max_tokens") {
      await failJob(
        jobId,
        "reasoning truncated at max_tokens (consider raising budget)",
      );
      return;
    }

    const decisionBlock = reasoning.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "decide_match",
    );
    if (!decisionBlock) {
      await failJob(jobId, "reasoning call did not invoke decide_match tool");
      await prisma.inboxItem.create({
        data: {
          type: "scan_no_match",
          severity: "medium",
          title: "Reasoning call did not invoke decide_match",
          summary:
            "The reasoning model returned a text response instead of calling the decide_match tool.",
          data: { stage: "reasoning", jobId, extracted, candidates },
          requestId,
        },
      });
      return;
    }

    const decision = decisionBlock.input as DecideMatchOutput;

    await prisma.job.update({
      where: { id: jobId },
      data: {
        step: "routing",
        outputData: {
          extraction: extracted,
          candidates,
          decision,
        } as object,
      },
    });

    // Step 5 — ROUTE
    const chosenId = decision.chosen_tenant_id;
    const confidence = decision.match_confidence;
    const displayPayee =
      extracted.purchaser_name ?? extracted.payee_name_raw ?? "(unknown)";
    const displayAmount =
      extracted.amount_usd !== null ? `$${extracted.amount_usd}` : "(unknown)";

    if (chosenId === null) {
      await prisma.inboxItem.create({
        data: {
          type: "scan_no_match",
          severity: "medium",
          title: `No match for money order from ${displayPayee}`,
          summary: `Amount ${displayAmount}. Reasoning confidence ${confidence.toFixed(
            2,
          )}. ${decision.rationale}`,
          data: { jobId, extracted, candidates, decision, imageBase64 },
          requestId,
        },
      });
    } else if (confidence >= 0.85) {
      await prisma.reviewItem.create({
        data: {
          jobId,
          suggestedTenantId: chosenId,
          extractedData: extracted as unknown as object,
          reasoningData: decision as unknown as object,
          imageBase64,
          requestId,
          status: "pending",
        },
      });
    } else if (confidence >= 0.6) {
      await prisma.reviewItem.create({
        data: {
          jobId,
          suggestedTenantId: chosenId,
          extractedData: {
            ...(extracted as unknown as Record<string, unknown>),
            warning: "low_mid_confidence",
          },
          reasoningData: decision as unknown as object,
          imageBase64,
          requestId,
          status: "pending",
        },
      });
    } else {
      await prisma.inboxItem.create({
        data: {
          type: "scan_low_confidence",
          severity: "medium",
          title: `Low-confidence match for money order from ${displayPayee}`,
          summary: `Amount ${displayAmount}. Reasoning confidence ${confidence.toFixed(
            2,
          )}. ${decision.rationale}`,
          data: { jobId, extracted, candidates, decision, imageBase64 },
          requestId,
        },
      });
    }

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "completed",
        step: null,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(jobId, `worker error: ${message}`);
    await prisma.inboxItem
      .create({
        data: {
          type: "scan_no_match",
          severity: "high",
          title: "Scan worker error",
          summary: message,
          data: { jobId },
          requestId,
        },
      })
      .catch(() => {});
  }
}

async function failJob(jobId: string, error: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "failed",
      step: null,
      error,
      completedAt: new Date(),
    },
  });
}
