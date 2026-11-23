// 零成本端到端：本地 mock /v1/tools/{search,fetch}，验证参数、去重、合并、计费与 offset 续读。
// 用法：node mock-api.mjs <server.mjs>
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const serverPath = process.argv[2];
if (!serverPath) throw new Error("用法：node mock-api.mjs <server.mjs>");

const LONG = "0123456789".repeat(150); // 1500 字符
const TEN_URLS = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);

let rateLimitHits = 0;
const requests = [];

function searchResponse(query) {
  if (query === "empty") return { results: [] };
  if (query === "error200") return { error: { message: "mock upstream failure" } };
  if (query === "badurl") {
    return {
      results: [
        { title: "bad", url: "not-a-url", rerank_score: 1 },
        { title: "good", url: "https://example.com/a", rerank_score: 1, summary: "good summary" },
      ],
    };
  }
  if (query === "dup-a") {
    return { results: [{ title: "Dup", url: "https://example.com/dup", rerank_score: 1.1, authority: -1, summary: "short" }] };
  }
  if (query === "dup-b") {
    return {
      results: [{
        title: "Dup",
        url: "https://example.com/dup/",
        rerank_score: 2.2,
        authority: 4,
        summary: "a much longer summary",
        snippet: "snippet-b",
        content: "content-b",
      }],
    };
  }
  if (query === "rate") {
    rateLimitHits += 1;
    if (rateLimitHits === 1) {
      return { __status: 429, __headers: { "Retry-After": "0" }, error: { message: "rate limited" } };
    }
    return { results: [{ title: "Rate", url: "https://example.com/rate", rerank_score: 2 }] };
  }
  return { results: [{ title: `T ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, rerank_score: 1.5, summary: `summary ${query}` }] };
}

function fetchResponse(url) {
  if (url === "https://example.com/long") return { title: "Long", content: LONG };
  if (url === "https://example.com/ellipsis") return { title: "Ellipsis", content: "abc…" };
  if (url === "https://example.com/cache") return { title: "Cache", content: "cache content" };
  if (url === "https://example.com/403") return { __status: 403, error: { message: "URL access denied (request_id: mock)" } };
  if (url === "https://example.com/error200") return { error: { message: "mock fetch failure" } };
  if (url === "https://example.com/empty") return { title: "", content: "" };
  if (url.startsWith("https://example.com/p")) {
    const index = Number(url.slice(-1));
    return { title: `P${index}`, content: `${index}:` + "x".repeat(4999) };
  }
  return { title: "", content: `content for ${url}` };
}

const server = createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { __parseError: raw }; }
    requests.push({ path: req.url, body, headers: req.headers });
    if (req.url === "/v1/tools/tts") {
      const audio = Buffer.alloc(64, 1);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length });
      res.end(audio);
      return;
    }
    const spec = req.url === "/v1/tools/search"
      ? searchResponse(body.query)
      : req.url === "/v1/tools/fetch"
        ? fetchResponse(body.url)
        : { __status: 404, error: { message: "unknown path" } };
    const { __status, __headers, ...payload } = spec;
    res.writeHead(__status ?? 200, { "Content-Type": "application/json", ...(__headers ?? {}) });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DEEPSEEK_API_BASE: base,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_ALLOWED_DIRS: "",
      ...env,
    },
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  child.stderr.resume();
  let id = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = id++;
      const timer = setTimeout(() => {
        waiting.delete(myId);
        reject(new Error(`${method} 超时`));
      }, 15_000);
      waiting.set(myId, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  return { child, call, stop: () => { child.stdin.end(); } };
}

const { child, call, stop } = startServer();
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};
const txt = (response) => response.result?.content?.[0]?.text ?? JSON.stringify(response.error);
const isErr = (response) => response.result?.isError === true;
const search = (args) => call("tools/call", { name: "deepseek_search", arguments: args });
const fetchPages = (args) => call("tools/call", { name: "deepseek_fetch", arguments: args });

function bodyOf(text) {
  const lines = text.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("标题："));
  if (titleIndex < 0) return "";
  const end = lines.findIndex((line, index) => index > titleIndex && (line.startsWith("（已截断") || line.startsWith("本次按")));
  return lines.slice(titleIndex + 1, end < 0 ? undefined : end).join("\n").replace(/\n+$/, "");
}

console.log("\n【工具清单与标注】");
const tools = (await call("tools/list", {})).result.tools;
ok("返回 5 个工具", tools.length === 5, String(tools.length));
const searchTool = tools.find((tool) => tool.name === "deepseek_search");
const ttsTool = tools.find((tool) => tool.name === "deepseek_tts");
ok("search 标注 readOnly/openWorld", searchTool?.annotations?.readOnlyHint === true && searchTool?.annotations?.openWorldHint === true);
ok("tts 标注可写", ttsTool?.annotations?.readOnlyHint === false);
ok("tts 暴露 output_path", Boolean(ttsTool?.inputSchema?.properties?.output_path));

console.log("\n【搜索：重复查询与跨查询合并】");
const dedupe = await search({ queries: ["same", " same ", "same"], count: 2 });
ok("重复查询只发一次请求", requests.filter((r) => r.path === "/v1/tools/search" && r.body.query === "same").length === 1);
ok("输出标注合并数量", txt(dedupe).includes("已合并 2 条重复查询"), txt(dedupe).split("\n")[0]);

const merge = await search({ queries: ["dup-a", "dup-b"] });
const mergeText = txt(merge);
ok("跨查询 URL 去重", mergeText.includes("去重后 1 条结果"), mergeText.split("\n")[0]);
ok("冲突分数取最高", mergeText.includes("score 2.20"), mergeText);
ok("摘要取更长的一份", mergeText.includes("a much longer summary"));
ok("标注命中 2 个查询", mergeText.includes("命中 2 个查询"));
ok("按 2 次成功请求计费", mergeText.includes("按 2 次成功请求计费"), mergeText.split("\n")[1]);

console.log("\n【搜索：参数透传与本地校验】");
const params = await search({
  queries: ["capture"],
  count: 3,
  need_content: true,
  ori_question: "原始问题",
  localization: "1.2.3.4",
  max_summary_chars: 300,
});
const capturedRequest = requests.at(-1);
const captured = capturedRequest.body;
ok("count 透传", captured.count === 3, JSON.stringify(captured));
ok("need_content 透传", captured.need_content === true);
ok("ori_question 透传", captured.ori_question === "原始问题");
ok("localization 透传", captured.localization === "1.2.3.4");
ok("请求带 User-Agent", String(capturedRequest.headers["user-agent"] ?? "").startsWith("deepseek-tool-apis-mcp/"), capturedRequest.headers["user-agent"]);
ok("合法参数调用成功", !isErr(params));

const beforeIp = requests.length;
const badIp = await search({ queries: ["x"], localization: "not-an-ip" });
ok("非法 IP 本地拒绝", isErr(badIp) && txt(badIp).includes("合法 IP"), txt(badIp));
ok("非法 IP 不产生请求", requests.length === beforeIp);

const badQuestion = await search({ queries: ["x"], ori_question: "字".repeat(129) });
ok("ori_question 超长本地拒绝", isErr(badQuestion) && txt(badQuestion).includes("超过 128 个字符"), txt(badQuestion));
ok("超长 ori_question 不产生请求", requests.length === beforeIp);

console.log("\n【搜索：错误与重试】");
const error200 = await search({ queries: ["error200"] });
ok("HTTP 200 夹带 error 时标失败", isErr(error200), JSON.stringify(error200.result));
ok("保留上游错误信息", txt(error200).includes("mock upstream failure"), txt(error200));
ok("不误报为无结果", !txt(error200).includes("无结果（无结果不计费）"));

const rate = await search({ queries: ["rate"] });
ok("429 后自动重试成功", !isErr(rate) && txt(rate).includes("https://example.com/rate"), txt(rate));
ok("429 确实重试了一次", rateLimitHits === 2, `rateLimitHits=${rateLimitHits}`);

const badUrl = await search({ queries: ["badurl"] });
ok("丢弃非法结果 URL 并计数", txt(badUrl).includes("丢弃 1 条无效 URL"), txt(badUrl).split("\n")[0]);
ok("同批合法结果仍返回", txt(badUrl).includes("https://example.com/a"));

const empty = await search({ queries: ["empty"] });
ok("无结果标失败且计费为 0", isErr(empty) && txt(empty).includes("按 0 次成功请求计费"), txt(empty));

console.log("\n【缓存】");
const cacheFirst = await search({ queries: ["cache-me"] });
const afterFirstSearch = requests.length;
const cacheSecond = await search({ queries: ["cache-me"] });
ok("重复搜索不再请求", requests.length === afterFirstSearch);
ok("首次搜索正常计费", txt(cacheFirst).includes("1 次成功请求计费"), txt(cacheFirst).split("\n")[1]);
ok("缓存命中标 0 计费", txt(cacheSecond).includes("0 次成功请求计费") && txt(cacheSecond).includes("命中缓存"), txt(cacheSecond).split("\n")[1]);

const CACHE_URL = "https://example.com/cache";
await fetchPages({ urls: [CACHE_URL] });
const afterFirstFetch = requests.length;
const fetchCached = await fetchPages({ urls: [CACHE_URL] });
ok("重复抓取不再请求", requests.length === afterFirstFetch);
ok("缓存抓取有标记且 0 计费", txt(fetchCached).includes("（缓存）") && txt(fetchCached).includes("0 次成功抓取计费"), txt(fetchCached));

console.log("\n【抓取：offset 续读】");
const first = await fetchPages({ urls: ["https://example.com/long"], max_chars: 800 });
const firstText = txt(first);
const hint = firstText.match(/续读用 offset: (\d+)/);
ok("截断时给出 offset", Boolean(hint), firstText.slice(-120));
const firstBody = bodyOf(firstText);
const second = await fetchPages({ urls: ["https://example.com/long"], max_chars: 800, offset: Number(hint?.[1] ?? 0) });
const secondBody = bodyOf(txt(second));
// 第一段末尾的省略号是截断标记，不属于正文。
const firstContent = firstBody.endsWith("…") ? firstBody.slice(0, -1) : firstBody;
ok("两段正文拼接等于原文", firstContent + secondBody === LONG, `first=${firstBody.length} second=${secondBody.length}`);
ok("第二次不再截断", !txt(second).includes("续读用 offset"));
ok("offset 续读命中缓存，不重复抓取",
  requests.filter((request) => request.path === "/v1/tools/fetch" && request.body.url === "https://example.com/long").length === 1);

const ellipsis = await fetchPages({ urls: ["https://example.com/ellipsis"], max_chars: 500 });
ok("正文本身以省略号结尾不误报截断", !txt(ellipsis).includes("已截断"), txt(ellipsis));

console.log("\n【抓取：预算均摊与错误路径】");
const ten = await fetchPages({ urls: TEN_URLS, max_chars: 6000 });
const tenText = txt(ten);
ok("10 个长页面全部有正文", TEN_URLS.every((url) => tenText.includes(`## ${url}`)), tenText.split("\n")[0]);
ok("没有页面因预算被整段丢弃", !tenText.includes("未显示"));
ok("按 10 次成功抓取计费", tenText.includes("按 10 次成功抓取计费"), tenText.split("\n").at(-2));

const forbidden = await fetchPages({ urls: ["https://example.com/403"] });
ok("403 标失败并保留原因", isErr(forbidden) && txt(forbidden).includes("URL access denied"), txt(forbidden));

const fetchError200 = await fetchPages({ urls: ["https://example.com/error200"] });
ok("抓取 200 夹带 error 时标失败", isErr(fetchError200) && txt(fetchError200).includes("mock fetch failure"), txt(fetchError200));

const emptyPage = await fetchPages({ urls: ["https://example.com/empty"] });
ok("空正文不计费", isErr(emptyPage) && txt(emptyPage).includes("按 0 次成功抓取计费"), txt(emptyPage));

const mixed = await fetchPages({ urls: ["https://example.com/403", "https://example.com/long"] });
ok("批内部分失败仍返回成功结果", !isErr(mixed) && txt(mixed).includes("## https://example.com/long（缓存）") && txt(mixed).includes("按 0 次成功抓取计费"), txt(mixed));

const beyond = await fetchPages({ urls: ["https://example.com/long"], offset: 999999 });
ok("offset 越界给提示而非报错", !isErr(beyond) && txt(beyond).includes("超出正文长度"), txt(beyond));

console.log("\n【TTS 输出路径】");
const ttsPath = join(tmpdir(), `ds-mcp-tts-${Date.now()}.wav`);
const tts = await call("tools/call", { name: "deepseek_tts", arguments: { text: "hello", output_path: ttsPath } });
ok("自定义 output_path 成功", !isErr(tts) && txt(tts).includes(ttsPath), txt(tts));
ok("音频文件已写入", (await stat(ttsPath)).size === 64);
const ttsRequestsBefore = requests.filter((request) => request.path === "/v1/tools/tts").length;
const ttsAgain = await call("tools/call", { name: "deepseek_tts", arguments: { text: "hello", output_path: ttsPath } });
ok("拒绝覆盖已存在文件", isErr(ttsAgain) && txt(ttsAgain).includes("已存在"), txt(ttsAgain));
ok("路径冲突时不发计费请求", requests.filter((request) => request.path === "/v1/tools/tts").length === ttsRequestsBefore);
const ttsBadExt = await call("tools/call", { name: "deepseek_tts", arguments: { text: "hello", output_path: join(tmpdir(), "ds-mcp-bad.mp3") } });
ok("拒绝扩展名不匹配", isErr(ttsBadExt) && txt(ttsBadExt).includes("扩展名"), txt(ttsBadExt));
await rm(ttsPath, { force: true });

stop();

console.log("\n【缺少 API Key：只报一次错】");
const noKey = startServer({ DEEPSEEK_API_KEY: "" });
await noKey.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });
const beforeKey = requests.length;
const noKeyCall = await noKey.call("tools/call", { name: "deepseek_search", arguments: { queries: ["a", "b"] } });
const noKeyText = txt(noKeyCall);
ok("缺 Key 时标失败", isErr(noKeyCall));
ok("只出现一次 Key 错误", (noKeyText.match(/API Key 不可用/g) ?? []).length === 1, noKeyText);
ok("缺 Key 时不发请求", requests.length === beforeKey);
noKey.stop();

console.log("\n【不读取供应商配置】");
const providerConfigPath = join(tmpdir(), `ds-mcp-provider-${Date.now()}.json`);
await writeFile(providerConfigPath, JSON.stringify({
  config: {
    providerConfigRules: {
      providerRules: [
        {
          config: {
            api: { baseUrl: "https://api.deepseek.com" },
            access: { apiKey: "key-from-provider-config" },
          },
        },
      ],
    },
  },
}));
const providerOnly = startServer({ DEEPSEEK_API_KEY: "", DEEPSEEK_PROVIDER_CONFIG: providerConfigPath });
await providerOnly.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });
const beforeProvider = requests.length;
const providerCall = await providerOnly.call("tools/call", { name: "deepseek_search", arguments: { queries: ["stale"] } });
ok("只有 provider 配置时仍报 Key 缺失", isErr(providerCall) && txt(providerCall).includes("API Key 不可用"), txt(providerCall));
ok("不读取 provider 配置中的 Key", requests.length === beforeProvider);
providerOnly.stop();
await rm(providerConfigPath, { force: true });

console.log("\n【工具启停】");
const limited = startServer({ DEEPSEEK_ENABLED_TOOLS: "search" });
const limitedInit = await limited.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });
ok("instructions 只描述启用的工具", !String(limitedInit.result.instructions).includes("deepseek_fetch"), limitedInit.result.instructions);
const limitedTools = (await limited.call("tools/list", {})).result.tools;
ok("白名单只暴露已启用工具",
  limitedTools.length === 1 && limitedTools[0].name === "deepseek_search",
  limitedTools.map((tool) => tool.name).join(","));
const beforeDisabled = requests.length;
const disabledCall = await limited.call("tools/call", { name: "deepseek_fetch", arguments: { urls: ["https://example.com/long"] } });
ok("调用被禁用工具返回明确错误", isErr(disabledCall) && txt(disabledCall).includes("DEEPSEEK_ENABLED_TOOLS"), txt(disabledCall));
ok("被禁用工具不产生 API 请求", requests.length === beforeDisabled);
const enabledSearch = await limited.call("tools/call", { name: "deepseek_search", arguments: { queries: ["limited"] } });
ok("白名单内工具仍可用", !isErr(enabledSearch) && txt(enabledSearch).includes("https://example.com/limited"), txt(enabledSearch));
limited.stop();

server.close();

console.log("\n【CLI】");
const cliEnv = { ...process.env, DEEPSEEK_API_KEY: "test-key" };
const versionOut = await execFileAsync(process.execPath, [serverPath, "--version"], { env: cliEnv });
ok("--version 输出版本", versionOut.stdout.includes("deepseek-tool-apis-mcp 1.0.0"), versionOut.stdout.trim());
const helpOut = await execFileAsync(process.execPath, [serverPath, "--help"], { env: cliEnv });
ok("--help 列出缓存变量", helpOut.stdout.includes("DEEPSEEK_SEARCH_CACHE_TTL_MS"));
const checkOut = await execFileAsync(process.execPath, [serverPath, "--check"], { env: cliEnv });
ok("--check 报告 key 已配置", checkOut.stdout.includes("api_key: 已配置"), checkOut.stdout);
try {
  await execFileAsync(process.execPath, [serverPath, "--check"], {
    env: { ...cliEnv, DEEPSEEK_API_KEY: "" },
  });
  fails.push("--check 缺 Key 应退出 1");
  console.log("  ✗ --check 缺 Key 应退出 1 — 实际退出 0");
} catch (error) {
  ok("--check 缺 Key 退出 1 并提示缺失", error.code === 1 && String(error.stdout).includes("缺失"), `code=${error.code}`);
}

const enabledCheck = await execFileAsync(process.execPath, [serverPath, "--check"], {
  env: { ...cliEnv, DEEPSEEK_ENABLED_TOOLS: "search,fetch" },
});
ok("--check 报告启用的工具", enabledCheck.stdout.includes("enabled_tools: search,fetch"), enabledCheck.stdout);
try {
  await execFileAsync(process.execPath, [serverPath, "--check"], {
    env: { ...cliEnv, DEEPSEEK_ENABLED_TOOLS: "serch" },
  });
  fails.push("未知工具名应启动失败");
  console.log("  ✗ 未知工具名应启动失败 — 实际退出 0");
} catch (error) {
  ok("未知工具名启动失败并列出可选值",
    error.code === 1 && String(error.stderr).includes("未知工具") && String(error.stderr).includes("search"),
    `code=${error.code} stderr=${String(error.stderr).trim()}`);
}

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log("失败项：", fails.join("、"));
  process.exitCode = 1;
}
