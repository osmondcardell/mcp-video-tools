#!/usr/bin/env node
// mcp-video-tools: a stdio MCP server for asynchronous video generation APIs
// (POST /videos/generations -> GET /videos/{request_id} -> GET /videos/{request_id}/content).
//
// Zero dependencies, Node 18+. Speaks both MCP eras:
//   - legacy clients: initialize / notifications/initialized / ping (2024-11-05 ... 2025-11-25)
//   - modern clients: server/discover and per-request _meta (2026-07-28)
//
//   VIDEO_API_KEY=... node server.mjs

import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_INFO = { name: "mcp-video-tools", version: "1.0.0" };
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

const env = process.env;
const API_BASE = (env.VIDEO_API_BASE || "https://argolink.io/v1").replace(/\/+$/, "");
const CATALOG_URL = env.VIDEO_CATALOG_URL || "https://argolink.io/api/catalog/v1/models?category=video&page_size=100";
const OUTPUT_DIR = resolve(env.VIDEO_OUTPUT_DIR || "videos");
const UPLOAD_ROOT = env.VIDEO_UPLOAD_ROOT ? resolve(env.VIDEO_UPLOAD_ROOT) : null;
const TIMEOUT_MS = Number(env.VIDEO_HTTP_TIMEOUT_MS || 120_000);

const INSTRUCTIONS =
  "Video generation is asynchronous. Call list_video_models to pick a model and see its limits and per-second " +
  "prices, submit_video once, then call get_video_status every 10-15 seconds until status is done, failed or " +
  "expired, then download_video. Never resubmit a job that already has a request_id; a failed job is not billed. " +
  "Local files must go through upload_media first; every asset in submit_video is an https URL.";

const MEDIA = {
  ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"], ".png": ["image", "image/png"],
  ".webp": ["image", "image/webp"], ".mp4": ["video", "video/mp4"], ".mov": ["video", "video/quicktime"],
  ".webm": ["video", "video/webm"], ".mp3": ["audio", "audio/mpeg"], ".wav": ["audio", "audio/wav"],
  ".m4a": ["audio", "audio/mp4"], ".aac": ["audio", "audio/aac"],
};

const urlList = { type: "array", items: { type: "string", format: "uri" } };

export const TOOLS = [
  {
    name: "list_video_models",
    title: "List video models",
    description: "Live list of video model IDs with providers, modes, duration ranges, aspect ratios, " +
      "resolution tiers and price per second. No API key needed.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "submit_video",
    title: "Submit a video job",
    description: "Start ONE video job and return its request_id (billing happens only if it finishes). Only " +
      "model and prompt are required. Frames (start_image/end_image) and reference lists cannot be mixed. " +
      "Name references in the prompt as @Image 1, @Video 1, @Audio 1. Reference video seconds are billed.",
    inputSchema: {
      type: "object",
      required: ["model", "prompt"],
      properties: {
        model: { type: "string", description: "e.g. seedance-2.5, minimax-h3, wan-3, wan-3-prime" },
        prompt: { type: "string" },
        duration: { type: "integer", description: "whole seconds; range depends on the model" },
        resolution: { type: "string", description: "tier label such as 480p, 720p, 1080p, 768p, 2k, 4k" },
        aspect_ratio: { type: "string", description: "21:9, 16:9, 4:3, 1:1, 3:4, 9:16 or adaptive, per model" },
        start_image: { type: "string", format: "uri" },
        end_image: { type: "string", format: "uri" },
        reference_images: urlList,
        reference_videos: urlList,
        reference_audios: urlList,
        generate_audio: { type: "boolean", description: "false for silence, where the model allows it" },
        seed: { type: "integer", description: "only on models that accept one" },
        omni_reference_task_type: { type: "string", enum: ["edit"], description: "edit reference_videos[0], where supported" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_video_status",
    title: "Check a video job",
    description: "One status read: pending (progress 0-99, estimated_seconds_remaining), done (video.url, usage " +
      "with billed_seconds), failed (error.code, error.retryable) or expired.",
    inputSchema: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "download_video",
    title: "Download a finished video",
    description: "Save a done job's MP4 into the server's output folder and return the local path.",
    inputSchema: {
      type: "object",
      required: ["request_id"],
      properties: {
        request_id: { type: "string" },
        filename: { type: "string", description: "optional file name (no folders); default <request_id>.mp4" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "upload_media",
    title: "Upload a local file",
    description: "Upload a local image, video or audio file and return an https media_url (valid seven days) " +
      "to use in submit_video. Uploading is free.",
    inputSchema: {
      type: "object",
      required: ["path", "model"],
      properties: {
        path: { type: "string", description: "local file path" },
        model: { type: "string", description: "the model the file is for" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

class ToolFailure extends Error {}

function needKey() {
  if (!env.VIDEO_API_KEY) throw new ToolFailure("VIDEO_API_KEY is not set in the MCP server's environment");
  return { Authorization: `Bearer ${env.VIDEO_API_KEY}` };
}

async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { ...needKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { const e = JSON.parse(text).error; if (e) detail = [e.code, e.message].filter(Boolean).join(": "); } catch {}
    throw new ToolFailure(`${method} ${path} returned HTTP ${res.status}${detail ? ` (${detail.slice(0, 300)})` : ""}`);
  }
  return res;
}

function summarize(item) {
  const modes = item.video?.modes ?? [];
  const durations = modes.filter((m) => m.min_duration).map((m) => [m.min_duration, m.max_duration]);
  const ratios = [...new Set(modes.flatMap((m) => m.aspect_ratios ?? []))];
  const eff = item.pricing?.effective;
  return {
    id: item.id,
    name: item.display_name,
    provider: item.provider_id,
    modes: modes.map((m) => m.mode),
    duration_seconds: durations.length
      ? [Math.min(...durations.map((d) => d[0])), Math.max(...durations.map((d) => d[1]))] : null,
    aspect_ratios: ratios,
    default_resolution: item.video?.default_resolution ?? null,
    usd_per_second: Object.fromEntries((eff?.tiers ?? []).map((t) => [t.label, t.price])),
    note: item.note?.en ?? item.summary?.en ?? "",
  };
}

const handlers = {
  async list_video_models() {
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return { source: CATALOG_URL, models: (data.items ?? []).map(summarize) };
    } catch (error) {
      // Fallback: the OpenAI-shaped list has IDs only (no categories or prices).
      const res = await fetch(`${API_BASE}/models`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new ToolFailure(`catalog unavailable (${error.message}) and /models returned HTTP ${res.status}`);
      const data = await res.json();
      return { source: `${API_BASE}/models`, note: "catalog unavailable; IDs only, all categories",
        models: (data.data ?? []).map((m) => ({ id: m.id, provider: m.owned_by })) };
    }
  },

  async submit_video(args) {
    if (!args.model || !args.prompt) throw new ToolFailure("model and prompt are required");
    const frames = args.start_image || args.end_image;
    const refs = ["reference_images", "reference_videos", "reference_audios"].some((k) => args[k]?.length);
    if (frames && refs) throw new ToolFailure("start_image/end_image cannot be combined with reference lists");
    if (args.end_image && !args.start_image) throw new ToolFailure("end_image needs start_image");
    const body = { model: args.model, prompt: args.prompt };
    for (const key of ["duration", "resolution", "aspect_ratio", "generate_audio", "seed", "omni_reference_task_type"]) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    for (const key of ["start_image", "end_image"]) if (args[key]) body[key] = { url: args[key] };
    for (const key of ["reference_images", "reference_videos", "reference_audios"]) {
      if (args[key]?.length) body[key] = args[key].map((url) => ({ url }));
    }
    const all = [body.start_image?.url, body.end_image?.url,
      ...["reference_images", "reference_videos", "reference_audios"].flatMap((k) => (body[k] ?? []).map((a) => a.url))];
    const bad = all.filter((u) => u && !u.startsWith("https://"));
    if (bad.length) throw new ToolFailure(`assets must be https URLs; upload local files with upload_media first: ${bad.join(", ")}`);
    const job = await (await api("POST", "/videos/generations", body)).json();
    return { request_id: job.request_id, next: "poll get_video_status every 10-15 s" };
  },

  async get_video_status({ request_id }) {
    if (!request_id || request_id.includes("/")) throw new ToolFailure("a request_id without '/' is required");
    return (await api("GET", `/videos/${encodeURIComponent(request_id)}`)).json();
  },

  async download_video({ request_id, filename }) {
    if (!request_id || request_id.includes("/")) throw new ToolFailure("a request_id without '/' is required");
    const name = basename(filename || `${request_id}.mp4`);
    const res = await api("GET", `/videos/${encodeURIComponent(request_id)}/content`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, name);
    await writeFile(path, bytes);
    return { path, bytes: bytes.length };
  },

  async upload_media({ path, model }) {
    if (UPLOAD_ROOT && !resolve(path ?? "").startsWith(UPLOAD_ROOT + sep)) {
      throw new ToolFailure(`only files under ${UPLOAD_ROOT} may be uploaded (VIDEO_UPLOAD_ROOT)`);
    }
    const kind = MEDIA[extname(path ?? "").toLowerCase()];
    if (!kind) throw new ToolFailure(`unsupported file type ${extname(path ?? "") || "(none)"}`);
    const [type, contentType] = kind;
    const size = (await stat(path)).size;
    const ticket = await (await api("POST", "/media/uploads", { model, type, content_type: contentType, size_bytes: size })).json();
    const put = await fetch(ticket.upload_url, { method: "PUT", headers: { "Content-Type": contentType },
      body: await readFile(path), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!put.ok) throw new ToolFailure(`upload PUT returned HTTP ${put.status}`);
    return { media_url: ticket.media_url, type, content_type: contentType, size_bytes: size };
  },
};

// ---------------------------------------------------------------- JSON-RPC

const modernMeta = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };

function result(id, value, modern) {
  return { jsonrpc: "2.0", id, result: { ...value, resultType: "complete", ...(modern ? { _meta: modernMeta } : {}) } };
}

function failure(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export async function handle(message) {
  const { id, method, params = {} } = message ?? {};
  if (typeof method !== "string") return id === undefined ? null : failure(id ?? null, -32600, "Invalid Request");
  if (id === undefined) return null; // notifications (initialized, cancelled, ...) need no reply
  const requested = params._meta?.[VERSION_KEY];
  const modern = requested !== undefined;
  if (modern && !MODERN.includes(requested) && !LEGACY.includes(requested)) {
    return failure(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested });
  }
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = LEGACY.includes(asked) ? asked : LEGACY[0];
      return result(id, { protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, false);
    }
    case "server/discover":
      return result(id, { supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: {} },
        instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public" }, true);
    case "ping":
      return result(id, {}, modern);
    case "tools/list":
      return result(id, { tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" }, modern);
    case "tools/call": {
      const handler = handlers[params.name];
      if (!handler) return failure(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const value = await handler(params.arguments ?? {});
        return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value, isError: false }, modern);
      } catch (error) {
        const text = error instanceof ToolFailure ? error.message : `unexpected error: ${error.message}`;
        return result(id, { content: [{ type: "text", text }], isError: true }, modern);
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

function send(reply) {
  if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
}

function launchedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send(failure(null, -32700, "Parse error"));
      return;
    }
    const work = handle(message).then(send, (error) => {
      console.error(error);
      if (message?.id !== undefined) send(failure(message.id, -32603, "Internal error"));
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  lines.on("close", async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
  console.error(`mcp-video-tools ready (API ${API_BASE}, output ${OUTPUT_DIR})`);
}
