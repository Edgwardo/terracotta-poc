"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function InboxActions({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (status: "resolved" | "dismissed") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.status === 404) {
        setError("Item not found");
        return;
      }
      if (res.status === 409) {
        setError("Item no longer open");
        return;
      }
      if (!res.ok) {
        setError(`Action failed: ${res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || isPending;

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-2">
        <button
          className="rounded bg-green-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
          disabled={disabled}
          onClick={() => void act("resolved")}
        >
          Resolve
        </button>
        <button
          className="rounded bg-gray-500 px-2 py-0.5 text-xs text-white disabled:opacity-50"
          disabled={disabled}
          onClick={() => void act("dismissed")}
        >
          Dismiss
        </button>
      </div>
      {error && <span className="text-xs text-amber-700">{error}</span>}
    </div>
  );
}
