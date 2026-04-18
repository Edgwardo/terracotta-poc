import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

async function main() {
  const purchaserName = process.argv[2];
  const amountArg = process.argv[3];

  if (!purchaserName) {
    console.error(
      'Usage: npx tsx scripts/test-match.ts "<purchaser name>" [amount]',
    );
    process.exit(2);
  }

  let amountUsd: number | null = null;
  if (amountArg !== undefined) {
    const parsed = Number(amountArg);
    if (!Number.isFinite(parsed)) {
      console.error(`Invalid amount: ${amountArg}`);
      process.exit(2);
    }
    amountUsd = parsed;
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Add it to .env.local.");
    process.exit(2);
  }

  const { findCandidates } = await import("../lib/matching");
  const { prisma } = await import("../lib/prisma");

  try {
    console.error(
      `Query: purchaserName=${JSON.stringify(purchaserName)} amountUsd=${amountUsd}`,
    );
    const result = await findCandidates(purchaserName, amountUsd);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
