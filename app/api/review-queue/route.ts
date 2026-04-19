import { prisma } from "@/lib/prisma";

export async function GET() {
  const items = await prisma.reviewItem.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    include: { tenant: true },
  });

  const jobIds = items.map((i) => i.jobId);
  const jobs = jobIds.length
    ? await prisma.job.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, inputData: true },
      })
    : [];

  const mediaTypeByJobId = new Map<string, string | null>();
  for (const j of jobs) {
    const inputData = j.inputData as { mediaType?: string } | null;
    mediaTypeByJobId.set(j.id, inputData?.mediaType ?? null);
  }

  const payload = items.map((i) => ({
    id: i.id,
    jobId: i.jobId,
    suggestedTenantId: i.suggestedTenantId,
    extractedData: i.extractedData,
    reasoningData: i.reasoningData,
    imageBase64: i.imageBase64,
    requestId: i.requestId,
    status: i.status,
    createdAt: i.createdAt,
    tenant: i.tenant
      ? { id: i.tenant.id, fullName: i.tenant.fullName }
      : null,
    mediaType: mediaTypeByJobId.get(i.jobId) ?? null,
  }));

  return Response.json(payload);
}
