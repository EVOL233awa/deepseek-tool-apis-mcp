# DeepSeek Tool APIs MCP

把 DeepSeek 独立工具接口封装成 MCP 工具，供 AI 客户端调用。

`v1.0.0` · Node.js ≥ 20 · 零运行时依赖 · MCP stdio

![CI](https://github.com/EVOL233awa/deepseek-tool-apis-mcp/actions/workflows/ci.yml/badge.svg)

> 非官方项目，与 DeepSeek 无隶属关系；接口条款与价格以 [DeepSeek 官方文档](https://api-docs.deepseek.com/) 为准。
>
> **每次调用真实计费，没有免费额度。** 走的是独立 Search/Fetch/OCR/TTS/ASR 接口，不是模型内服务端工具，因而不享受“工具调用不计费”的政策。

## 目录

- [为什么用它](#为什么用它)
- [工具](#工具)
- [项目结构](#项目结构)
- [计费](#计费)
- [安装](#安装)
- [配置](#配置)
- [行为与限制](#行为与限制)
- [测试](#测试)
- [安全](#安全)
- [许可证](#许可证)

## 为什么用它

- **五个工具，一个进程**：Search、Fetch、OCR、TTS、ASR 都是无模型端点，可脱离对话轮次独立调用。
- **零运行时依赖**：单文件 `server.mjs`，只用 Node 内置模块；不需要 `npm install`。
- **成本可见**：每次调用都回显「本次按 N 次/页计费 约 ¥X」，并区分成功、失败、缓存命中。
- **重复调用不重复花钱**：Search 结果缓存 5 分钟、Fetch 正文缓存 60 分钟；相同查询在进程内命中缓存时直接返回，计费为 0。
- **失败不发计费请求**：批次中任一参数不合法就整批拒绝；TTS 输出路径校验先于合成请求。
- **MCP 原生**：标准 stdio、工具标题与 annotations、结构化错误 `isError`；不依赖任何客户端私有协议。

## 工具

| 工具 | DeepSeek 端点 | 说明 |
|---|---|---|
| `deepseek_search` | `POST /v1/tools/search` | 1–10 条查询并行执行，跨查询按 URL 去重合并；返回标题、URL、分数、权威度、日期、摘要 |
| `deepseek_fetch` | `POST /v1/tools/fetch` | 1–10 个网页并行抓取，返回 Markdown 正文；`offset` 支持长页面续读 |
| `deepseek_ocr` | `POST /v1/tools/ocr` | PDF/DOC/DOCX/PPT/PPTX/图片，逐页文本；支持最多 5 个文件并行 |
| `deepseek_tts` | `POST /v1/tools/tts` | 文字转语音（wav/pcm），音频落盘并返回路径 |
| `deepseek_asr` | `POST /v1/tools/asr` | 16 位 PCM WAV 或 Ogg Opus 转写，≤8 MiB / ≤120 秒 |

### 搜索

```jsonc
{
  "queries": ["DeepSeek V4.1 release", "deepseek-flash pricing"],
  "count": 8,
  "need_content": false,
  "ori_question": "DeepSeek 最近发布了什么？",
  "localization": "1.2.3.4",
  "max_summary_chars": 1200
}
```

- `queries` 每条 1–128 个 Unicode 字符；重复查询会先去重，只发一次、只计一次费。
- 支持 `site:`、`-site:`、`"精确短语"`、`-排除词`、`lang:zh,en`、`after:2025-01-01`、`before:2026-06-01`。
- `count` 默认 8（官方默认 10；这里调小以控制上下文体积），不影响计费。
- `ori_question` 必须 1–128 字符；`localization` 必须是合法 IPv4/IPv6，非法值在本地拒绝。
- 同一 URL 被多个查询命中时合并为一条：分数取最高、摘要/正文取最长，并标注命中查询数。
- `rerank_score ≥ 1.5` 标注「优质」；`authority ≥ 3` 标注「极权威」。

### 抓取

```jsonc
{ "urls": ["https://example.com/long-page"], "max_chars": 6000, "offset": 0 }
```

- 只接受含 host 的 HTTP/HTTPS URL，≤8192 字符，不能带用户名或密码。
- 官方没有服务端分页：每次调用都会完整抓取并计费一次；`offset` 是客户端切片。
- 截断时返回「续读用 offset: N」，该值可直接用于下一次调用；正文本身以省略号结尾不会误报截断。
- `offset` 按 JavaScript UTF-16 码元计；中文正文与返回的续读值一致，含 emoji 时一个字符可能占 2 个码元。
- 多 URL 时输出预算（默认 24,000 字符，可用 `DEEPSEEK_MAX_OUTPUT_CHARS` 调整）按剩余页面均摊，`max_chars` 仍作为单页上限。

### OCR

```jsonc
{ "file": "C:/docs/spec.pdf", "purpose": "text_recognition", "max_chars": 4000, "page_range": [1, 10] }
```

- `text_recognition` 只要文字；`rich_layout_recognition` 保留裁出的图与坐标标记。
- `page_range` 与 `max_chars` **只在客户端生效**：官方无服务端分页，整篇照常识别并按页计费。
- 支持 `file` 或 `files`（最多 5 个）；每个文件单独计费，单个失败不影响同批已成功的结果。
- 单页输出达上限时提示改用 `rich_layout_recognition`，适合工程图、图纸等密集标注页。

### TTS / ASR

```jsonc
// TTS
{ "text": "要朗读的文本", "voice_id": "stella", "format": "wav", "output_path": "C:/audio/out.wav" }
// ASR
{ "file": "C:/audio/in.wav" }
```

- TTS 计费字符上限 10,000；**只有汉字算 2**，中文标点、字母数字算 1。
- TTS 音频无法在 MCP 客户端内播放（内容块不含 audio），需用播放器打开返回路径。
- `output_path` 必须是绝对路径，扩展名需与 `format` 一致；已存在文件会被拒绝，避免误覆盖。省略时写入 `DEEPSEEK_AUDIO_DIR` 下的时间戳文件。
- ASR 只接受 16 位 PCM WAV 或 Ogg Opus，≤8 MiB、≤120 秒；双声道只识别左声道；语种自动识别。
- 长文本 TTS 可能阻塞十几分钟；客户端自身的工具超时可能先触发，建议每段 ≤2000 字符。

## 项目结构

```text
deepseek-tool-apis-mcp/
├── server.mjs              # 全部实现：MCP 协议 + 五个工具 + 缓存
├── tests/
│   ├── unit.mjs            # 纯函数单测（零成本）
│   ├── protocol.mjs        # 协议层测试（零成本）
│   ├── mock-api.mjs        # 本地 mock 端到端（零成本）
│   └── live-smoke.mjs      # 真实接口冒烟（约 ¥0.01）
├── examples/mcp.json       # 通用 MCP 客户端配置示例
├── docs/clients.md         # AstrBot / Codex / Docker / 超时说明
├── .github/workflows/ci.yml
├── Dockerfile
├── CHANGELOG.md
└── LICENSE
```

## 计费

| 操作 | 官方单价 | 单次典型成本 |
|---|---|---|
| Search 1 个 query | 5 元/1000 次成功请求 | ¥0.005 |
| Fetch 1 个 URL | 5 元/1000 次成功请求 | ¥0.005 |
| OCR 1 页 | 1.5 元/1000 页 | ¥0.0015 |
| TTS 1 计费字符 | 3 元/万字符（限时 5 折 1.5） | 1 万字符 ≈ ¥1.5 |
| ASR 1 小时音频 | 0.78 元/小时（限时 5 折 0.39） | 60 秒 ≈ ¥0.0065 |

- 只有成功请求计费：Search 必须返回非空 `results`，Fetch 必须取到正文；失败、无结果、空正文均不计费。
- 缓存命中不计费；每次输出的计费行会注明「N 个命中缓存，未计费」。
- 最贵的是 OCR：52 页 PDF 一次约 ¥0.078，且 `page_range` 不会减少计费页数。
- 计费行中的金额仅用于估算与展示；实际扣费以官方账单为准。

## 安装

```bash
git clone https://github.com/EVOL233awa/deepseek-tool-apis-mcp.git
cd deepseek-tool-apis-mcp
node server.mjs --check
```

零依赖，不需要 `npm install`；`node server.mjs` 即启动 MCP stdio 服务（通常由客户端作为子进程拉起）。

`--check` 只读取配置、不发网络请求：

```text
deepseek-tool-apis-mcp 1.0.0
node: v22.x
api_base: https://api.deepseek.com
api_key: 已配置
search_cache: 300000 ms, max 200 entries
enabled_tools: search,fetch,ocr,tts,asr
...
```

也可以安装为全局命令（不经过 npm registry）：

```bash
npm install -g .
deepseek-tool-apis-mcp --version
```

### MCP 客户端配置

Claude Desktop（`claude_desktop_config.json`）或 Claude Code（项目根 `.mcp.json`）：

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

Claude Desktop、Claude Code、Cursor、Cline、LibreChat 等客户端都使用上面的 `mcpServers` 形状，完整示例见 [`examples/mcp.json`](examples/mcp.json)。

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.deepseek_tool_apis]
command = 'D:\NodeJS\node.exe'
args = ['C:\path\to\deepseek-tool-apis-mcp\server.mjs']
env = { DEEPSEEK_API_KEY = 'sk-...', DEEPSEEK_ALLOWED_DIRS = 'C:\Users\me\projects' }
startup_timeout_sec = 30
tool_timeout_sec = 300
```

AstrBot、Docker、各类客户端的超时差异见 [`docs/clients.md`](docs/clients.md)。

## 配置

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `DEEPSEEK_API_KEY` | API Key（必需，只从环境变量读取） | — |
| `DEEPSEEK_API_BASE` | API 地址 | `https://api.deepseek.com` |
| `DEEPSEEK_ALLOWED_DIRS` | OCR/ASR 读取与 TTS 写入的白名单；分隔符同 `PATH` | 空（不限制） |
| `DEEPSEEK_AUDIO_DIR` | TTS 默认输出目录 | `~/.deepseek-tool-apis-mcp/tts` |
| `DEEPSEEK_ENABLED_TOOLS` | 只启用列出的工具（短名 `search`/`fetch`/`ocr`/`tts`/`asr`，逗号分隔）；未知名称启动失败 | 空（全部启用） |
| `DEEPSEEK_SEARCH_CACHE_TTL_MS` | Search 缓存 TTL；`0` 关闭 | `300000` |
| `DEEPSEEK_FETCH_CACHE_TTL_MS` | Fetch 缓存 TTL；`0` 关闭 | `3600000` |
| `DEEPSEEK_CACHE_MAX_ENTRIES` | 两个缓存各自的条数上限 | `200` |
| `DEEPSEEK_MAX_OUTPUT_CHARS` | 单次工具输出预算 | `24000` |

密钥只从 `DEEPSEEK_API_KEY` 读取，不访问本机其它应用的凭证文件；密钥不会写入日志或工具输出。

## 行为与限制

- **缓存**：当 Search/Fetch 的缓存 TTL 大于 0 时：只缓存有结果的查询（Search 5 分钟）和有正文的页面（Fetch 60 分钟）；缓存是进程内 LRU，重启即清空，设 `0` 关闭。
- **输出预算**：当单次输出达到 `DEEPSEEK_MAX_OUTPUT_CHARS`（默认 24,000）时：按剩余条目均摊并标注截断；OCR 多文件按文件数均摊，Fetch 多 URL 按剩余页面均摊。
- **重试**：当请求返回 408/429/5xx 或发生网络错误时：重试 2 次；429 优先读 `Retry-After`（上限 15 s）；400/401/402/403/404 不重试。
- **超时**：Search 30 s、Fetch 60 s、OCR 200 s、ASR 200 s、TTS 20 min。
- **参数校验**：当批次中任一查询/URL 非法时：整批拒绝，不产生任何计费请求；数值参数越界会被 clamp 到合法范围。
- **本地文件**：当设置 `DEEPSEEK_ALLOWED_DIRS` 时：OCR/ASR 读取与 TTS 写入必须落在白名单内，且白名单检查先于存在性检查；路径支持 `~/` 展开。
- **工具启停**：当设置 `DEEPSEEK_ENABLED_TOOLS` 时：被禁用的工具不出现在 `tools/list`，直接调用返回错误。用于只读环境禁用 TTS、AstrBot 只开 Search/Fetch 等受限部署。
- **MCP annotations**：Search/Fetch/OCR/ASR 标记为只读；TTS 标记为可写（会落盘）。
- **未实现**：MCP 进度通知与取消通知目前不处理；长任务被客户端掐断时，服务端可能已经计费。
- **内容安全**：抓取到的网页正文是不可信数据，不应直接当作指令执行。

## 测试

零成本套件（不发任何外部请求）：

```bash
npm test
```

包含三组：

| 文件 | 内容 | 项数 |
|---|---|---|
| `tests/unit.mjs` | URL 归一化、计费字符、缓存/LRU、路径展开、OCR 预算等纯函数 | 98 |
| `tests/protocol.mjs` | 协议协商、并发乱序、通知、畸形输入、参数校验 | 22 |
| `tests/mock-api.mjs` | 本地 mock API 的 search/fetch/tts 端到端、缓存、offset 续读 | 68 |

真实接口冒烟（约 ¥0.01，手动运行）：

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```

CI 在 Node 20 / 22 上只跑零成本套件，不会产生接口费用。

## 安全

- API Key 只从 `DEEPSEEK_API_KEY` 环境变量读取，不访问本机其它配置；不出现在日志、错误信息或工具输出中。
- `DEEPSEEK_ALLOWED_DIRS` 可把 OCR/ASR 的读取和 TTS 的写入限制在指定目录；未设置时不限制。
- TTS 拒绝覆盖已存在文件，避免模型误写同名路径。
- 网页正文、OCR 文本、搜索摘要都可能包含恶意指令，调用方应把它们当作数据而非指令。

## 许可证

[MIT](LICENSE)。第三方 API 的使用受 DeepSeek 自身条款约束。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。
