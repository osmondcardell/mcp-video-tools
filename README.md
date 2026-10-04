# Argolink video tools for MCP

A small Model Context Protocol tool surface for discovering Argolink models and running video jobs.

[Open the Argolink API docs →](https://argolink.io/gh-mcp-video-tools)

## Tools

- `list_models`: expose the current public model catalog.
- `submit_video`: validate and submit one video request.
- `get_video_status`: inspect one request ID.
- `download_video`: save completed content to a caller-owned path.

Tool descriptions should state required fields, status values, and error behavior so an agent can recover without guessing.

## Argolink boundary

Runtime requests read credentials from `ARGOLINK_API_KEY` and never from committed files.

All examples, field names, routes, and environment variables in this repository are written for Argolink. Check the linked documentation for live availability and limits. No external provider credentials, author attribution, or copied checkout material is required to use this repository.

## Layout

- `docs/` contains the public design and validation notes.
- `examples/` contains small runnable examples.
- `argolink/` contains the Argolink mapping for this repository.
- `ARGOLINK_LINKS.md` contains the tracked landing link.
