# MCP tool contract

Tools return structured JSON and keep transport errors separate from model errors. `submit_video` returns only `request_id` and safe metadata. `get_video_status` returns `pending`, `running`, `done`, `failed`, or `expired`. `download_video` refuses to fetch until the status is `done`.

A server implementation should read `ARGOLINK_API_KEY` at process start, set network timeouts, and redact request headers from logs.