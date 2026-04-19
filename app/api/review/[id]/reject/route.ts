import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { reason?: unknown } = {};
  try {
    const text = await req.text();
    if (text.length > 0) body = JSON.parse(text) as { reason?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  void body;

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

  await prisma.reviewItem.update({
    where: { id },
    data: { status: "rejected", resolvedAt: new Date() },
  });

  return Response.json({ ok: true }, { status: 200 });
}
