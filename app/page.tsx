"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEventHandler,
} from "react";

type ReviewItem = {
  id: string;
  jobId: string;
  suggestedTenantId: string | null;
  extractedData: {
    purchaser_name?: string | null;
    payee_name_raw?: string | null;
    amount_usd?: number | null;
    warning?: "low_mid_confidence";
  };
  reasoningData: { match_confidence?: number; rationale?: string };
  imageBase64: string | null;
  mediaType: string | null;
  tenant: { id: string; fullName: string } | null;
  createdAt: string;
};

type Tenant = { id: string; fullName: string };

type Job = {
  id: string;
  status: string;
  step: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-8">
      <h1 className="text-2xl font-semibold">Terracotta</h1>
      <UploadZone onUploadSuccess={bumpRefresh} />
      <ReviewQueue refreshKey={refreshKey} />
      <LiveJobsPanel />
    </main>
  );
}

function UploadZone({ onUploadSuccess }: { onUploadSuccess: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const resolveMediaType = (file: File): string | null => {
    if (file.type === "image/png") return "image/png";
    if (file.type === "image/jpeg" || file.type === "image/jpg")
      return "image/jpeg";
    const name = file.name.toLowerCase();
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    return null;
  };

  const handleFile = async (file: File) => {
    setError(null);
    const mediaType = resolveMediaType(file);
    if (!mediaType) {
      setError("Only PNG and JPEG are accepted.");
      return;
    }
    setBusy(true);
    try {
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string") {
            reject(new Error("Unexpected FileReader result"));
            return;
          }
          const idx = result.indexOf(",");
          resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.onerror = () =>
          reject(reader.error ?? new Error("Read failed"));
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/scan/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64, mediaType }),
      });
      if (!res.ok) {
        setError(`Upload failed: ${res.status}`);
        return;
      }
      onUploadSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop: DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <section>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center ${
          dragOver ? "border-gray-500 bg-gray-50" : "border-gray-300"
        }`}
      >
        <p className="text-sm text-gray-700">Drop a money order image here.</p>
        <p className="mt-1 text-xs text-gray-500">
          PNG or JPEG. Click to browse.
        </p>
        {busy && <p className="mt-2 text-xs text-gray-500">Uploading…</p>}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

function ReviewQueue({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [qRes, tRes] = await Promise.all([
      fetch("/api/review-queue"),
      fetch("/api/tenants"),
    ]);
    const q = (await qRes.json()) as ReviewItem[];
    const tRaw = (await tRes.json()) as Array<{ id: string; fullName: string }>;
    setItems(q);
    setTenants(tRaw.map((x) => ({ id: x.id, fullName: x.fullName })));
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const id = setInterval(() => {
      void load();
    }, 1000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Review queue</h2>
      {items === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No pending items.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-3">Image</th>
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Amount</th>
              <th className="py-2 pr-3">Suggested tenant</th>
              <th className="py-2 pr-3">Confidence</th>
              <th className="py-2 pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <ReviewRow
                key={i.id}
                item={i}
                tenants={tenants}
                onActionError={setActionError}
                onMutate={load}
              />
            ))}
          </tbody>
        </table>
      )}
      {actionError && (
        <p className="mt-2 text-sm text-amber-700">{actionError}</p>
      )}
    </section>
  );
}

function ReviewRow({
  item,
  tenants,
  onActionError,
  onMutate,
}: {
  item: ReviewItem;
  tenants: Tenant[];
  onActionError: (msg: string | null) => void;
  onMutate: () => void;
}) {
  const [chosenId, setChosenId] = useState<string | null>(
    item.suggestedTenantId,
  );
  const [busy, setBusy] = useState(false);

  const extractedName =
    item.extractedData.purchaser_name ??
    item.extractedData.payee_name_raw ??
    "—";
  const amount = item.extractedData.amount_usd;
  const confidence = Number(item.reasoningData.match_confidence ?? 0);
  const warning = item.extractedData.warning === "low_mid_confidence";
  const badgeTone = warning
    ? "bg-yellow-100 text-yellow-800"
    : confidence >= 0.85
      ? "bg-green-100 text-green-800"
      : confidence >= 0.6
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";
  const thumbSrc =
    item.imageBase64 && item.mediaType
      ? `data:${item.mediaType};base64,${item.imageBase64}`
      : null;
  const suggestedTenantName = item.tenant?.fullName ?? "(none)";

  const callAction = async (path: string, body?: object) => {
    setBusy(true);
    onActionError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404) {
        onActionError("Not available yet");
        return;
      }
      if (!res.ok) {
        onActionError(`Action failed: ${res.status}`);
        return;
      }
      onMutate();
    } catch (e) {
      onActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3">
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt="" className="h-16 w-auto rounded border" />
        ) : (
          <span className="text-xs text-gray-400">no image</span>
        )}
      </td>
      <td className="py-2 pr-3">{extractedName}</td>
      <td className="py-2 pr-3">
        {typeof amount === "number" ? `$${amount.toFixed(2)}` : "—"}
      </td>
      <td className="py-2 pr-3">
        {item.tenant ? (
          <a
            href={`/tenants/${item.tenant.id}`}
            className="text-blue-600 underline"
          >
            {suggestedTenantName}
          </a>
        ) : (
          suggestedTenantName
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs ${badgeTone}`}
        >
          {confidence.toFixed(2)}
          {warning ? " ⚠" : ""}
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <select
            className="rounded border px-1 py-0.5 text-xs"
            value={chosenId ?? ""}
            onChange={(e) => setChosenId(e.target.value || null)}
            disabled={busy}
          >
            <option value="">— change match —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </select>
          <button
            className="rounded bg-green-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
            disabled={busy || !chosenId}
            onClick={() =>
              callAction(`/api/review/${item.id}/confirm`, {
                tenantId: chosenId,
              })
            }
          >
            Confirm
          </button>
          <button
            className="rounded bg-red-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => callAction(`/api/review/${item.id}/reject`)}
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  );
}

function LiveJobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/jobs");
        if (!r.ok) return;
        const data = (await r.json()) as Job[];
        if (!cancelled) {
          setJobs(data);
          setNow(Date.now());
        }
      } catch {
        // swallow poll errors
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const last5 = useMemo(
    () =>
      [...jobs]
        .sort(
          (a, b) =>
            new Date(b.enqueuedAt).getTime() -
            new Date(a.enqueuedAt).getTime(),
        )
        .slice(0, 5),
    [jobs],
  );

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Live jobs</h2>
      {last5.length === 0 ? (
        <p className="text-sm text-gray-500">No jobs yet.</p>
      ) : (
        <ul className="space-y-1 text-sm font-mono">
          {last5.map((j) => {
            const startMs = new Date(j.startedAt ?? j.enqueuedAt).getTime();
            const endMs = j.completedAt
              ? new Date(j.completedAt).getTime()
              : now;
            const elapsed = `${Math.max(0, (endMs - startMs) / 1000).toFixed(1)}s`;
            const display = j.step ?? j.status;
            return (
              <li
                key={j.id}
                className="flex items-center justify-between gap-4"
              >
                <span className="text-gray-500">{j.id.slice(0, 8)}</span>
                <span>{display}</span>
                <span className="text-gray-500">{elapsed}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
