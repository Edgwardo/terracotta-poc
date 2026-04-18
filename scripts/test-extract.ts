import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
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

const EXTENSION_MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function main() {
  const argPath = process.argv[2];
  if (!argPath) {
    console.error("Usage: npx tsx scripts/test-extract.ts <path-to-image>");
    process.exit(2);
  }

  const absPath = resolve(argPath);
  const ext = extname(absPath).toLowerCase();
  const mediaType = EXTENSION_MEDIA_TYPES[ext];
  if (!mediaType) {
    console.error(
      `Unsupported image extension '${ext}'. Supported: ${Object.keys(EXTENSION_MEDIA_TYPES).join(", ")}`,
    );
    process.exit(2);
  }

  try {
    await stat(absPath);
  } catch {
    console.error(`File not found: ${absPath}`);
    process.exit(2);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local or export it before running.",
    );
    process.exit(2);
  }

  const { extractMoneyOrder } = await import("../lib/claude");

  const buffer = await readFile(absPath);
  const imageBase64 = buffer.toString("base64");

  console.error(`Sending ${absPath} (${mediaType}, ${buffer.byteLength} bytes)…`);
  const result = await extractMoneyOrder(imageBase64, mediaType);
  console.log(JSON.stringify(result, null, 2));

  if (result.kind !== "ok") process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
