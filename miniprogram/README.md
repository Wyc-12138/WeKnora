# WeKnora Mini Program

This directory contains a WeChat Mini Program plugin for WeKnora. It gives mobile users a lightweight entry point to:

- configure a WeKnora API endpoint and tenant API key;
- list and inspect available knowledge bases;
- inspect knowledge file names and parse status;
- import a URL or upload a file into a selected knowledge base;
- manage sessions and continue historical chats;
- ask a selected knowledge base through WeKnora knowledge chat with streaming display when supported by WeChat.

## Getting started

1. Open `miniprogram/` in WeChat DevTools.
2. Copy `project.private.config.json.example` to `project.private.config.json` and set your real Mini Program AppID. The shared `project.config.json` intentionally does not include an AppID to avoid forcing maintainers into a placeholder project.
3. Open the **Settings** tab and fill in:
   - API Base URL, for example `https://weknora.example.com`;
   - API Key from the WeKnora tenant settings page.
4. Open the **Knowledge** tab, refresh knowledge bases, and select or inspect the target knowledge base.
5. Import a URL, upload files from a knowledge base detail page, or switch to **Chat** / **Sessions** to ask questions.

## Local development notes

- WeChat DevTools may block `localhost` requests when URL validation is enabled. For local testing, either disable domain validation in DevTools or expose WeKnora through a HTTPS development domain.
- In production Mini Programs, add the WeKnora API domain to the Mini Program request domain allowlist.
- The chat endpoint returns Server-Sent Events. The Mini Program client uses chunked request callbacks for streaming when available, and falls back to parsing the completed SSE text response.
- File uploads use the server-side default parsing and chunking configuration for the selected knowledge base.

## Test

```bash
cd miniprogram
npm test
```
