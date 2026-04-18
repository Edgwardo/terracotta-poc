import { prisma } from "./prisma";

export type Candidate = {
  id: string;
  fullName: string;
  unitNumber: string;
  monthlyRent: number;
  currentBalance: number;
  lastPaymentDate: string | null;
  aliasBoost?: boolean;
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev, dp[j], dp[j - 1]) + 1;
      }
      prev = tmp;
    }
  }
  return dp[n];
}

export async function findCandidates(
  purchaserName: string | null,
  amountUsd: number | null,
): Promise<Candidate[]> {
  if (!purchaserName || !purchaserName.trim()) return [];

  const query = purchaserName.trim();

  const aliasHit = await prisma.tenantAlias.findFirst({
    where: {
      aliasText: { equals: query, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    include: {
      tenant: { include: { unit: true } },
    },
  });

  const activeTenants = await prisma.tenant.findMany({
    where: { status: "active" },
    include: { unit: true },
  });

  const queryLower = query.toLowerCase();
  const scored = activeTenants
    .map((t) => ({
      tenant: t,
      distance: levenshtein(queryLower, t.fullName.toLowerCase()),
    }))
    .sort((a, b) => a.distance - b.distance);

  const topByName = scored.slice(0, 3).map((s) => s.tenant);

  const rentMatches =
    amountUsd !== null
      ? activeTenants.filter(
          (t) => Math.abs(Number(t.monthlyRent) - amountUsd) <= 5,
        )
      : [];

  type TenantWithUnit = (typeof activeTenants)[number];
  const ordered: { tenant: TenantWithUnit; aliasBoost: boolean }[] = [];
  const seen = new Set<string>();

  if (aliasHit && aliasHit.tenant.status === "active") {
    ordered.push({ tenant: aliasHit.tenant, aliasBoost: true });
    seen.add(aliasHit.tenant.id);
  }

  for (const t of topByName) {
    if (!seen.has(t.id)) {
      ordered.push({ tenant: t, aliasBoost: false });
      seen.add(t.id);
    }
  }

  for (const t of rentMatches) {
    if (!seen.has(t.id)) {
      ordered.push({ tenant: t, aliasBoost: false });
      seen.add(t.id);
    }
  }

  const capped = ordered.slice(0, 5);
  if (capped.length === 0) return [];

  const tenantIds = capped.map((c) => c.tenant.id);
  const payments = await prisma.ledgerEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      type: "payment",
      status: "active",
    },
    orderBy: { effectiveDate: "desc" },
  });
  const lastPaymentByTenant = new Map<string, Date>();
  for (const p of payments) {
    if (!lastPaymentByTenant.has(p.tenantId)) {
      lastPaymentByTenant.set(p.tenantId, p.effectiveDate);
    }
  }

  return capped.map((c) => {
    const last = lastPaymentByTenant.get(c.tenant.id);
    const candidate: Candidate = {
      id: c.tenant.id,
      fullName: c.tenant.fullName,
      unitNumber: c.tenant.unit.unitNumber,
      monthlyRent: Number(c.tenant.monthlyRent),
      currentBalance: Number(c.tenant.currentBalance),
      lastPaymentDate: last ? last.toISOString().slice(0, 10) : null,
    };
    if (c.aliasBoost) candidate.aliasBoost = true;
    return candidate;
  });
}
