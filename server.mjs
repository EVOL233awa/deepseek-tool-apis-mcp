#!/usr/bin/env node
// DeepSeek 独立 Search / Fetch / OCR / TTS / ASR API 的 MCP 桥（stdio，零依赖）。
// 接口：POST https://api.deepseek.com/v1/tools/{search,fetch,ocr,tts,asr}，均不调用对话模型。
// 计费：Search/Fetch 5 元/1000 次成功请求；OCR 1.5 元/1000 页；TTS 3 元/万计费字符；ASR 0.78 元/小时。

import { openAsBlob } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";

const API_BASE = (process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com").replace(/\/+$/, "");
// 可选白名单：留空表示不限制（默认行为不变）。分隔符与 PATH 一致（Windows 用 `;`）。
// 设置后 OCR/ASR 的本地文件必须落在其中某一目录内，防止被诱导读取任意路径。
const ALLOWED_DIRS = (process.env.DEEPSEEK_ALLOWED_DIRS ?? "")
  .split(delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));

function isInsideDirs(target, roots) {
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function assertInsideAllowedDirs(target, label) {
  if (ALLOWED_DIRS.length === 0) return;
  if (!isInsideDirs(target, ALLOWED_DIRS)) {
    throw new Error(`${label} 不在允许的目录内（DEEPSEEK_ALLOWED_DIRS）：${target}`);
  }
}

// Key 只从环境变量读取。不自动读取本机其它应用的凭证文件：
// 那样会让 MCP 进程在用户不知情时动用供应商 Key，风险大于配置便利。
const API_KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();

const PROJECT_NAME = "deepseek-tool-apis-mcp";
const SERVER_INFO = { name: "deepseek-tool-apis", title: "DeepSeek Tool APIs MCP (Search / Fetch / OCR / TTS / ASR)", version: "1.0.0" };
const USER_AGENT = `${PROJECT_NAME}/${SERVER_INFO.version}`;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SEARCH_TIMEOUT_MS = 30_000;
// 网页抓取比搜索慢：目标站点响应、解析都可能拖到几十秒，30 s 会误杀正常页面。
const FETCH_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// OCR 官方限制：上传 120 s、总时长 180 s（含上传与返回）。解析期间服务端持续发换行保活，
// 不能用 search/fetch 的 30 s 超时。留 20 s 余量。
const OCR_TIMEOUT_MS = 200_000;
const OCR_MAX_BYTES = 100 * 1024 * 1024;
const OCR_MAX_PAGES = 1_000;
const OCR_MAX_FILES = 5;
// TTS 单次上限 10,000 计费字符（汉字算 2），官方最多返回 30 分钟音频。
// 10,000 计费字符约合 5,000 汉字，按 4–6 字/秒约 14–20 分钟音频；超时必须覆盖这一区间，
// 否则会出现「服务端已计费、本地提前放弃」的净损失。
const TTS_TIMEOUT_MS = 1_200_000;
const TTS_MAX_CHARS = 10_000;
const ASR_TIMEOUT_MS = 200_000;
const ASR_MAX_BYTES = 8 * 1024 * 1024;
// 音频落盘目录：MCP 内容块只有 text/image，发不出音频，只能给路径。
const AUDIO_OUTPUT_DIR = process.env.DEEPSEEK_AUDIO_DIR ?? join(homedir(), ".deepseek-tool-apis-mcp", "tts");
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_CHARS = envInt("DEEPSEEK_MAX_OUTPUT_CHARS", 24_000, 2_000, 200_000);
// 预算不足时宁可整块标截断，也不输出被切成半句的残片。
const MIN_BLOCK_CHARS = 400;
const DEFAULT_PER_ITEM_CHARS = 1_200;
const MAX_CONTENT_CHARS = 6_000;
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8_192;
// 进程内 TTL + LRU 缓存：只省掉重复计费的 Search/Fetch 请求，不落盘、不跨进程。
// 对应 TTL 设为 0 即关闭该缓存；max entries 同时约束两个缓存。
const CACHE_MAX_ENTRIES = envInt("DEEPSEEK_CACHE_MAX_ENTRIES", 200, 1, 10_000);
const SEARCH_CACHE_TTL_MS = envInt("DEEPSEEK_SEARCH_CACHE_TTL_MS", 5 * 60_000, 0, 24 * 60 * 60_000);
const FETCH_CACHE_TTL_MS = envInt("DEEPSEEK_FETCH_CACHE_TTL_MS", 60 * 60_000, 0, 24 * 60 * 60_000);
const searchCache = createCache({ ttlMs: SEARCH_CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
const fetchCache = createCache({ ttlMs: FETCH_CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
// 官方标价（人民币）。代码里同时用于估算和展示，改价只需改这里。
// Search/Fetch 按 1000 次成功请求；OCR 按成功页数；TTS 按计费字符（汉字算 2）；ASR 按音频小时。
const PRICE = {
  perRequest: 5 / 1000,
  perOcrPage: 1.5 / 1000,
  perTtsChar: 1.5 / 10_000, // 限时 5 折，刊例价 3 元/万字符
  perAsrHour: 0.39, // 限时 5 折，刊例价 0.78 元/小时
};

// 费用极小（单次搜索 0.005 元），两位小数会显示成 0.00；统一用 4 位小数并保留「约」。
function yuan(value) {
  return `¥${value.toFixed(4)}`;
}

function log(message) {
  process.stderr.write(`[deepseek-tool-apis] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  // 不在 UTF-16 代理对中间下刀，否则会留下孤立 surrogate，输出端显示为乱码。
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envInt(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    log(`忽略非法的 ${name}=${raw}，使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

// 极简 TTL + LRU：Map 的插入顺序当 LRU 链，命中时删了再插。
function createCache({ ttlMs, maxEntries, now = Date.now }) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (ttlMs <= 0 || maxEntries <= 0) return;
      store.delete(key);
      store.set(key, { value, expiresAt: now() + ttlMs });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    get size() { return store.size; },
    clear() { store.clear(); },
  };
}

// 支持 ~/x 与 ~\x；其余路径原样返回，调用方仍要求绝对路径。
function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

// 参数顺序固定，避免同一组条件生成不同键；缓存只认真正发出去的请求体。
function searchCacheKey(payload) {
  return JSON.stringify([
    payload.query,
    payload.count,
    payload.need_content === true,
    payload.ori_question ?? "",
    payload.localization ?? "",
  ]);
}

function apiHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, "User-Agent": USER_AGENT, ...extra };
}

function assertApiKey() {
  if (!API_KEY) {
    throw new Error("DeepSeek API Key 不可用：请设置环境变量 DEEPSEEK_API_KEY");
  }
}

// 仅用于跨查询去重：scheme/host 大小写不敏感，path 与 query 大小写敏感，
// 所以不能整体 toLowerCase，否则 /Path 与 /path 会被错误合并成一条。
function normalizeUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function describeHttpFailure(status, body) {
  let detail = clip(body, 400);
  try {
    const parsed = JSON.parse(body);
    const candidate = parsed?.error?.message ?? parsed?.error?.code ?? parsed?.message;
    if (typeof candidate === "string" && candidate.length > 0) detail = candidate;
  } catch {
    // 非 JSON 错误体（网关 HTML 等）沿用原文截断
  }
  return `HTTP ${status}: ${detail || "(empty body)"}`;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label ? `${label} → ` : ""}响应不是合法 JSON：${clip(text, 200)}`);
  }
}

// 官方错误一般是 4xx + error 对象；但网关或上游兜底也可能用 200 返回 error，
// 不检查就会被统计成「无结果」，调用方看不到真实原因。
function assertNoApiError(payload) {
  const error = payload?.error;
  if (!error) return payload;
  const message = typeof error === "string" ? error : error?.message ?? error?.code;
  throw new Error(typeof message === "string" && message ? message : "接口返回 error 对象");
}

// 429 会带上 Retry-After；官方 Search/Fetch 是按账号的 QPS 限制，盲目 400 ms 退避根本跨不过 1 秒窗口。
function retryDelayMs(attempt, response) {
  const header = response?.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 15_000));
  }
  return 400 * 2 ** attempt;
}

function isRetryableError(error) {
  return error instanceof Error
    && (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError");
}

// 返回响应体文本。非 2xx 与网络错误按状态码决定是否重试，全部尝试失败后抛出最后一次错误。
async function requestWithRetry(path, buildInit, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, attempts = MAX_ATTEMPTS } = options;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      // buildInit 可能需要重建 FormData（重新 openAsBlob），所以允许异步。
      const init = await buildInit();
      response = await fetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isRetryableError(error) && attempt < attempts - 1) {
        lastError = error;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    const text = await response.text();
    if (response.ok) return text;
    const failure = new Error(describeHttpFailure(response.status, text));
    if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
      lastError = failure;
      await sleep(retryDelayMs(attempt, response));
      continue;
    }
    throw failure;
  }
  throw lastError ?? new Error("请求失败");
}

async function apiPostJson(path, body, options) {
  assertApiKey();
  const text = await requestWithRetry(path, () => ({
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  }), options);
  return assertNoApiError(parseJson(text, ""));
}

function requireQueries(args) {
  const raw = Array.isArray(args?.queries) ? args.queries : [];
  const queries = raw.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (queries.length === 0) throw new Error("queries 必须包含至少一个非空字符串");
  if (queries.length > 10) throw new Error(`queries 最多 10 条，收到 ${queries.length} 条`);
  return queries.map((q) => {
    const trimmed = q.trim();
    // 官方限制 1–128 个 Unicode 字符，按码点计，不能用 UTF-16 长度。
    if ([...trimmed].length > MAX_QUERY_CHARS) {
      throw new Error(`查询超过 ${MAX_QUERY_CHARS} 个字符：${clip(trimmed, 60)}`);
    }
    return trimmed;
  });
}

// 相同查询重复提交会各发一次并各计一次费，发送前按 trim 后的原文去重。
function uniqueQueries(queries) {
  const seen = new Set();
  const unique = [];
  for (const query of queries) {
    if (seen.has(query)) continue;
    seen.add(query);
    unique.push(query);
  }
  return unique;
}

function parseOriQuestion(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("ori_question 必须是字符串");
  const question = value.trim();
  if (!question) return "";
  if ([...question].length > MAX_QUERY_CHARS) {
    throw new Error(`ori_question 超过 ${MAX_QUERY_CHARS} 个字符：${clip(question, 60)}`);
  }
  return question;
}

// 官方要求 localization 是合法 IP，非法值会直接 400；本地先拦可省一次请求并给出明确原因。
function parseLocalization(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("localization 必须是 IP 地址字符串");
  const address = value.trim();
  if (!address) return "";
  if (isIP(address) === 0) {
    throw new Error(`localization 必须是合法 IP 地址（IPv4/IPv6）：${clip(address, 60)}`);
  }
  return address;
}

function validateFetchUrl(value) {
  const url = value.trim();
  if ([...url].length > MAX_URL_CHARS) throw new Error(`URL 超过 ${MAX_URL_CHARS} 字符：${clip(url, 80)}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`不是合法 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 HTTP/HTTPS：${url}`);
  }
  if (!parsed.hostname) throw new Error(`URL 缺少 host：${url}`);
  if (parsed.username || parsed.password) throw new Error(`URL 不能携带用户名或密码：${url}`);
  return url;
}

function requireUrls(args) {
  const raw = Array.isArray(args?.urls) ? args.urls : [];
  const urls = raw.filter((u) => typeof u === "string" && u.trim().length > 0);
  if (urls.length === 0) throw new Error("urls 必须包含至少一个非空字符串");
  if (urls.length > 10) throw new Error(`urls 最多 10 条，收到 ${urls.length} 条`);
  // 全部校验通过后才发请求，避免批次中途失败时已付出的部分计费白扔。
  return urls.map(validateFetchUrl);
}

const OCR_MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

async function prepareOcrFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("file 必须是本地文件路径");
  const resolved = expandHome(filePath.trim());
  if (!isAbsolute(resolved)) throw new Error(`file 必须是绝对路径：${resolved}`);
  // 白名单必须先于 stat：否则错误信息会泄露允许目录以外的文件是否存在。
  assertInsideAllowedDirs(resolve(resolved), resolved);
  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`文件不存在或不是普通文件：${resolved}`);
  if (info.size === 0) throw new Error(`文件为空：${resolved}`);
  if (info.size > OCR_MAX_BYTES) {
    throw new Error(`文件 ${(info.size / 1024 / 1024).toFixed(1)} MiB 超过 OCR 上限 100 MiB`);
  }
  const ext = extname(resolved).toLowerCase();
  const mime = OCR_MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的扩展名 ${ext || "(无)"}；支持 PDF/DOC/DOCX/PPT/PPTX/PNG/JPEG/WEBP/GIF/BMP/TIFF`);
  return { resolved, name: basename(resolved), mime, size: info.size };
}

// page_range 是客户端过滤：官方接口没有服务端分页，整篇都会识别并按页计费。
function parsePageRange(value) {
  if (value === undefined || value === null) return null;
  const from = Array.isArray(value) ? value[0] : value?.from;
  const to = Array.isArray(value) ? value[1] : value?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("page_range 必须是两个整数 [起始, 结束]");
  if (from < 1 || to < 1) throw new Error(`page_range 页码从 1 起，收到 [${from}, ${to}]`);
  if (from > to) throw new Error(`page_range 起始页不能大于结束页，收到 [${from}, ${to}]`);
  if (to > OCR_MAX_PAGES) throw new Error(`page_range 超过文档页数上限 ${OCR_MAX_PAGES}，收到 [${from}, ${to}]`);
  return { from, to };
}

function ocrErrorText(error) {
  if (typeof error === "string") return error;
  const message = error?.message ?? error?.code;
  return typeof message === "string" && message ? message : "识别失败";
}

function slicePages(payload, range) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  const total = Number.isInteger(payload?.page_count) ? payload.page_count : pages.length;
  if (!range) return { ...payload, pages, total_pages: total };
  // 页数只有上传后才知道，这一步已经计费，所以要给出明确越界原因而不是静默返回末页。
  if (total === 0 || range.from > total) {
    throw new Error(`page_range [${range.from}, ${range.to}] 超出文档页数 ${total}`);
  }
  const end = Math.min(range.to, total);
  return { ...payload, pages: pages.slice(range.from - 1, end), total_pages: total, shown_range: [range.from, end] };
}

function formatOcrResult(payload, perPageChars, budget = MAX_OUTPUT_CHARS) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  const total = payload?.total_pages ?? pages.length;
  const shown = Array.isArray(payload?.shown_range) ? payload.shown_range : null;
  const scope = shown && total > pages.length ? `，本次显示第 ${shown[0]}–${shown[1]} 页` : "";
  const head = `OCR 完成：共 ${total} 页${scope}（purpose: ${payload?.purpose ?? "unknown"}）`;
  const parts = [head];
  // page_range 只在客户端过滤，服务端仍按整篇计费——必须让调用方看到真实成本。
  const billedPages = Number.isInteger(payload?.page_count) ? payload.page_count : total;
  parts.push(`本次按 ${billedPages} 页计费 约 ${yuan(billedPages * PRICE.perOcrPage)}`);
  const usage = payload?.usage;
  if (usage && typeof usage.total_tokens === "number") {
    parts[0] += `，模型 token ${usage.total_tokens}（仅参考，不用于计费）`;
  }
  if (pages.length === 0) {
    parts.push("", "未返回任何页面内容。");
    return parts.join("\n");
  }

  let used = parts[0].length;
  const clippedPages = [];
  let truncatedFrom = null;
  for (const [position, page] of pages.entries()) {
    const index = typeof page?.index === "number" ? page.index : position;
    const flag = page?.finish_reason === "length" ? "（该页输出达上限，文本不完整）" : "";
    if (page?.finish_reason === "length") clippedPages.push(index + 1);
    const heading = `\n## 第 ${index + 1} 页`;
    const body = clip(typeof page?.text === "string" ? page.text : "", perPageChars) || "（空）";
    const block = `${heading}${flag}\n${body}`;
    const remaining = budget - used;
    if (block.length <= remaining) {
      parts.push(block);
      used += block.length;
      continue;
    }
    // 单页就超预算（max_chars 设得过大）时截断该页，而不是把整页丢掉导致输出为空。
    const available = remaining - heading.length - flag.length - 2;
    if (available >= MIN_BLOCK_CHARS) parts.push(`${heading}${flag}\n${clip(body, available)}`);
    truncatedFrom = index + 1;
    break;
  }
  if (truncatedFrom !== null) {
    // 每次调用都计费，所以直接给出续读区间，避免整篇重跑。
    const to = Math.min(truncatedFrom + 9, total);
    parts.push(`\n（已截断：输出预算用尽，第 ${truncatedFrom} 页起未完整显示。用 page_range: [${truncatedFrom}, ${to}] 继续读取，或降低 max_chars）`);
  }
  if (clippedPages.length > 0) {
    // 逐页识别对密布标注的图纸会撞到单页 token 上限；rich_layout 会把图当图片占位并保留图注。
    parts.push(
      `\n（第 ${clippedPages.join("、")} 页触发单页输出上限。若该页是工程图、图纸或密集标注页，改用 purpose=rich_layout_recognition 只取图注与版面结构更有效。）`,
    );
  }
  return parts.join("\n");
}

// 上游偶发返回 HTTP 200、page_count 正常但 output_tokens=0、所有页文本为空。
// 不检测就会被当成成功返回，调用方付了费用却拿不到任何内容。
function isEmptyOcr(payload) {
  if (payload?.usage?.output_tokens === 0) return true;
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  return pages.length > 0 && pages.every((page) => typeof page?.text !== "string" || !page.text.trim());
}

async function ocrOne(file, { purpose, perPageChars, range, budget }) {
  const upload = async () => {
    const form = new FormData();
    // 官方要求 purpose 出现在 file 之前，且不接受其他字段（否则 400）。
    form.append("purpose", purpose);
    form.append("file", await openAsBlob(file.resolved, { type: file.mime }), file.name);
    return { method: "POST", headers: apiHeaders(), body: form };
  };

  let payload = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await requestWithRetry("/v1/tools/ocr", upload, {
      // 超时类的重试要重传整个文件，代价大，只给一次机会；429/503 靠 Retry-After 退避。
      timeoutMs: OCR_TIMEOUT_MS,
      attempts: 2,
    });
    payload = parseJson(text, file.name);
    // 识别开始后状态码仍是 200，失败时以 error 对象返回，必须查响应体。
    if (payload?.error) throw new Error(ocrErrorText(payload.error));
    if (!isEmptyOcr(payload)) break;
    if (attempt === 0) {
      log(`${file.name} 返回空结果（output_tokens=${payload?.usage?.output_tokens ?? "?"}），重试一次`);
      await sleep(1_000);
    }
  }
  if (isEmptyOcr(payload)) {
    throw new Error("识别结果为空（服务端 output_tokens=0），多为上游偶发故障，可重试；本次调用可能已计费");
  }
  return `${file.name}（${(file.size / 1024).toFixed(0)} KiB）\n${formatOcrResult(slicePages(payload, range), perPageChars, budget)}`;
}

async function runOcr(args) {
  assertApiKey();
  const requested = Array.isArray(args?.files) && args.files.length > 0 ? args.files : [args?.file];
  const cleaned = requested.filter((f) => typeof f === "string" && f.trim());
  if (cleaned.length === 0) throw new Error("file 或 files 必须提供至少一个本地文件绝对路径");
  if (cleaned.length !== requested.length) {
    throw new Error(`files 中有 ${requested.length - cleaned.length} 项不是非空字符串`);
  }
  if (cleaned.length > OCR_MAX_FILES) {
    throw new Error(`一次最多识别 ${OCR_MAX_FILES} 个文件（每个都单独计费），收到 ${cleaned.length} 个`);
  }
  const purpose = args?.purpose === "rich_layout_recognition" ? "rich_layout_recognition" : "text_recognition";
  const perPageChars = clampInt(args?.max_chars, 200, 40_000, 4_000);
  const range = parsePageRange(args?.page_range);

  // 先校验全部文件再上传：任一文件不合法时一个计费请求都不发。
  const files = [];
  for (const filePath of cleaned) files.push(await prepareOcrFile(filePath));

  // 官方允许每账号 15 个并发识别，串行处理 5 个文件会让总耗时逼近 5×180 s。
  // 每个文件分到的输出预算按并发文件数均摊，避免 5×24k 字符一次性灌入上下文。
  const perFileBudget = Math.floor(MAX_OUTPUT_CHARS / files.length);
  const settled = await Promise.allSettled(
    files.map((file) => ocrOne(file, { purpose, perPageChars, range, budget: perFileBudget })),
  );
  const outputs = [];
  const failures = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") outputs.push(outcome.value);
    else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      failures.push(`${files[index].name} → ${reason}`);
    }
  });

  if (outputs.length === 0) {
    return { text: [`OCR 失败（${failures.length} 个文件）`, ...failures.map((f) => `- ${f}`)].join("\n"), failed: true };
  }
  const parts = [];
  if (failures.length > 0) {
    // 成功的那几个已经计费，必须原样带出，不能因为同批次有失败就丢弃。
    parts.push(`OCR 完成 ${outputs.length} 个文件，${failures.length} 个失败：`, ...failures.map((f) => `- ${f}`));
  }
  parts.push(...outputs);
  return { text: parts.join("\n\n"), failed: false };
}

// 官方口径：汉字算 2 个计费字符，其他字符（含中文标点、全角符号）算 1 个。
// 用 Script=Han 精确匹配汉字，避免把「、」「，」也算成 2 导致合法的长文本被误拒。
const HAN_CHAR = /\p{Script=Han}/u;

function countBilledChars(text) {
  let total = 0;
  for (const ch of text) total += HAN_CHAR.test(ch) ? 2 : 1;
  return total;
}

const ASR_MIME_BY_EXT = {
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};

async function prepareAsrFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("file 必须是本地音频文件路径");
  const resolvedPath = expandHome(filePath.trim());
  if (!isAbsolute(resolvedPath)) throw new Error(`file 必须是绝对路径：${resolvedPath}`);
  // 白名单必须先于 stat，避免通过错误信息探测允许目录外的文件是否存在。
  assertInsideAllowedDirs(resolve(resolvedPath), resolvedPath);
  const info = await stat(resolvedPath).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`文件不存在或不是普通文件：${resolvedPath}`);
  if (info.size === 0) throw new Error(`文件为空：${resolvedPath}`);
  if (info.size > ASR_MAX_BYTES) {
    throw new Error(`文件 ${(info.size / 1024 / 1024).toFixed(1)} MiB 超过 ASR 上限 8 MiB（音频最长 120 秒）`);
  }
  const ext = extname(resolvedPath).toLowerCase();
  const mime = ASR_MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的扩展名 ${ext || "(无)"}；ASR 只接受 16 位 PCM WAV 或 Ogg Opus`);
  return { resolvedPath, name: basename(resolvedPath), mime, size: info.size };
}

// TTS 成功时返回二进制流，不能走 requestWithRetry（它按文本读响应体）。
async function synthesize(payload) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(`${API_BASE}/v1/tools/tts`, {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
    } catch (error) {
      if (isRetryableError(error) && attempt < MAX_ATTEMPTS - 1) {
        lastError = error;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      const body = await response.text();
      const failure = new Error(describeHttpFailure(response.status, body));
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        lastError = failure;
        await sleep(retryDelayMs(attempt, response));
        continue;
      }
      throw failure;
    }
    // 成功响应是 audio/*；若拿到 JSON 说明服务端用 200 报了错（如内容审核），不能当音频存盘。
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("audio/")) {
      const body = await response.text();
      throw new Error(`响应不是音频（Content-Type: ${contentType || "无"}）：${clip(body, 300)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("未返回音频数据");
    return bytes;
  }
  throw lastError ?? new Error("请求失败");
}

async function resolveTtsOutput(args, voiceId, format) {
  const requested = typeof args?.output_path === "string" ? args.output_path.trim() : "";
  if (!requested) {
    await mkdir(AUDIO_OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return resolve(AUDIO_OUTPUT_DIR, `tts-${stamp}-${voiceId}.${format}`);
  }
  const expanded = expandHome(requested);
  if (!isAbsolute(expanded)) throw new Error(`output_path 必须是绝对路径：${expanded}`);
  const ext = extname(expanded).toLowerCase();
  if (ext && ext !== `.${format}`) throw new Error(`output_path 扩展名应为 .${format}：${expanded}`);
  const target = ext ? expanded : `${expanded}.${format}`;
  assertInsideAllowedDirs(resolve(target), target);
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) throw new Error(`output_path 是目录：${target}`);
  if (info) throw new Error(`output_path 已存在，请换一个路径：${target}`);
  await mkdir(dirname(target), { recursive: true });
  return target;
}

async function runTts(args) {
  assertApiKey();
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text.trim()) throw new Error("text 不能为空");
  const billed = countBilledChars(text);
  if (billed > TTS_MAX_CHARS) {
    throw new Error(`计费字符 ${billed} 超过单次上限 ${TTS_MAX_CHARS}（汉字算 2 个），请分段后重试`);
  }
  const voiceId = args?.voice_id === "tide" ? "tide" : "stella";
  const format = args?.format === "pcm" ? "pcm" : "wav";

  const payload = { text, voice_id: voiceId, format };
  if (typeof args?.filter_markdown === "boolean") {
    payload.filter_markdown = args.filter_markdown;
  }

  // 先解析并校验输出路径，再发计费请求：路径非法或已存在时不该产生费用。
  const outPath = await resolveTtsOutput(args, voiceId, format);
  const bytes = await synthesize(payload);
  await writeFile(outPath, bytes);

  return {
    text: [
      `语音合成完成（${voiceId === "tide" ? "tide 暗潮·男声" : "stella 海星·女声"}，${format}）`,
      `计费字符 ${billed}（汉字算 2），本次约 ${yuan(billed * PRICE.perTtsChar)}`,
      `文件 ${(bytes.length / 1024).toFixed(0)} KiB`,
      `路径 ${outPath}`,
      "MCP 内容块只有 text/image，不含 audio，无法在客户端内直接播放，需用播放器打开该路径。",
    ].join("\n"),
    failed: false,
  };
}

async function runAsr(args) {
  assertApiKey();
  const file = await prepareAsrFile(args?.file);

  const raw = await requestWithRetry(
    "/v1/tools/asr",
    async () => {
      const form = new FormData();
      form.append("file", await openAsBlob(file.resolvedPath, { type: file.mime }), file.name);
      return { method: "POST", headers: apiHeaders(), body: form };
    },
    { timeoutMs: ASR_TIMEOUT_MS },
  );
  const payload = parseJson(raw, file.name);
  const text = typeof payload?.text === "string" ? payload.text : "";
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const seconds = durationMs === undefined ? undefined : durationMs / 1000;
  // 官方按音频时长计费，精确到秒、不足 1 秒按 1 秒。
  const billedSeconds = seconds === undefined ? undefined : Math.ceil(seconds);
  const parts = [
    `语音识别完成：${file.name}（${(file.size / 1024).toFixed(0)} KiB）`,
    seconds === undefined ? "时长 未知" : `时长 ${seconds.toFixed(2)} s`,
    billedSeconds === undefined
      ? "本次费用 未知（缺 duration_ms）"
      : `本次按 ${billedSeconds} s 计费 约 ${yuan((billedSeconds / 3600) * PRICE.perAsrHour)}`,
    "",
    text || "（未识别出文本）",
  ];
  // 按音频时长计费，空文本通常意味着静音或识别失败，标成错误让调用方知道结果不可用。
  return { text: parts.join("\n"), failed: !text };
}

function maxMetric(a, b) {
  if (typeof a !== "number") return typeof b === "number" ? b : undefined;
  if (typeof b !== "number") return a;
  return Math.max(a, b);
}

function longestText(a, b) {
  if (typeof a !== "string" || a.length === 0) return typeof b === "string" ? b : "";
  if (typeof b !== "string" || b.length === 0) return a;
  return b.length > a.length ? b : a;
}

// 同一 URL 被多个查询命中时保留信息量最大的一份：分数取最高，摘要/正文取最长。
function mergeSearchItem(base, incoming) {
  return {
    ...base,
    rerank_score: maxMetric(base.rerank_score, incoming.rerank_score),
    authority: maxMetric(base.authority, incoming.authority),
    summary: longestText(base.summary, incoming.summary),
    snippet: longestText(base.snippet, incoming.snippet),
    content: longestText(base.content, incoming.content),
    date: base.date ?? incoming.date,
    site_name: base.site_name ?? incoming.site_name,
  };
}

function formatSearchResult(entry, index, perItemChars) {
  const { item, matchedBy } = entry;
  const lines = [];
  const title = clip(item.title, 160) || "(untitled)";
  lines.push(`${index}. ${title}`);
  lines.push(`   ${item.url}`);

  const meta = [];
  if (typeof item.rerank_score === "number") {
    // 官方口径：0–3 分，≥1.5 为优质结果。
    meta.push(`score ${item.rerank_score.toFixed(2)}${item.rerank_score >= 1.5 ? "(优质)" : ""}`);
  }
  if (typeof item.authority === "number" && item.authority >= 0) {
    // 0–4 分，≥3 为极权威，-1 表示未知。
    meta.push(`authority ${item.authority}${item.authority >= 3 ? "(极权威)" : ""}`);
  }
  if (typeof item.date === "string" && item.date) meta.push(item.date);
  if (typeof item.site_name === "string" && item.site_name) meta.push(item.site_name);
  if (matchedBy.length > 1) meta.push(`命中 ${matchedBy.length} 个查询`);
  if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

  const summary = clip(item.summary, perItemChars);
  if (summary) lines.push(`   摘要: ${summary.replace(/\s*\n+\s*/g, " ")}`);
  const snippet = clip(item.snippet, 240);
  if (snippet && !summary.includes(snippet.slice(0, 40))) lines.push(`   片段: ${snippet.replace(/\s*\n+\s*/g, " ")}`);
  const content = clip(item.content, MAX_CONTENT_CHARS);
  if (content) lines.push(`   正文: ${content}`);
  return lines.join("\n");
}

async function runSearch(args) {
  // 先确认 Key，避免每个查询各报一条相同的失败信息。
  assertApiKey();
  const requested = requireQueries(args);
  const queries = uniqueQueries(requested);
  const duplicateCount = requested.length - queries.length;
  // 官方上限 50；count 不影响计费，只影响返回条数与上下文体积。
  const count = clampInt(args?.count, 1, 50, 8);
  const needContent = args?.need_content === true;
  const perItemChars = clampInt(args?.max_summary_chars, 200, 4_000, DEFAULT_PER_ITEM_CHARS);
  // ori_question 帮助搜索服务理解意图；localization 用于本地化排序。两者都可省略。
  const basePayload = {};
  const question = parseOriQuestion(args?.ori_question);
  if (question) basePayload.ori_question = question;
  const localization = parseLocalization(args?.localization);
  if (localization) basePayload.localization = localization;

  const payloads = queries.map((query) => ({ query, count, need_content: needContent, ...basePayload }));
  const cacheKeys = payloads.map(searchCacheKey);
  const fromCache = new Array(payloads.length).fill(false);
  let cacheHits = 0;
  const settled = await Promise.allSettled(
    payloads.map((payload, index) => {
      const cached = searchCache.get(cacheKeys[index]);
      if (cached !== undefined) {
        fromCache[index] = true;
        cacheHits += 1;
        return cached;
      }
      return apiPostJson("/v1/tools/search", payload, { timeoutMs: SEARCH_TIMEOUT_MS }).then((value) => {
        // 无结果本来就不计费，缓存它只会藏住偶发空结果，没有省钱价值。
        if (Array.isArray(value?.results) && value.results.length > 0) searchCache.set(cacheKeys[index], value);
        return value;
      });
    }),
  );

  const merged = new Map();
  const failures = [];
  let dropped = 0;
  // 只有返回非空 results 的查询才计费；缓存命中的请求本次不产生费用。
  let billedRequests = 0;
  queries.forEach((query, index) => {
    const outcome = settled[index];
    if (outcome.status === "rejected") {
      failures.push(`${query} → ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      return;
    }
    const results = Array.isArray(outcome.value?.results) ? outcome.value.results : [];
    if (results.length === 0) failures.push(`${query} → 无结果（无结果不计费）`);
    else if (!fromCache[index]) billedRequests += 1;
    for (const item of results) {
      if (!item || typeof item !== "object") {
        dropped += 1;
        continue;
      }
      const key = normalizeUrl(item.url);
      if (!key) {
        dropped += 1;
        continue;
      }
      const hit = merged.get(key);
      if (hit) {
        hit.item = mergeSearchItem(hit.item, item);
        hit.matchedBy.add(query);
      } else merged.set(key, { item, matchedBy: new Set([query]) });
    }
  });

  const ordered = [...merged.values()]
    .map((entry) => ({ ...entry, matchedBy: [...entry.matchedBy] }))
    .sort((a, b) => {
      const scoreDiff = (b.item.rerank_score ?? 0) - (a.item.rerank_score ?? 0);
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
      return (b.item.authority ?? 0) - (a.item.authority ?? 0);
    });

  const notes = [];
  if (duplicateCount > 0) notes.push(`已合并 ${duplicateCount} 条重复查询`);
  if (dropped > 0) notes.push(`丢弃 ${dropped} 条无效 URL`);
  if (failures.length > 0) notes.push(`${failures.length} 个查询无结果或失败`);
  const header = `搜索 ${queries.length} 个查询，去重后 ${ordered.length} 条结果`
    + (notes.length > 0 ? `（${notes.join("；")}）` : "");
  const cacheNote = cacheHits > 0 ? `（${cacheHits} 个查询命中缓存，未计费）` : "";
  const costLine = `本次按 ${billedRequests} 次成功请求计费 约 ${yuan(billedRequests * PRICE.perRequest)}${cacheNote}`;
  const reminder = "REMINDER: 需要引用来源时，请包含本次返回的 URL 作为 markdown 链接。";
  if (ordered.length === 0) {
    // 一条结果都没拿到时给引用提醒毫无意义，只保留失败原因。
    const text = [header, costLine, ...failures.map((f) => `- ${f}`)].join("\n");
    return { text, failed: true };
  }

  const failureLines = failures.map((f) => `- ${f}`);
  let used = header.length + costLine.length + reminder.length + failureLines.join("").length + 16;
  const blocks = [];
  let truncatedFrom = null;
  for (const [index, entry] of ordered.entries()) {
    const block = formatSearchResult(entry, index + 1, perItemChars);
    if (used + block.length > MAX_OUTPUT_CHARS) {
      truncatedFrom = index + 1;
      break;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  if (truncatedFrom !== null) {
    blocks.push(`（已截断：输出预算用尽，第 ${truncatedFrom}–${ordered.length} 条未显示，可降低 count 或 max_summary_chars）`);
  }

  const parts = [header, costLine, ""];
  if (failureLines.length > 0) parts.push(...failureLines, "");
  parts.push(...blocks);
  parts.push("", reminder);
  return { text: parts.join("\n"), failed: false };
}

async function runFetch(args) {
  assertApiKey();
  const urls = requireUrls(args);
  const perPageChars = clampInt(args?.max_chars, 500, 40_000, MAX_CONTENT_CHARS);
  // 官方没有服务端分页，长页面只能整篇拉回再按字符切。offset 让调用方可以接着上次的位置读，
  // 避免「正文截断后永远拿不到后半段」。多 URL 时 offset 统一生效（各地起点相同）。
  const offset = clampInt(args?.offset, 0, Number.MAX_SAFE_INTEGER, 0);

  const fromCache = new Array(urls.length).fill(false);
  let cacheHits = 0;
  const settled = await Promise.allSettled(
    urls.map((url, index) => {
      const cached = fetchCache.get(url);
      if (cached !== undefined) {
        fromCache[index] = true;
        cacheHits += 1;
        return cached;
      }
      return apiPostJson("/v1/tools/fetch", { url }, { timeoutMs: FETCH_TIMEOUT_MS }).then((value) => {
        // 空正文不算成功、不缓存，下次仍值得重试。
        if (typeof value?.content === "string" && value.content.trim()) fetchCache.set(url, value);
        return value;
      });
    }),
  );

  const header = `抓取 ${urls.length} 个 URL` + (offset > 0 ? `（从第 ${offset} 字符起）` : "");
  const parts = [header];
  let used = header.length;
  let succeeded = 0;
  let billedFetches = 0;
  const omitted = [];
  urls.forEach((url, index) => {
    const outcome = settled[index];
    parts.push("", `## ${url}${fromCache[index] ? "（缓存）" : ""}`);
    used += url.length + 5;
    if (outcome.status === "rejected") {
      parts.push(`失败：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      return;
    }
    const payload = outcome.value ?? {};
    const title = clip(payload.title, 200);
    if (title) {
      parts.push(`标题：${title}`);
      used += title.length + 4;
    }
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content.trim()) {
      parts.push("无可用正文。");
      return;
    }
    succeeded += 1;
    if (!fromCache[index]) billedFetches += 1;
    // offset 与长度都以 trim 后的正文为基准，避免首尾空白造成偏移错位。
    const full = content.trim();
    const start = Math.min(offset, full.length);
    if (start >= full.length) {
      parts.push(`（offset ${offset} 超出正文长度 ${full.length} 字符）`);
      return;
    }
    const remainingText = full.slice(start);
    // 多 URL 时按剩余页面均摊预算，避免前几页吃光额度、后面整批被丢弃；
    // max_chars 仍是单页上限，均摊只会让它更小。
    const fairShare = Math.floor((MAX_OUTPUT_CHARS - used) / (urls.length - index));
    const budget = Math.min(perPageChars, fairShare);
    if (budget < MIN_BLOCK_CHARS) {
      omitted.push(url);
      return;
    }
    const body = clip(remainingText, budget);
    parts.push(body);
    used += body.length + 2;
    // 截断时 clip 会用省略号替换最后一个字符，实际消费的是 budget - 1 个字符；
    // 不能用 endsWith("…") 判断，正文本身以省略号结尾时会少算一个字符。
    const truncated = remainingText.length > budget;
    const consumed = start + (truncated ? Math.max(0, body.length - 1) : body.length);
    if (consumed < full.length) {
      parts.push(`（已截断：本页正文共 ${full.length} 字符，读到第 ${consumed} 字符，续读用 offset: ${consumed}）`);
    }
  });
  if (omitted.length > 0) {
    parts.push("", `（已截断：输出预算用尽，以下 URL 的正文未显示：${omitted.join("、")}）`);
  }
  // 只有取到正文的 URL 才计费；404/403/无正文都不收费，缓存命中也不计费。
  const cacheNote = cacheHits > 0 ? `（${cacheHits} 个命中缓存，未计费）` : "";
  parts.push("", `本次按 ${billedFetches} 次成功抓取计费 约 ${yuan(billedFetches * PRICE.perRequest)}${cacheNote}`);
  return { text: parts.join("\n"), failed: succeeded === 0 };
}

const TOOLS = [
  {
    name: "deepseek_search",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: "DeepSeek 网页搜索",
    description:
      "用 DeepSeek 官方独立搜索接口检索网页，返回标题、URL、相关性分数、权威度、发布日期与摘要。支持一次提交多个查询并行执行，跨查询自动合并去重。不调用任何模型，按成功请求计费（5 元/1000 次，无结果不计费）。查询语法支持 site:、-site:、\"精确短语\"、-排除词、lang:zh,en、after:2025-01-01、before:2026-06-01。",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 10,
          description: "要搜索的查询（每条 ≤128 个 Unicode 字符），并行执行后合并去重。用 2-4 条不同角度的查询覆盖同一主题，比单条查询召回更全。",
        },
        count: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "每个查询返回的结果条数上限（官方 1-50，不影响计费）。" },
        need_content: { type: "boolean", default: false, description: "为 true 时额外返回页面正文（token 消耗明显增加），仅在摘要不足时开启。" },
        ori_question: { type: "string", maxLength: 128, description: "触发本次搜索的用户原始问题（1-128 字符）。从对话派生短 query 时填上可改善搜索意图理解与召回。" },
        localization: { type: "string", description: "用于优先返回本地化结果的 IP 地址（IPv4/IPv6），可省略；非法 IP 会在本地被拒绝。" },
        max_summary_chars: { type: "integer", minimum: 200, maximum: 4000, default: 1200, description: "单条结果摘要的字符上限。" },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_fetch",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: "DeepSeek 网页抓取",
    description:
      "用 DeepSeek 官方独立抓取接口读取 1-10 个公开 HTTP/HTTPS 页面，返回 Markdown 正文与标题。不调用任何模型，按成功请求计费（5 元/1000 次，未取到正文不计费）。支持并行。长页面可配合 offset 分次读取（每次都会重新抓取并计费）。",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 10, description: "要抓取的页面 URL（≤8192 字符，必须是含 host 的 HTTP/HTTPS 地址，不能带用户名或密码）。" },
        max_chars: { type: "integer", minimum: 500, maximum: 40000, default: 6000, description: `单个页面本次返回的正文上限。多 URL 时 ${MAX_OUTPUT_CHARS} 字符的总预算按剩余页面均摊，max_chars 仍作为单页上限。` },
        offset: { type: "integer", minimum: 0, default: 0, description: "从正文第几个字符开始返回，用于接着上次的进度读长页面。截断时会给出下次应使用的 offset。注意官方没有服务端分页，每次调用都会完整抓取并计费。" },
      },
      required: ["urls"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_tts",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: "DeepSeek 语音合成",
    description:
      "把文字合成为语音（wav 或 pcm），音频落盘并返回路径。不调用对话模型，按计费字符计费（3 元/万字符，限时 5 折 1.5 元；汉字算 2 个字符）。注意：MCP 内容块不含 audio，无法直接播放，需用播放器打开返回的路径。长文本单次调用可能阻塞数分钟，建议每段 ≤2000 字符。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "要朗读的文本，计费字符上限 10,000（汉字算 2）。" },
        voice_id: { type: "string", enum: ["stella", "tide"], default: "stella", description: "stella 海星（女声，默认）或 tide 暗潮（男声）。" },
        format: { type: "string", enum: ["wav", "pcm"], default: "wav", description: "wav 为完整的音频文件；pcm 是 24 kHz / 16 位 / 单声道裸数据。" },
        filter_markdown: { type: "boolean", default: true, description: "朗读前是否去掉 Markdown 标记。" },
        output_path: { type: "string", description: "可选：音频写入路径（支持 ~ 展开，必须是绝对路径）。省略时写入 DEEPSEEK_AUDIO_DIR 下的时间戳文件；已存在或扩展名不匹配会拒绝。设置 DEEPSEEK_ALLOWED_DIRS 时必须落在白名单内。" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_asr",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: "DeepSeek 语音识别",
    description:
      "把本地音频文件转写为文字（16 位 PCM WAV 或 Ogg Opus，≤8 MiB、≤120 秒）。不调用对话模型，按音频时长计费（0.78 元/小时，限时 5 折 0.39 元）。语种自动识别，支持 21 种语言。",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "音频文件的绝对路径（.wav / .ogg / .opus）。" },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_ocr",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: "DeepSeek OCR",
    description:
      "用 DeepSeek 官方 OCR 接口识别本地 PDF/Word/PowerPoint/图片中的文字，按页返回。不调用对话模型，按成功页数计费（1.5 元/1000 页）。text_recognition 丢弃文档中的图、只要文字；rich_layout_recognition 会裁出图表并保留坐标标记（如 <｜ref｜>标题<｜/ref｜><｜box｜>[[52,40,948,96]]<｜/box｜>，坐标按页宽高归一化到 0–1000）。page_range 与 max_chars 都只在客户端生效，整篇仍会识别并按页计费。",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "要识别的本地文件绝对路径。" },
        files: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 5,
          description: "同 file，可一次传多个（最多 5 个）。每个文件单独计费。file 与 files 二选一。",
        },
        purpose: {
          type: "string",
          enum: ["text_recognition", "rich_layout_recognition"],
          default: "text_recognition",
          description: "text_recognition：只要文字，图表照片丢弃；rich_layout_recognition：保留裁出的图与坐标。",
        },
        max_chars: { type: "integer", minimum: 200, maximum: 40000, default: 4000, description: "单页文本的字符上限。" },
        page_range: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 2,
          maxItems: 2,
          description: "只返回指定页码区间 [起始, 结束]，1 起算、含两端。用于分页读取长文档。",
        },
      },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  deepseek_search: runSearch,
  deepseek_fetch: runFetch,
  deepseek_ocr: runOcr,
  deepseek_tts: runTts,
  deepseek_asr: runAsr,
};

// 工具启停：逗号分隔的短名白名单，未设置时全部启用。
// 只影响暴露面，不改变计费；白名单内拼错名称会让启动失败，避免「想只开 search，结果全部暴露」。
const TOOL_NAMES = ["search", "fetch", "ocr", "tts", "asr"];
const TOOL_SUMMARIES = {
  search: "deepseek_search 多查询并行去重",
  fetch: "deepseek_fetch 读网页正文",
  ocr: "deepseek_ocr 识别本地文档",
  tts: "deepseek_tts 合成语音",
  asr: "deepseek_asr 转写音频",
};

function parseEnabledTools(raw) {
  if (raw === undefined || raw.trim() === "") return { names: new Set(TOOL_NAMES), error: null };
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    return { names: new Set(), error: `DEEPSEEK_ENABLED_TOOLS 未包含任何工具名；可选：${TOOL_NAMES.join(", ")}` };
  }
  const unknown = names.filter((name) => !TOOL_NAMES.includes(name));
  if (unknown.length > 0) {
    return { names: new Set(), error: `DEEPSEEK_ENABLED_TOOLS 含未知工具：${unknown.join(", ")}；可选：${TOOL_NAMES.join(", ")}` };
  }
  return { names: new Set(names), error: null };
}

const ENABLED_TOOLS = parseEnabledTools(process.env.DEEPSEEK_ENABLED_TOOLS);

function isToolEnabled(name) {
  return ENABLED_TOOLS.names.has(name.slice("deepseek_".length));
}

function negotiateProtocol(requested) {
  if (typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested)) return requested;
  return SUPPORTED_PROTOCOLS[0];
}

async function handleRequest(message) {
  const method = message.method;
  const params = message.params ?? {};

  switch (method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocol(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `DeepSeek 官方独立工具接口（不调用模型）：${TOOL_NAMES.filter((name) => ENABLED_TOOLS.names.has(name)).map((name) => TOOL_SUMMARIES[name]).join("、")}。Search/Fetch 按成功请求计费，无结果不计费。`,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.filter((tool) => isToolEnabled(tool.name)) };
    case "tools/call": {
      const name = params.name;
      const handler = HANDLERS[name];
      if (!handler) throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
      if (!isToolEnabled(name)) {
        return {
          content: [{ type: "text", text: `工具 ${name} 已被 DEEPSEEK_ENABLED_TOOLS 禁用（当前启用：${[...ENABLED_TOOLS.names].join(", ")}）` }],
          isError: true,
        };
      }
      try {
        const { text, failed } = await handler(params.arguments ?? {});
        return failed
          ? { content: [{ type: "text", text }], isError: true }
          : { content: [{ type: "text", text }] };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `调用失败：${messageText}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`未实现的方法：${method}`), { code: -32601 });
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  if (message === null || typeof message !== "object") return;

  const hasId = message.id !== undefined && message.id !== null;
  if (typeof message.method !== "string") {
    if (hasId) send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "无效请求" } });
    return;
  }
  if (!hasId) return;

  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : -32603;
    const text = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  }
}

const HELP_TEXT = `DeepSeek Tool APIs MCP — 把 DeepSeek 官方独立 Tool APIs 封装成 MCP 工具。

用法:
  node server.mjs                 以 MCP stdio 服务运行（供 Claude Code / Codex / Cursor 等调用）
  node server.mjs --check         检查配置并退出（不发网络请求）
  node server.mjs --version       打印版本
  node server.mjs --help          打印本帮助

环境变量:
  DEEPSEEK_API_KEY                 必需；只从环境变量读取
  DEEPSEEK_API_BASE                默认 https://api.deepseek.com
  DEEPSEEK_ALLOWED_DIRS            OCR/ASR 读取与 TTS 写入的本地目录白名单
  DEEPSEEK_AUDIO_DIR               TTS 默认输出目录
  DEEPSEEK_ENABLED_TOOLS           启用的工具，逗号分隔（search,fetch,ocr,tts,asr）；默认全部
  DEEPSEEK_SEARCH_CACHE_TTL_MS     Search 缓存 TTL，默认 300000；0 关闭
  DEEPSEEK_FETCH_CACHE_TTL_MS      Fetch 缓存 TTL，默认 3600000；0 关闭
  DEEPSEEK_CACHE_MAX_ENTRIES       缓存条数上限，默认 200
  DEEPSEEK_MAX_OUTPUT_CHARS        单次输出预算，默认 24000`;

function checkReport() {
  return [
    `${PROJECT_NAME} ${SERVER_INFO.version}`,
    `node: ${process.version}`,
    `api_base: ${API_BASE}`,
    `api_key: ${API_KEY ? "已配置" : "缺失（所有工具调用会失败）"}`,
    `search_cache: ${SEARCH_CACHE_TTL_MS} ms, max ${CACHE_MAX_ENTRIES} entries`,
    `fetch_cache: ${FETCH_CACHE_TTL_MS} ms, max ${CACHE_MAX_ENTRIES} entries`,
    `output_budget: ${MAX_OUTPUT_CHARS} chars`,
    `enabled_tools: ${[...ENABLED_TOOLS.names].join(",")}`,
    `allowed_dirs: ${ALLOWED_DIRS.length > 0 ? ALLOWED_DIRS.join(delimiter) : "(未限制)"}`,
    `audio_dir: ${AUDIO_OUTPUT_DIR}`,
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${PROJECT_NAME} ${SERVER_INFO.version}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  // 配置错误优先于 --check：拼错工具名时不能只报告其余配置正常。
  if (ENABLED_TOOLS.error) {
    log(ENABLED_TOOLS.error);
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--check")) {
    process.stdout.write(`${checkReport()}\n`);
    if (!API_KEY) process.exitCode = 1;
    return;
  }
  if (!API_KEY) log("警告：未找到 DeepSeek API Key，工具调用会失败");
  log(`启动 ${SERVER_INFO.name}@${SERVER_INFO.version} → ${API_BASE}`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) void handleLine(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

void main();