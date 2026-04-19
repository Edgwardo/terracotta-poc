import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { status?: unknown };
  try {
    body = (await req.json()) as { status?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const nextStatus = body.status;
  if (nextStatus !== "resolved" && nextStatus !== "dismissed") {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }

  const existing = await prisma.inboxItem.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (existing.status !== "open") {
    return Response.json(
      { error: "not_open", status: existing.status },
      { status: 409 },
    );
  }

  await prisma.inboxItem.update({
    where: { id },
    data: { status: nextStatus, resolvedAt: new Date() },
  });

  return Response.json({ ok: true }, { status: 200 });
}
