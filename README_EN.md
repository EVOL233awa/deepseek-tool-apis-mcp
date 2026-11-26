[中文](README.md) | English

# DeepSeek Tool APIs MCP

DeepSeek's standalone tool APIs, exposed as MCP tools.

`v1.0.0` · Node.js ≥ 20 · Zero runtime dependencies · MCP stdio

![CI](https://github.com/EVOL233awa/deepseek-tool-apis-mcp/actions/workflows/ci.yml/badge.svg)

> Unofficial project, not affiliated with DeepSeek. API terms and pricing are governed by the [official DeepSeek documentation](https://api-docs.deepseek.com/).
>
> **Every call is billed; there is no free quota.** These are the standalone Search/Fetch/OCR/TTS/ASR APIs, not server-side tools inside a chat model, so the "tool calls are free" policy does not apply.

## Contents

- [Why use it](#why-use-it)
- [Tools](#tools)
- [Project layout](#project-layout)
- [Pricing](#pricing)
- [Installation](#installation)
- [Configuration](#configuration)
- [Behavior and limits](#behavior-and-limits)
- [Tests](#tests)
- [Security](#security)
- [License](#license)

## Why use it

- **Five tools, one process**: Search, Fetch, OCR, TTS and ASR are model-free endpoints that can be called outside a chat turn.
- **Zero runtime dependencies**: A single `server.mjs` using only Node built-ins; no `npm install` required.
- **Visible cost**: Every call reports "billed N requests/pages ≈ ¥X" and distinguishes success, failure and cache hits.
- **No double billing for repeats**: Search results are cached for 5 minutes and fetched pages for 60 minutes; identical calls served from the in-process cache cost nothing.
- **No billing request on invalid input**: If any item in a batch is invalid, the whole batch is rejected; TTS output paths are validated before synthesis.
- **MCP native**: Standard stdio, tool titles and annotations, structured `isError`; no client-specific protocol.

## Tools

| Tool | DeepSeek endpoint | Description |
|---|---|---|
| `deepseek_search` | `POST /v1/tools/search` | Runs 1–10 queries in parallel and merges results by URL across queries; returns title, URL, score, authority, date and summary |
| `deepseek_fetch` | `POST /v1/tools/fetch` | Fetches 1–10 pages in parallel and returns Markdown content; `offset` continues long pages |
| `deepseek_ocr` | `POST /v1/tools/ocr` | PDF/DOC/DOCX/PPT/PPTX/images, page-by-page text; up to 5 files in parallel |
| `deepseek_tts` | `POST /v1/tools/tts` | Text to speech (wav/pcm); writes the audio to disk and returns its path |
| `deepseek_asr` | `POST /v1/tools/asr` | Transcribes 16-bit PCM WAV or Ogg Opus, ≤8 MiB / ≤120 s |

### Search

```jsonc
{
  "queries": ["DeepSeek V4.1 release", "deepseek-flash pricing"],
  "count": 8,
  "need_content": false,
  "ori_question": "What did DeepSeek release recently?",
  "localization": "1.2.3.4",
  "max_summary_chars": 1200
}
```

- Each query is 1–128 Unicode characters; duplicate queries are deduplicated before sending, so they are sent and billed once.
- Supports `site:`, `-site:`, `"exact phrase"`, `-excluded`, `lang:zh,en`, `after:2025-01-01`, `before:2026-06-01`.
- `count` defaults to 8 (the official default is 10; lowered here to limit context size) and does not affect billing.
- `ori_question` must be 1–128 characters; `localization` must be a valid IPv4/IPv6 address and is rejected locally when invalid.
- Results sharing a URL across queries are merged: highest score, longest summary/content, plus the number of matching queries.
- `rerank_score ≥ 1.5` is labeled "high quality"; `authority ≥ 3` is labeled "highly authoritative".

### Fetch

```jsonc
{ "urls": ["https://example.com/long-page"], "max_chars": 6000, "offset": 0 }
```

- Accepts only HTTP/HTTPS URLs with a host, ≤8192 characters, without username or password.
- There is no server-side pagination: every call fetches the whole page and bills once; `offset` is a client-side slice.
- Truncation returns "continue with offset: N", which can be passed directly to the next call; content that genuinely ends with an ellipsis is not misreported as truncated.
- `offset` counts JavaScript UTF-16 code units; for Chinese text it matches the returned offset, while an emoji may take 2 code units.
- With multiple URLs, the output budget (24,000 characters by default, adjustable via `DEEPSEEK_MAX_OUTPUT_CHARS`) is shared across the remaining pages; `max_chars` remains the per-page cap.

### OCR

```jsonc
{ "file": "C:/docs/spec.pdf", "purpose": "text_recognition", "max_chars": 4000, "page_range": [1, 10] }
```

- `text_recognition` returns text only; `rich_layout_recognition` keeps cropped figures and coordinate markers.
- `page_range` and `max_chars` **apply on the client only**: there is no server-side paging, so the whole document is recognized and billed per page.
- Accepts `file` or `files` (up to 5); each file is billed separately and one failure does not discard successful results in the batch.
- If a single page hits the output limit, the result suggests `rich_layout_recognition`, which suits engineering drawings and densely annotated pages.

### Inline / remote files (`sources`)

MCP `tools/call` carries JSON only; there is no standard file attachment. OCR/ASR `sources` accepts Base64 or a URL, which the server decodes/downloads and uploads as multipart — callers do not need to place files inside the server container first.

```jsonc
// OCR: inline base64 (name required, with extension)
{ "sources": [{ "name": "spec.pdf", "base64": "JVBERi0xLjQ..." }] }
// ASR: a URL (name optional; inferred from the last URL segment)
{ "sources": [{ "url": "https://example.com/clip.wav" }] }
// Can be mixed with local paths; per-tool file limits still apply (OCR 5, ASR 1)
{ "file": "C:/docs/a.pdf", "sources": [{ "name": "b.pdf", "base64": "..." }] }
```

- Each item must provide exactly one of `base64` or `url`; `base64` accepts a `data:...;base64,` prefix.
- The type comes from the file extension: base64 requires `name`; for URLs it can be omitted and is inferred from the URL path.
- `DEEPSEEK_ALLOWED_DIRS` applies only to local paths; `sources` content is decoded/downloaded by the server and bypasses the local path allowlist.
- URLs pointing at private/loopback/link-local/metadata addresses are rejected by default (including DNS results and every redirect hop); downloads are capped at 30 s, 3 hops and the per-tool size limit. Set `DEEPSEEK_SOURCE_URL_ALLOW_PRIVATE=1` only when internal addresses are genuinely needed.
- Decode/download failures are rejected locally and produce no billed API request.

### TTS / ASR

```jsonc
// TTS
{ "text": "Text to read aloud", "voice_id": "stella", "format": "wav", "output_path": "C:/audio/out.wav" }
// ASR
{ "file": "C:/audio/in.wav" }
```

- TTS is capped at 10,000 billed characters; **only Han characters count as 2**, while Chinese punctuation, letters and digits count as 1.
- TTS audio cannot be played inside an MCP client (content blocks have no audio); open the returned path in a player.
- `output_path` must be absolute and its extension must match `format`; existing files are rejected to prevent overwrites. When omitted, audio goes to a timestamped file under `DEEPSEEK_AUDIO_DIR`.
- ASR accepts only 16-bit PCM WAV or Ogg Opus, ≤8 MiB and ≤120 seconds; for stereo input only the left channel is transcribed; language is detected automatically.
- Long TTS calls may block for many minutes; the client's own tool timeout may fire first, so keep each segment ≤2000 characters.

## Project layout

```text
deepseek-tool-apis-mcp/
├── server.mjs              # Everything: MCP protocol + five tools + caches
├── tests/
│   ├── unit.mjs            # Pure-function unit tests (zero cost)
│   ├── protocol.mjs        # Protocol tests (zero cost)
│   ├── mock-api.mjs        # Local mock end-to-end (zero cost)
│   └── live-smoke.mjs      # Live API smoke test (≈ ¥0.01)
├── examples/mcp.json       # Generic MCP client config example
├── docs/clients.md         # AstrBot / Codex / Docker / timeouts (Chinese)
├── .github/workflows/ci.yml
├── Dockerfile
├── CHANGELOG.md
└── LICENSE
```

## Pricing

| Operation | Official price | Typical cost |
|---|---|---|
| Search, 1 query | CNY 5 / 1,000 successful requests | ¥0.005 |
| Fetch, 1 URL | CNY 5 / 1,000 successful requests | ¥0.005 |
| OCR, 1 page | CNY 1.5 / 1,000 pages | ¥0.0015 |
| TTS, 1 billed character | CNY 3 / 10,000 characters (limited-time 50% off: CNY 1.5) | 10,000 characters ≈ ¥1.5 |
| ASR, 1 hour of audio | CNY 0.78 / hour (limited-time 50% off: CNY 0.39) | 60 s ≈ ¥0.0065 |

- Only successful requests are billed: Search must return non-empty `results`, Fetch must return content; failures, empty results and empty content are free.
- Cache hits are not billed; each billing line notes "N cache hits, not billed".
- OCR is usually the most expensive: a 52-page PDF costs about ¥0.078 per run, and `page_range` does not reduce billed pages.
- Amounts in billing lines are estimates for display only; the official invoice is authoritative.

## Installation

```bash
git clone https://github.com/EVOL233awa/deepseek-tool-apis-mcp.git
cd deepseek-tool-apis-mcp
node server.mjs --check
```

Zero dependencies, no `npm install` needed; `node server.mjs` starts the MCP stdio server (usually launched by the client as a child process).

`--check` only reads configuration and makes no network requests (CLI output is in Chinese):

```text
deepseek-tool-apis-mcp 1.0.0
node: v22.x
api_base: https://api.deepseek.com
api_key: 已配置
search_cache: 300000 ms, max 200 entries
enabled_tools: search,fetch,ocr,tts,asr
...
```

Install as a global command without the npm registry:

```bash
npm install -g .
deepseek-tool-apis-mcp --version
```

### MCP client configuration

Claude Desktop (`claude_desktop_config.json`) or Claude Code (project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "deepseek-tool-apis": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-tool-apis-mcp/server.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-...",
        "DEEPSEEK_ALLOWED_DIRS": "/absolute/allowed/dir"
      }
    }
  }
}
```

Clients such as Claude Desktop, Claude Code, Cursor, Cline and LibreChat all use the `mcpServers` shape above; see [`examples/mcp.json`](examples/mcp.json) for a complete example.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.deepseek_tool_apis]
command = 'D:\NodeJS\node.exe'
args = ['C:\path\to\deepseek-tool-apis-mcp\server.mjs']
env = { DEEPSEEK_API_KEY = 'sk-...', DEEPSEEK_ALLOWED_DIRS = 'C:\Users\me\projects' }
startup_timeout_sec = 30
tool_timeout_sec = 300
```

AstrBot, Docker and per-client timeout differences: see [`docs/clients.md`](docs/clients.md) (Chinese).

## Configuration

| Variable | Description | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | API key (required; read from the environment only) | — |
| `DEEPSEEK_API_BASE` | API base URL | `https://api.deepseek.com` |
| `DEEPSEEK_ALLOWED_DIRS` | Allowlist for OCR/ASR reads and TTS writes; same separator as `PATH`; local paths only | empty (unrestricted) |
| `DEEPSEEK_SOURCE_URL_ALLOW_PRIVATE` | Set to `1` to allow `sources[].url` to target private/loopback addresses | empty (rejected, anti-SSRF) |
| `DEEPSEEK_AUDIO_DIR` | Default TTS output directory | `~/.deepseek-tool-apis-mcp/tts` |
| `DEEPSEEK_ENABLED_TOOLS` | Only expose listed tools (short names `search`/`fetch`/`ocr`/`tts`/`asr`, comma-separated); unknown names abort startup | empty (all enabled) |
| `DEEPSEEK_SEARCH_CACHE_TTL_MS` | Search cache TTL; `0` disables | `300000` |
| `DEEPSEEK_FETCH_CACHE_TTL_MS` | Fetch cache TTL; `0` disables | `3600000` |
| `DEEPSEEK_CACHE_MAX_ENTRIES` | Entry limit for each cache | `200` |
| `DEEPSEEK_MAX_OUTPUT_CHARS` | Output budget per tool call | `24000` |

API keys are read only from `DEEPSEEK_API_KEY`; the server does not read credential files from other applications and never writes keys to logs or tool output.

## Behavior and limits

- **Cache**: When the Search/Fetch cache TTL is greater than 0: only queries with results (Search, 5 minutes) and pages with content (Fetch, 60 minutes) are cached; the cache is an in-process LRU that clears on restart; set `0` to disable.
- **Output budget**: When a single output reaches `DEEPSEEK_MAX_OUTPUT_CHARS` (24,000 by default): items share the remaining budget and truncation is marked; OCR splits it by file count, Fetch by remaining pages.
- **Retries**: On 408/429/5xx or network errors: retried 2 times; 429 honors `Retry-After` (max 15 s); 400/401/402/403/404 are not retried.
- **Timeouts**: Search 30 s, Fetch 60 s, OCR 200 s, ASR 200 s, TTS 20 min.
- **Validation**: If any query/URL in a batch is invalid: the whole batch is rejected without any billed request; numeric values are clamped to valid ranges.
- **Local files**: When `DEEPSEEK_ALLOWED_DIRS` is set: OCR/ASR reads and TTS writes must stay inside the allowlist, and the allowlist check happens before existence checks; `~/` is expanded.
- **Inline/remote files**: OCR/ASR `sources` accepts base64/URL without touching the local filesystem; URLs to private addresses are rejected by default, downloads are capped at 30 s / 3 hops, with size limits of 100 MiB for OCR and 8 MiB for ASR.
- **Tool enablement**: When `DEEPSEEK_ENABLED_TOOLS` is set: disabled tools do not appear in `tools/list` and direct calls return an error. Useful for read-only deployments or clients that should only use Search/Fetch.
- **MCP annotations**: Search/Fetch/OCR/ASR are marked read-only; TTS is marked writable (it writes files).
- **Not implemented**: MCP progress and cancellation notifications are not handled; if a client aborts a long task, the server may already have been billed.
- **Content safety**: Fetched page content is untrusted data and should never be executed as instructions.

## Tests

Zero-cost suite (no external requests):

```bash
npm test
```

Three groups:

| File | Coverage | Cases |
|---|---|---|
| `tests/unit.mjs` | URL normalization, billed characters, cache/LRU, path expansion, OCR budget, sources validation and other pure functions | 116 |
| `tests/protocol.mjs` | Protocol negotiation, concurrent out-of-order responses, notifications, malformed input, argument validation | 22 |
| `tests/mock-api.mjs` | Local mock end-to-end for search/fetch/tts and sources (base64/URL), caching, offset continuation | 80 |

Live smoke test (about ¥0.01, run manually):

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```

CI runs only the zero-cost suite on Node 20 and 22, so it incurs no API charges.

## Security

- The API key is read only from `DEEPSEEK_API_KEY`; it never appears in logs, error messages or tool output.
- `DEEPSEEK_ALLOWED_DIRS` restricts OCR/ASR reads and TTS writes to the given directories; unset means unrestricted; it applies to local paths only, not `sources`.
- `sources[].url` rejects private/loopback/link-local/cloud-metadata addresses by default and revalidates every redirect hop; `DEEPSEEK_SOURCE_URL_ALLOW_PRIVATE=1` opts out, use only on a trusted network.
- TTS refuses to overwrite existing files, preventing accidental writes to a path already in use.
- Page content, OCR text and search summaries may contain malicious instructions; treat them as data, not instructions.

## License

[MIT](LICENSE). Use of the third-party APIs is governed by DeepSeek's own terms.

See [CHANGELOG.md](CHANGELOG.md) for the change history.
