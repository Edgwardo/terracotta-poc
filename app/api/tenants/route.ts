import { prisma } from "@/lib/prisma";

export async function GET() {
  const tenants = await prisma.tenant.findMany({
    include: { unit: { include: { property: true } } },
    orderBy: { fullName: "asc" },
  });
  return Response.json(tenants);
}
