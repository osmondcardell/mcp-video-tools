# MCP Video Tools — text-to-video and image-to-video as MCP tools

A zero-dependency Node.js MCP server that lets Claude Code, Cursor, Codex or any MCP client list video models, start a generation job, poll it, download the MP4 and upload local reference files, against any API that uses the async `/v1/videos` protocol. It defaults to [ArgoLink](https://argolink.io/gh-mcp-video-tools), whose public catalog supplies each model's limits and per-second price.

[Tools](#tools) · [Install](#install) · [Configure your client](#configure-your-client) · [Models and prices](#models-and-prices) · [Protocol support](#protocol-support) · [FAQ](#faq)

<sub>Last checked: 2026-10-07. Model limits and prices below come from the live catalog on that date.</sub>

## Tools

| Tool | HTTP call | Returns |
|---|---|---|
| `list_video_models` | `GET` public catalog (no key) | id, provider, modes, duration range, aspect ratios, `usd_per_second` per tier |
| `submit_video` | `POST /v1/videos/generations` | `request_id` |
| `get_video_status` | `GET /v1/videos/{request_id}` | `pending` (progress 0–99, `estimated_seconds_remaining`), `done` (`video.url`, `usage.billed_seconds`), `failed` (`error.code`, `error.retryable`) or `expired` |
| `download_video` | `GET /v1/videos/{request_id}/content` | local path and size of the saved MP4 |
| `upload_media` | `POST /v1/media/uploads`, then `PUT` to the signed URL | an `https` `media_url` (valid seven days) for frames and references |

The server never waits for a video to finish. A clip takes minutes, so the agent submits once, checks the status every 10–15 seconds and downloads when it is `done`; the server's instructions tell it so, and tell it never to resubmit a job that already has a `request_id`.

`submit_video` accepts `model`, `prompt`, `duration`, `resolution`, `aspect_ratio`, `start_image`, `end_image`, `reference_images`, `reference_videos`, `reference_audios`, `generate_audio`, `seed` and `omni_reference_task_type`. It refuses locally what can never work (frames mixed with references, `end_image` without `start_image`, non-HTTPS assets) and passes everything else to the API, whose refusal comes back as a readable tool error such as `HTTP 400 (request_unsupported: minimax-h3 does not support video resolution 720p)`.

## Install

Node.js 18 or newer; nothing to `npm install`.

```bash
git clone https://github.com/osmondcardell/mcp-video-tools
cd mcp-video-tools
npm test                                   # optional: offline end-to-end tests
VIDEO_API_KEY=your-key node server.mjs     # speaks MCP on stdin/stdout; Ctrl-D to stop
```

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_API_KEY` | — | Bearer key for submit, status, download and upload |
| `VIDEO_API_BASE` | `https://argolink.io/v1` | any server with the same `/videos` protocol |
| `VIDEO_CATALOG_URL` | ArgoLink's public video catalog | where `list_video_models` reads limits and prices; falls back to `GET {base}/models` |
| `VIDEO_OUTPUT_DIR` | `./videos` | where `download_video` writes (file names are reduced to a base name) |
| `VIDEO_UPLOAD_ROOT` | unset | if set, `upload_media` only reads files inside this folder |
| `VIDEO_HTTP_TIMEOUT_MS` | `120000` | per-request timeout |

## Configure your client

Claude Code, from any project:

```bash
claude mcp add --transport stdio --env VIDEO_API_KEY=your-key video-tools -- node /absolute/path/to/mcp-video-tools/server.mjs
```

Or commit a project-scoped `.mcp.json` and keep the key in your shell:

```json
{
  "mcpServers": {
    "video-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-tools/server.mjs"],
      "env": { "VIDEO_API_KEY": "${VIDEO_API_KEY}", "VIDEO_OUTPUT_DIR": "${VIDEO_OUTPUT_DIR:-./videos}" }
    }
  }
}
```

Cursor reads the same shape from `.cursor/mcp.json` or `~/.cursor/mcp.json`; write the key as `"${env:VIDEO_API_KEY}"`.

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.video-tools]
command = "node"
args = ["/absolute/path/to/mcp-video-tools/server.mjs"]
env_vars = ["VIDEO_API_KEY"]
```

Then ask for a video in plain words, for example: *"Make a 6-second 9:16 clip of rain on a neon street with minimax-h3 at 768p, save it as rain.mp4."* The agent calls `list_video_models`, `submit_video`, `get_video_status` until done, then `download_video`.

## Models and prices

What `list_video_models` returned on 2026-10-07 (USD per output second):

| Model ID | Provider | Seconds | Tiers and price |
|---|---|---|---|
| `seedance-2.5` | ByteDance | 4–30 | 480p $0.0874 · 720p $0.196 · 1080p $0.483 |
| `seedance-2.0` | ByteDance | 4–15 | 480p $0.053 · 720p $0.11 · 1080p $0.28 · 4k $0.58 |
| `seedance-2.0-fast` | ByteDance | 4–15 | 480p $0.042 · 720p $0.091 |
| `seedance-2.0-mini` | ByteDance | 4–15 | 480p $0.026 · 720p $0.057 |
| `minimax-h3` | MiniMax | 4–15 | 768p $0.039 · 2k $0.064 |
| `wan-3` | Alibaba | 2–30 | 480p $0.038 · 720p $0.075 · 1080p $0.15 |
| `wan-3-prime` | Alibaba | 4–30 | 480p $0.051 · 720p $0.11 · 1080p $0.21 |
| `grok-imagine-video-1.5` | xAI | 1–15 | 480p $0.064 · 720p $0.112 · 1080p $0.20 |

Per-model rules the agent should respect, all visible in each model's catalog note: MiniMax H3 renders only 768p or 2k; `wan-3-prime` takes no first or last frame and only 16:9, 1:1 and 9:16; Seedance 2.5 frame modes need `aspect_ratio: "adaptive"`; only `seedance-2.5` and `wan-3` edit an existing clip. Reference video seconds are billed like output seconds, and failed or expired jobs are not billed.

## Protocol support

The server is dual-era, so it works with clients built before and after the stateless MCP revision:

| Client speaks | Handshake | Notes |
|---|---|---|
| MCP 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 | `initialize`, `notifications/initialized`, `ping` | the requested legacy version is echoed back |
| MCP 2026-07-28 | none; `server/discover` and per-request `_meta` | unsupported versions get error `-32022` listing the supported ones |

Every result carries `resultType: "complete"`; `tools/list` and `server/discover` carry `ttlMs` and `cacheScope`. Stdout carries JSON-RPC only; the one log line goes to stderr. Verified on 2026-10-07 with the official MCP Python SDK 2.3.0 client in its `legacy`, `auto` and `2026-07-28` modes, plus the bundled tests.

## Security notes

- The API key lives in the server's environment; no tool accepts it as an argument, and it is never echoed.
- `download_video` writes only inside `VIDEO_OUTPUT_DIR`.
- `upload_media` reads any path the process can read unless you set `VIDEO_UPLOAD_ROOT`. Set it when the agent should only upload from one folder.
- Signed upload URLs are used once and not returned to the agent.

## FAQ

**Does `submit_video` block until the video is ready?**
No. It returns a `request_id` at once. Generation takes minutes, which would outlast most tool-call timeouts, so status and download are separate tools.

**Which APIs does it work with?**
Any API with `POST /videos/generations`, `GET /videos/{id}`, `GET /videos/{id}/content` and Bearer auth. fal's queue API and Replicate's predictions use different shapes and would need their own server.

**Can the agent use local images as references?**
Yes: `upload_media` turns a local JPEG, PNG, WebP, MP4, MOV, WebM, MP3, WAV, M4A or AAC file into a `media_url`. Each model then applies its own format rules; MiniMax H3 and Wan 3, for example, take JPEG or PNG images.

**Why did my job fail without a charge?**
A failed or expired job is never billed. `get_video_status` returns `error.code` and `error.retryable`; resubmit only when `retryable` is true or after changing the input it names.

**What does a typical 5-second test cost?**
$0.13 on `seedance-2.0-mini` at 480p, $0.195 on `minimax-h3` at 768p, $0.19 on `wan-3` at 480p (rates above).

## License

MIT
