// End-to-end: spawn server.mjs over stdio and point it at a local mock of the video API.
// Run with: node --test test/
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const seen = [];
let mock, child, outDir, base;

const catalog = {
  items: [{
    id: "minimax-h3", display_name: "MiniMax H3", provider_id: "minimax",
    note: { en: "4–15 seconds; 768p or 2k" },
    video: { default_resolution: "768p", modes: [
      { mode: "text", min_duration: 4, max_duration: 15, aspect_ratios: ["16:9", "9:16"] },
      { mode: "start_image", min_duration: 4, max_duration: 15, aspect_ratios: ["adaptive"] }] },
    pricing: { effective: { tiers: [{ label: "768p", price: 0.039 }, { label: "2k", price: 0.064 }] } },
  }],
};

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

before(async () => {
  outDir = await mkdtemp(join(tmpdir(), "mcp-video-"));
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], raw });
      if (req.url === "/catalog") return reply(res, 200, catalog);
      if (req.url === "/v1/videos/generations") {
        const body = JSON.parse(raw);
        if (body.resolution === "720p") {
          return reply(res, 400, { error: { type: "invalid_request_error", code: "request_unsupported",
            message: "minimax-h3 does not support video resolution 720p" } });
        }
        return reply(res, 202, { request_id: "job-7" });
      }
      if (req.url === "/v1/videos/job-7") {
        return reply(res, 200, { request_id: "job-7", status: "done", progress: 100,
          usage: { output_seconds: 5, reference_video_seconds: 0, billed_seconds: 5 } });
      }
      if (req.url === "/v1/videos/job-7/content") return reply(res, 200, Buffer.from("MP4-BYTES"), "video/mp4");
      if (req.url === "/v1/videos/job-8/content") {
        return reply(res, 409, { error: { code: "job_video_not_ready", message: "not finished" } });
      }
      if (req.url === "/v1/media/uploads") {
        return reply(res, 200, { upload_url: `${base}/put/abc`, media_url: "https://media.test/abc.png" });
      }
      if (req.url === "/put/abc") return reply(res, 200, "");
      reply(res, 404, { error: { code: "not_found" } });
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, VIDEO_API_KEY: "test-key", VIDEO_API_BASE: `${base}/v1`,
      VIDEO_CATALOG_URL: `${base}/catalog`, VIDEO_OUTPUT_DIR: outDir },
    stdio: ["pipe", "pipe", "ignore"],
  });
});

after(() => {
  child.stdin.end();
  mock.close();
});

let nextId = 1;
const waiting = new Map();
let buffer = "";
function listen() {
  if (listen.on) return;
  listen.on = true;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be a JSON-RPC message
      waiting.get(msg.id)?.(msg);
    }
  });
}

function rpc(method, params, meta) {
  listen();
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, params: { ...params, ...(meta ? { _meta: meta } : {}) } };
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify(message) + "\n");
  });
}

const call = (name, args) => rpc("tools/call", { name, arguments: args });

test("legacy clients get an initialize handshake", async () => {
  const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.serverInfo, { name: "mcp-video-tools", version: "1.0.0" });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const pong = await rpc("ping", {});
  assert.deepEqual(pong.result.resultType, "complete");
});

test("modern clients can discover the server and are served per request", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const found = await rpc("server/discover", {}, meta);
  assert.equal(found.result.supportedVersions[0], "2026-07-28");
  assert.equal(found.result._meta["io.modelcontextprotocol/serverInfo"].name, "mcp-video-tools");
  const listed = await rpc("tools/list", {}, meta);
  assert.deepEqual(listed.result.tools.map((t) => t.name),
    ["list_video_models", "submit_video", "get_video_status", "download_video", "upload_media"]);
  assert.equal(listed.result.cacheScope, "public");
  const wrong = await rpc("tools/list", {}, { "io.modelcontextprotocol/protocolVersion": "1999-01-01" });
  assert.equal(wrong.error.code, -32022);
});

test("list_video_models summarizes the live catalog", async () => {
  const res = await call("list_video_models", {});
  const [model] = res.result.structuredContent.models;
  assert.equal(model.id, "minimax-h3");
  assert.deepEqual(model.duration_seconds, [4, 15]);
  assert.deepEqual(model.usd_per_second, { "768p": 0.039, "2k": 0.064 });
});

test("submit_video forwards the body with the bearer key", async () => {
  const res = await call("submit_video", { model: "minimax-h3", prompt: "@Image 1 waves", duration: 5,
    resolution: "768p", reference_images: ["https://a.test/me.png"] });
  assert.equal(res.result.isError, false);
  assert.equal(res.result.structuredContent.request_id, "job-7");
  const sent = seen.find((s) => s.url === "/v1/videos/generations");
  assert.equal(sent.auth, "Bearer test-key");
  assert.deepEqual(JSON.parse(sent.raw).reference_images, [{ url: "https://a.test/me.png" }]);
});

test("API refusals and bad input come back as tool errors the model can read", async () => {
  const refused = await call("submit_video", { model: "minimax-h3", prompt: "x", resolution: "720p" });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /HTTP 400 \(request_unsupported: minimax-h3 does not support/);
  const local = await call("submit_video", { model: "wan-3", prompt: "x", reference_images: ["./me.png"] });
  assert.match(local.result.content[0].text, /upload_media/);
  const mixed = await call("submit_video", { model: "wan-3", prompt: "x", start_image: "https://a.test/1.png",
    reference_videos: ["https://a.test/v.mp4"] });
  assert.match(mixed.result.content[0].text, /cannot be combined/);
  const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknown.error.code, -32602);
});

test("status and download", async () => {
  const status = await call("get_video_status", { request_id: "job-7" });
  assert.equal(status.result.structuredContent.usage.billed_seconds, 5);
  const saved = await call("download_video", { request_id: "job-7", filename: "../../escape.mp4" });
  assert.equal(saved.result.structuredContent.path, join(outDir, "escape.mp4"));
  assert.equal(await readFile(join(outDir, "escape.mp4"), "utf8"), "MP4-BYTES");
  const early = await call("download_video", { request_id: "job-8" });
  assert.match(early.result.content[0].text, /409 \(job_video_not_ready/);
});

test("upload_media gets a ticket and PUTs the bytes with the declared type", async () => {
  const file = join(outDir, "ref.png");
  await writeFile(file, Buffer.from("PNGDATA"));
  const res = await call("upload_media", { path: file, model: "seedance-2.5" });
  assert.equal(res.result.structuredContent.media_url, "https://media.test/abc.png");
  const ticket = seen.find((s) => s.url === "/v1/media/uploads");
  assert.deepEqual(JSON.parse(ticket.raw), { model: "seedance-2.5", type: "image", content_type: "image/png", size_bytes: 7 });
  const put = seen.find((s) => s.url === "/put/abc");
  assert.equal(put.type, "image/png");
  assert.equal(put.auth, undefined);
});
