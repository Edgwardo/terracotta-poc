import { prisma } from "@/lib/prisma";

export default async function TenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: { unit: { include: { property: true } } },
  });

  if (!tenant) {
    return (
      <main className="mx-auto max-w-4xl p-6 space-y-4">
        <a href="/" className="text-sm text-blue-600 underline">
          ← Back
        </a>
        <p className="text-sm text-gray-600">Tenant not found.</p>
      </main>
    );
  }

  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: id, status: "active" },
    orderBy: { effectiveDate: "desc" },
  });

  const rent = Number(tenant.monthlyRent).toFixed(2);
  const balance = Number(tenant.currentBalance).toFixed(2);
  const unitLine = `${tenant.unit.property.name} · Unit ${tenant.unit.unitNumber}`;

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <a href="/" className="text-sm text-blue-600 underline">
        ← Back
      </a>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{tenant.fullName}</h1>
        <p className="text-sm text-gray-600">{unitLine}</p>
        <p className="text-sm text-gray-600">Monthly rent: ${rent}</p>
        <p className="mt-2 text-4xl font-semibold">${balance}</p>
        <p className="text-xs uppercase tracking-wide text-gray-500">
          Current balance
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-2">Ledger</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-500">No payments yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3">Memo</th>
                <th className="py-2 pr-3">Request</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    {e.effectiveDate.toISOString().slice(0, 10)}
                  </td>
                  <td className="py-2 pr-3">{e.type}</td>
                  <td className="py-2 pr-3">
                    ${Number(e.amount).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3">{e.paymentMethod ?? "—"}</td>
                  <td className="py-2 pr-3">{e.memo ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-gray-500">
                    {e.requestId.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
