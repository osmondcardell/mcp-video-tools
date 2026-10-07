// VIDEO_UPLOAD_ROOT keeps upload_media inside one folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("files outside VIDEO_UPLOAD_ROOT are refused before any request", async () => {
  const root = await mkdtemp(join(tmpdir(), "uploads-"));
  const outside = join(await mkdtemp(join(tmpdir(), "secret-")), "id_rsa.png");
  await writeFile(outside, "x");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    env: { ...process.env, VIDEO_API_KEY: "k", VIDEO_API_BASE: "http://127.0.0.1:9/v1", VIDEO_UPLOAD_ROOT: root },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answer = new Promise((resolve) => child.stdout.once("data", (d) => resolve(JSON.parse(d))));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "upload_media", arguments: { path: outside, model: "wan-3" } } }) + "\n");
  const res = await answer;
  child.stdin.end();
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /VIDEO_UPLOAD_ROOT/);
});
