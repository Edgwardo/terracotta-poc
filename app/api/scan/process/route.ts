import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { runScanWorker } from "@/lib/worker";
import type { MoneyOrderMediaType } from "@/lib/claude";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { imageBase64, mediaType } = (await req.json()) as {
    imageBase64: string;
    mediaType: MoneyOrderMediaType;
  };
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  const job = await prisma.job.create({
    data: {
      type: "scan_processing",
      status: "queued",
      requestId,
      inputData: { mediaType },
    },
  });

  after(async () => {
    await runScanWorker({ jobId: job.id, imageBase64, mediaType, requestId });
  });

  return Response.json({ jobId: job.id }, { status: 202 });
}
