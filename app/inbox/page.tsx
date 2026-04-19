import { prisma } from "@/lib/prisma";
import { InboxActions } from "./InboxActions";

export const dynamic = "force-dynamic";

const TYPE_BADGE: Record<string, string> = {
  scan_no_match: "bg-gray-200 text-gray-800",
  scan_low_confidence: "bg-yellow-100 text-yellow-800",
  scan_refusal: "bg-red-100 text-red-800",
};

function typeBadgeTone(type: string): string {
  return TYPE_BADGE[type] ?? "bg-gray-100 text-gray-700";
}

export default async function InboxPage() {
  const items = await prisma.inboxItem.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <a href="/" className="text-sm text-blue-600 underline">
        ← Back
      </a>
      <header>
        <h1 className="text-2xl font-semibold">Inbox</h1>
      </header>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">Inbox is clear.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Severity</th>
              <th className="py-2 pr-3">Title</th>
              <th className="py-2 pr-3">Summary</th>
              <th className="py-2 pr-3">Created</th>
              <th className="py-2 pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b align-top">
                <td className="py-2 pr-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs ${typeBadgeTone(
                      i.type,
                    )}`}
                  >
                    {i.type}
                  </span>
                </td>
                <td className="py-2 pr-3">{i.severity}</td>
                <td className="py-2 pr-3 font-medium">{i.title}</td>
                <td className="py-2 pr-3">
                  <div className="space-y-1">
                    <p>{i.summary}</p>
                    <details className="text-xs text-gray-500">
                      <summary className="cursor-pointer select-none">
                        Show raw data
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all font-mono">
                        {JSON.stringify(i.data, null, 2)}
                      </pre>
                    </details>
                  </div>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-gray-600">
                  {i.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                </td>
                <td className="py-2 pr-3">
                  <InboxActions id={i.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
