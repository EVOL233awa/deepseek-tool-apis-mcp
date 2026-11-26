# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/2.0.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `deepseek_ocr` / `deepseek_asr` 新增 `sources`：每项给 `base64` 或 `url`，server 端解码/下载后以 Blob 上传；调用方无需先把文件放进 server 所在容器。可与本地 `file`/`files` 混用，仍受各工具文件数上限约束（OCR 5、ASR 1）。
- 配置项 `DEEPSEEK_SOURCE_URL_ALLOW_PRIVATE=1`：显式允许 `sources[].url` 指向私有/环回地址。

### Security

- `sources[].url` 默认拒绝私有/环回/链路本地/metadata 地址（含 DNS 解析结果与每一跳重定向），下载限 30 s / 3 跳 / 工具大小上限，防止 SSRF 与超大响应。
- 非法 base64、缺文件名、大小越界在本地拒绝，不产生计费请求。

## [1.0.0] - 2026-11-23

首个公开版本。

### Added

- `deepseek_search`：1–10 条查询并行执行，跨查询按 URL 去重合并；相同查询先本地去重，只计费一次。
- `deepseek_fetch`：1–10 个网页并行抓取，`offset` 支持长页面续读；多 URL 时输出预算按剩余页面均摊。
- `deepseek_ocr`：PDF/Word/PPT/图片逐页识别，支持最多 5 个文件并行与客户端 `page_range` 过滤；单个文件失败不影响同批其他结果。
- `deepseek_tts`：语音合成落盘，支持 `voice_id`、`format` 与自定义 `output_path`。
- `deepseek_asr`：16 位 PCM WAV / Ogg Opus 音频转写。
- Search/Fetch 进程内 TTL + LRU 缓存：Search 5 分钟、Fetch 60 分钟，缓存命中不计费。
- 配置项：`DEEPSEEK_ALLOWED_DIRS`、`DEEPSEEK_AUDIO_DIR`、`DEEPSEEK_ENABLED_TOOLS`、`DEEPSEEK_SEARCH_CACHE_TTL_MS`、`DEEPSEEK_FETCH_CACHE_TTL_MS`、`DEEPSEEK_CACHE_MAX_ENTRIES`、`DEEPSEEK_MAX_OUTPUT_CHARS`。
- `DEEPSEEK_ENABLED_TOOLS` 工具启停白名单：未列出的工具不出现在 `tools/list`，调用时返回错误；未知名称启动失败。
- `--help`、`--version`、`--check` 命令行参数。
- MCP tool annotations：只读工具与可写工具分别标注。
- 请求统一携带 `deepseek-tool-apis-mcp/<version>` User-Agent。
- 错误信息与计费行区分成功、失败与缓存命中。

### Security

- API Key 只从 `DEEPSEEK_API_KEY` 环境变量读取，不访问本机其它配置。
- 本地文件白名单检查先于存在性检查，避免通过错误信息探测白名单外的文件。
- TTS 拒绝覆盖已存在文件，避免模型误写同名路径。
- API Key 不写入日志、错误信息或工具输出。

[1.0.0]: https://github.com/EVOL233awa/deepseek-tool-apis-mcp/releases/tag/v1.0.0
