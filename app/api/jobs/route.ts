import { prisma } from "@/lib/prisma";

export async function GET() {
  const jobs = await prisma.job.findMany({
    orderBy: { enqueuedAt: "desc" },
    take: 20,
  });
  return Response.json(jobs);
}
