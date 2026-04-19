import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ExtractedMoneyOrder } from "@/lib/claude";
import type { DecideMatchOutput } from "@/lib/claude";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { tenantId?: unknown };
  try {
    body = (await req.json()) as { tenantId?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const tenantId = body.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return Response.json({ error: "tenantId_required" }, { status: 400 });
  }

  const existing = await prisma.reviewItem.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (existing.status !== "pending") {
    return Response.json(
      { error: "not_pending", status: existing.status },
      { status: 409 },
    );
  }

  const confirmedTenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });
  if (!confirmedTenant) {
    return Response.json({ error: "tenant_not_found" }, { status: 400 });
  }

  const extracted = existing.extractedData as unknown as ExtractedMoneyOrder & {
    warning?: string;
  };
  const reasoning = existing.reasoningData as unknown as DecideMatchOutput;
  const amountUsd = extracted.amount_usd;
  if (amountUsd === null || typeof amountUsd !== "number") {
    return Response.json({ error: "amount_missing" }, { status: 400 });
  }
  const amount = new Prisma.Decimal(amountUsd);
  const aliasText = extracted.purchaser_name ?? extracted.payee_name_raw;
  const isCorrection = tenantId !== reasoning.chosen_tenant_id;
  const shouldWriteAlias = isCorrection && !!aliasText;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const fresh = await tx.reviewItem.findUnique({ where: { id } });
      if (!fresh) throw new ConfirmAbort("not_found", 404);
      if (fresh.status !== "pending") {
        throw new ConfirmAbort("not_pending", 409, { status: fresh.status });
      }

      const ledger = await tx.ledgerEntry.create({
        data: {
          tenantId,
          effectiveDate: new Date(),
          amount,
          type: "payment",
          category: "rent",
          paymentMethod: "money_order",
          source: "money_order_scan",
          memo: extracted.memo ?? null,
          requestId: existing.requestId,
          postedBy: "system",
          status: "active",
        },
      });

      await tx.tenant.update({
        where: { id: tenantId },
        data: { currentBalance: { decrement: amount } },
      });

      let aliasCreated = false;
      if (shouldWriteAlias && aliasText) {
        await tx.tenantAlias.create({
          data: {
            aliasText,
            tenantId,
            source: "scan",
            confidence: 1.0,
            requestId: existing.requestId,
          },
        });
        aliasCreated = true;
      }

      await tx.reviewItem.update({
        where: { id },
        data: {
          status: "confirmed",
          resolvedAt: new Date(),
          imageBase64: null,
        },
      });

      return { ledgerEntryId: ledger.id, aliasCreated };
    });

    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    if (err instanceof ConfirmAbort) {
      return Response.json(
        { error: err.code, ...(err.extra ?? {}) },
        { status: err.status },
      );
    }
    throw err;
  }
}

class ConfirmAbort extends Error {
  code: string;
  status: number;
  extra?: Record<string, unknown>;
  constructor(code: string, status: number, extra?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
