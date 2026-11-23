# DeepSeek Tool APIs MCP · 客户端接入

标准 MCP stdio 服务的客户端接入配置与超时约束说明。

`v1.0.0` · Node.js ≥ 20 · 标准 MCP stdio，不依赖客户端私有协议

## 目录

- [通用配置](#通用配置)
- [工具启停](#工具启停)
- [API Key](#api-key)
- [客户端示例](#客户端示例)
  - [Codex](#codex)
  - [AstrBot](#astrbot)
  - [Docker](#docker)
- [验证接入](#验证接入)
- [超时与限制](#超时与限制)

## 通用配置

任何能启动 Node 子进程并传环境变量的客户端都可以接入；协议层只需要 `initialize` / `tools/list` / `tools/call`。

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

Claude Desktop、Claude Code、Cursor、Cline、LibreChat 等客户端都使用上面的 `mcpServers` 形状；Claude Code 的项目级配置放在仓库根 `.mcp.json`。Windows 路径建议使用正斜杠或 JSON 转义的反斜杠。

完整环境变量表见 [README 的配置节](../README.md#配置)。

## 工具启停

`DEEPSEEK_ENABLED_TOOLS` 接受逗号分隔的短名 `search`/`fetch`/`ocr`/`tts`/`asr`，未设置时全部启用。出现未知名称会让进程启动失败，避免拼错后静默暴露全部工具。在 `env` 中按需追加：

```json
{
  "DEEPSEEK_API_KEY": "sk-...",
  "DEEPSEEK_ENABLED_TOOLS": "search,fetch"
}
```

被禁用的工具不会出现在 `tools/list`，直接调用会返回 `isError` 与当前启用列表。受限环境（只读、客户端超时较短）建议只开实际用到的工具。

## API Key

只从 `DEEPSEEK_API_KEY` 环境变量读取，不访问本机其它应用的凭证文件。**所有客户端都必须在 `env` 里显式设置**，否则工具调用会返回明确错误。

## 客户端示例

### Codex

配置在 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。Windows 路径必须用 TOML 字面量字符串（单引号），否则 `\U`、`\N` 会被当转义符：

```toml
[mcp_servers.deepseek_tool_apis]
command = 'D:\NodeJS\node.exe'
args = ['C:\Users\me\projects\deepseek-tool-apis-mcp\server.mjs']
env = { DEEPSEEK_API_KEY = 'sk-...', DEEPSEEK_ALLOWED_DIRS = 'C:\Users\me\projects' }
startup_timeout_sec = 30
tool_timeout_sec = 300
```

Codex 默认工具超时 300 s、启动超时 30 s。OCR（200 s）刚好够；长文本 TTS 需要调大 `tool_timeout_sec`。

### AstrBot

AstrBot 的 stdio 接入有三处硬约束：

| 约束 | 规则 | 本项目 |
|---|---|---|
| 命令白名单 | 只允许 `python/python3/py/node/npx/npm/pnpm/yarn/bun/bunx/deno/uv/uvx`，会剥掉 Windows 路径与 `.exe` 后缀 | `D:\NodeJS\node.exe` 归一为 `node` |
| shell 元字符 | `command` 中出现换行、`;`、`&`、`\|`、`<`、`>`、反引号或 `$` 直接拒绝（只查 command，不查 args） | 路径干净 |
| 禁内联求值 | `node` 类命令禁止 `-e/--eval/-p/--print` 与裸 `eval` | 只传 `.mjs` 路径 |

AstrBot 的 `agent.config.misc.tool_call_timeout` 默认 **120 秒**，会作为 MCP `read_timeout_seconds` 传下来：

| 工具 | server 侧超时 | 在 AstrBot 默认 120 s 下 |
|---|---|---|
| `deepseek_search` / `deepseek_fetch` | 30 s / 60 s | 正常 |
| `deepseek_asr` | 200 s | 短音频正常，接近上限会先被掐断 |
| `deepseek_ocr` | 200 s | 长文档会被掐断 |
| `deepseek_tts` | 20 min | 长文本会被掐断 |

长任务要么调大 `tool_call_timeout`，要么缩短输入。被掐断时服务端可能已计费。该配置只在 AstrBot 的 `data/cmd_config.json` 生效，`data/config/` 下的文件不读这一项。

Docker 部署的 AstrBot 还有两个坑：

1. 宿主机的 `D:\NodeJS\node.exe` 在容器里不存在；容器内装 Node 后用 `node`，或把脚本挂进去。
2. 默认音频目录 `~/.deepseek-tool-apis-mcp/tts` 在容器里是临时路径；用 `DEEPSEEK_AUDIO_DIR` 指到挂载卷。

### Docker

```bash
docker build -t deepseek-tool-apis-mcp .
docker run -i --rm \
  -e DEEPSEEK_API_KEY=sk-... \
  -v /host/allowed:/data \
  -e DEEPSEEK_ALLOWED_DIRS=/data \
  deepseek-tool-apis-mcp
```

- stdio 服务必须带 `-i`，否则容器拿不到 MCP 输入。
- OCR/ASR 的文件路径是**容器内路径**；宿主目录要通过 `-v` 挂载进来，并把容器内路径传给工具。
- TTS 输出目录建议挂载到宿主，便于播放。

## 验证接入

1. 零成本检查配置：`node server.mjs --check`，确认输出含 `api_key: 已配置` 与预期的 `enabled_tools`。
2. 重载客户端后查看工具列表：`tools/list` 应只包含启用的工具。
3. 可选：调用一次 `deepseek_search` 验证链路与 Key；成功返回约 ¥0.005，无结果不计费。

若工具列表为空，先确认客户端把 `env` 传给了子进程——多数客户端不会继承登录 shell 的环境变量。

## 超时与限制

| 工具 | 超时 | 说明 |
|---|---|---|
| `deepseek_search` | 30 s | 单次搜索通常 1 s 内 |
| `deepseek_fetch` | 60 s | 目标站点慢时会用到 |
| `deepseek_ocr` | 200 s | 官方总时长 180 s，留 20 s 余量 |
| `deepseek_asr` | 200 s | 音频 ≤120 s |
| `deepseek_tts` | 20 min | 覆盖 10,000 计费字符的音频生成 |

客户端侧超时如果比上表短，以客户端为准；被客户端掐断不会取消已经发出的官方请求，可能仍会计费。

- TTS 返回的是文件路径，MCP 内容块不含 audio，客户端无法直接播放。
- OCR 的 `page_range` 与 `max_chars` 只在客户端过滤，整篇仍会识别并按页计费。
- 服务端不处理 MCP 进度通知与取消通知；长任务被掐断时请求可能已经计费。
