// 纯函数单测：把 server.mjs 的 main() 摘掉后当模块导入，只测不花接口费的部分。
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const source = readFileSync(process.argv[2], "utf8");
if (!source.includes("void main();")) throw new Error("未找到 void main(); 无法构造可导入副本");
const tmp = join(dirname(fileURLToPath(import.meta.url)), "_server.unit.mjs");
writeFileSync(
  tmp,
  source.replace(/\nvoid main\(\);\s*$/, "\n") +
    "\nexport { normalizeUrl, countBilledChars, clampInt, clip, parsePageRange, validateFetchUrl, requireQueries, requireUrls, formatOcrResult, slicePages, retryDelayMs, isInsideDirs, yuan, PRICE, uniqueQueries, parseOriQuestion, parseLocalization, mergeSearchItem, assertNoApiError, createCache, expandHome, parseEnabledTools, decodeSourceBase64, sourceFileName, isPrivateIp };\n",
);
const m = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};
const throws = (label, fn, expect) => {
  try { fn(); fails.push(label); console.log(`  ✗ ${label} — 未抛出`); }
  catch (e) {
    const good = e.message.includes(expect);
    if (good) { pass += 1; console.log(`  ✓ ${label}`); }
    else { fails.push(label); console.log(`  ✗ ${label} — 信息不符: ${e.message}`); }
  }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)}`);

console.log("\n【normalizeUrl】");
eq("host/scheme 小写、path 保留大小写、去 hash、去尾斜杠",
  m.normalizeUrl("HTTPS://Example.COM/Path/A/?q=1#frag"), "https://example.com/Path/A?q=1");
ok("不同大小写的 path 不再被合并",
  m.normalizeUrl("https://x.com/Path") !== m.normalizeUrl("https://x.com/path"));
eq("尾斜杠归一", m.normalizeUrl("https://x.com/a/"), m.normalizeUrl("https://x.com/a"));
eq("非 http(s) 丢弃", m.normalizeUrl("ftp://x.com/a"), "");
eq("非法 URL 丢弃", m.normalizeUrl("not a url"), "");

console.log("\n【countBilledChars】");
eq("你好，世界 → 9", m.countBilledChars("你好，世界"), 9);
eq("中文标点只算 1：（）、。 → 4", m.countBilledChars("（）、。"), 4);
eq("ASCII 算 1：abc → 3", m.countBilledChars("abc"), 3);
eq("emoji 算 1", m.countBilledChars("🙂"), 1);
eq("5000 汉字 → 10000（上限内）", m.countBilledChars("汉".repeat(5000)), 10000);
eq("5001 汉字 → 10002（超限）", m.countBilledChars("汉".repeat(5001)), 10002);
eq("4000 汉字 + 1500 标点 → 9500（旧实现会错判成 11000）", m.countBilledChars("汉".repeat(4000) + "、".repeat(1500)), 9500);

console.log("\n【clampInt】");
eq("999 → 50", m.clampInt(999, 1, 50, 8), 50);
eq("0 → 1", m.clampInt(0, 1, 50, 8), 1);
eq("非整数走 fallback", m.clampInt(1.5, 1, 50, 8), 8);
eq("undefined 走 fallback", m.clampInt(undefined, 1, 50, 8), 8);

console.log("\n【clip 代理对】");
const emojiClip = m.clip("🙂🙂🙂", 4);
eq("limit=4 不切出半个 emoji", emojiClip, "🙂…");
ok("输出无孤立 surrogate", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiClip), emojiClip);
eq("未超限时原样返回", m.clip("🙂", 8), "🙂");

console.log("\n【parsePageRange】");
eq("正常 [3,7]", m.parsePageRange([3, 7]), { from: 3, to: 7 });
eq("缺省为 null", m.parsePageRange(undefined), null);
throws("起始 > 结束", () => m.parsePageRange([7, 3]), "不能大于");
throws("页码 0", () => m.parsePageRange([0, 3]), "从 1 起");
throws("超过 1000 页上限", () => m.parsePageRange([1, 1001]), "页数上限");
throws("非整数", () => m.parsePageRange(["1", 3]), "两个整数");

console.log("\n【validateFetchUrl】");
ok("普通 https 通过", m.validateFetchUrl("https://example.com/a") === "https://example.com/a");
throws("拒绝 ftp", () => m.validateFetchUrl("ftp://example.com/a"), "只支持 HTTP/HTTPS");
throws("拒绝带凭据", () => m.validateFetchUrl("https://u:p@example.com/a"), "用户名或密码");
throws("拒绝非 URL", () => m.validateFetchUrl("example.com/a"), "不是合法 URL");
throws("拒绝超长", () => m.validateFetchUrl(`https://x.com/${"a".repeat(8200)}`), "8192");

console.log("\n【查询与 URL 批处理】");
throws("空 queries", () => m.requireQueries({ queries: [] }), "至少一个");
throws("超过 10 条 queries", () => m.requireQueries({ queries: Array(11).fill("a") }), "最多 10 条");
throws("单条查询超 128 字符", () => m.requireQueries({ queries: ["字".repeat(129)] }), "128 个字符");
eq("128 汉字查询通过（按码点计）", m.requireQueries({ queries: ["字".repeat(128)] }).length, 1);
eq("重复查询按 trim 后去重且保序", m.uniqueQueries(m.requireQueries({ queries: ["a", " a ", "b", "a"] })), ["a", "b"]);
throws("批内含一个坏 URL 时整批拒绝", () => m.requireUrls({ urls: ["https://ok.com", "ftp://bad.com"] }), "只支持 HTTP/HTTPS");
throws("超过 10 条 urls", () => m.requireUrls({ urls: Array(11).fill("https://a.com") }), "最多 10 条");

console.log("\n【ori_question / localization】");
eq("ori_question 缺省为空", m.parseOriQuestion(undefined), "");
eq("ori_question 128 汉字通过", [...m.parseOriQuestion("字".repeat(128))].length, 128);
throws("ori_question 129 汉字拒绝", () => m.parseOriQuestion("字".repeat(129)), "超过 128 个字符");
throws("ori_question 非字符串拒绝", () => m.parseOriQuestion(1), "必须是字符串");
eq("localization IPv4 通过", m.parseLocalization("127.0.0.1"), "127.0.0.1");
eq("localization IPv6 通过", m.parseLocalization("::1"), "::1");
eq("localization 缺省为空", m.parseLocalization("  "), "");
throws("localization 非 IP 拒绝", () => m.parseLocalization("not-an-ip"), "合法 IP");
throws("localization 非字符串拒绝", () => m.parseLocalization(1), "字符串");

console.log("\n【createCache】");
let now = 1000;
const cache = m.createCache({ ttlMs: 100, maxEntries: 2, now: () => now });
cache.set("a", 1);
eq("未过期命中", cache.get("a"), 1);
now = 1100;
eq("到期后失效", cache.get("a"), undefined);
cache.set("a", 1);
cache.set("b", 2);
cache.set("c", 3);
eq("超出上限淘汰最旧项", cache.get("a"), undefined);
eq("保留最新项", cache.get("c"), 3);
eq("条数不超过上限", cache.size, 2);
const lru = m.createCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
lru.set("a", 1);
lru.set("b", 2);
lru.get("a");
lru.set("c", 3);
eq("命中会刷新 LRU 顺序", lru.get("b"), undefined);
eq("最近使用项仍保留", lru.get("a"), 1);
const disabled = m.createCache({ ttlMs: 0, maxEntries: 10, now: () => 0 });
disabled.set("x", 1);
eq("TTL=0 关闭缓存", disabled.size, 0);

console.log("\n【expandHome】");
const home = m.expandHome("~");
ok("~ 展开为 home", home !== "~" && home.length > 0, home);
ok("~/ 展开且去掉波浪号", m.expandHome("~/a.txt").startsWith(home) && m.expandHome("~/a.txt").endsWith("a.txt"), m.expandHome("~/a.txt"));
eq("普通路径原样返回", m.expandHome(process.platform === "win32" ? "C:\\docs\\a.pdf" : "/docs/a.pdf"), process.platform === "win32" ? "C:\\docs\\a.pdf" : "/docs/a.pdf");

console.log("\n【mergeSearchItem / assertNoApiError】");
const mergedItem = m.mergeSearchItem(
  { title: "t", url: "https://x.com/a", rerank_score: 1.2, authority: -1, summary: "short", snippet: "", content: "", date: null, site_name: null },
  { title: "t", url: "https://x.com/a", rerank_score: 2.4, authority: 4, summary: "much longer summary", snippet: "snip", content: "body", date: "2026-01-01T00:00:00Z", site_name: "X" },
);
eq("分数取最大值", mergedItem.rerank_score, 2.4);
eq("权威度取最大值（-1 不压过 4）", mergedItem.authority, 4);
eq("摘要取更长的一份", mergedItem.summary, "much longer summary");
eq("正文取更长的一份", mergedItem.content, "body");
eq("日期回退到有值的一份", mergedItem.date, "2026-01-01T00:00:00Z");
const noError = m.assertNoApiError({ results: [] });
eq("正常响应原样返回", noError.results.length, 0);
throws("HTTP 200 夹带 error 对象时抛错", () => m.assertNoApiError({ error: { message: "boom" } }), "boom");
throws("error 为字符串时抛错", () => m.assertNoApiError({ error: "bad" }), "bad");

console.log("\n【slicePages】");
const p52 = { page_count: 52, pages: Array.from({ length: 52 }, (_, i) => ({ index: i, text: `p${i}` })) };
const sliced = m.slicePages(p52, { from: 51, to: 60 });
eq("越界区间裁到末页", sliced.pages.length, 2);
eq("记录显示区间", sliced.shown_range, [51, 52]);
eq("保留总页数", sliced.total_pages, 52);
throws("起点超出总页数", () => m.slicePages(p52, { from: 99, to: 100 }), "超出文档页数");

console.log("\n【formatOcrResult 预算】");
const huge = { page_count: 1, purpose: "text_recognition", pages: [{ index: 0, text: "A".repeat(50000), finish_reason: "stop" }] };
const hugeOut = m.formatOcrResult(huge, 40000);
ok("单页 40000 字符不再整页丢弃", hugeOut.includes("AAAA") && hugeOut.length < 25000, `长度 ${hugeOut.length}`);
ok("单页超限给出截断提示", hugeOut.includes("输出预算用尽") && hugeOut.includes("page_range"));

const many = {
  page_count: 40,
  purpose: "text_recognition",
  pages: Array.from({ length: 40 }, (_, i) => ({ index: i, text: `第${i + 1}页` + "内".repeat(1500), finish_reason: "stop" })),
};
const manyOut = m.formatOcrResult(many, 4000);
ok("多页超预算时给出续读区间", /page_range: \[\d+, \d+\]/.test(manyOut));
ok("多页输出仍在预算内", manyOut.length <= 24000 + 200, `长度 ${manyOut.length}`);

const clipped = { page_count: 2, purpose: "text_recognition", pages: [{ index: 0, text: "x", finish_reason: "stop" }, { index: 1, text: "y", finish_reason: "length" }] };
ok("finish_reason=length 触发图纸页提示", m.formatOcrResult(clipped, 4000).includes("rich_layout_recognition"));

console.log("\n【retryDelayMs】");
eq("无响应时指数退避 400/800", [m.retryDelayMs(0), m.retryDelayMs(1)], [400, 800]);
eq("Retry-After 秒数优先", m.retryDelayMs(0, { headers: { get: () => "3" } }), 3000);
eq("Retry-After 上限 15s", m.retryDelayMs(0, { headers: { get: () => "600" } }), 15000);

console.log("\n【目录白名单 isInsideDirs】");
const ROOT = process.platform === "win32" ? "C:\\work" : "/work";
const inside = (p) => m.isInsideDirs(process.platform === "win32" ? p : p.replace(/\\/g, "/"), [ROOT]);
ok("根目录本身算在内", inside(ROOT));
ok("子目录算在内", inside(process.platform === "win32" ? "C:\\work\\a\\b.pdf" : "/work/a/b.pdf"));
ok("兄弟目录前缀不算（/work2 不匹配 /work）", !inside(process.platform === "win32" ? "C:\\work2\\a.pdf" : "/work2/a.pdf"));
ok("父目录不算", !inside(process.platform === "win32" ? "C:\\a.pdf" : "/a.pdf"));
ok("向上穿越不算", !inside(process.platform === "win32" ? "C:\\work\\..\\a.pdf" : "/work/../a.pdf"));
eq("空白名单 = 不限制（由调用方短路）", m.isInsideDirs("/anywhere", []), false);

console.log("\n【计费估算 yuan / PRICE】");
eq("单次搜索 0.005 元", m.yuan(m.PRICE.perRequest), "¥0.0050");
eq("52 页 OCR ≈ 0.078 元", m.yuan(52 * m.PRICE.perOcrPage), "¥0.0780");
eq("10000 计费字符 TTS ≈ 1.5 元", m.yuan(10000 * m.PRICE.perTtsChar), "¥1.5000");
eq("1 小时 ASR ≈ 0.39 元", m.yuan(m.PRICE.perAsrHour), "¥0.3900");
eq("0 次计费显示 ¥0.0000", m.yuan(0), "¥0.0000");
// OCR 单页比单次搜索便宜，但一份文档几十页，总价反超——成本来自页数而非单价。
ok("OCR 单页 < 单次 search", m.PRICE.perOcrPage < m.PRICE.perRequest,
  `OCR ${m.PRICE.perOcrPage} vs search ${m.PRICE.perRequest}`);
ok("52 页 OCR 总价远超单次 search", 52 * m.PRICE.perOcrPage > 10 * m.PRICE.perRequest);

console.log("\n【formatOcrResult 计费页数显示】");
const p1 = { page_count: 52, purpose: "text_recognition", pages: [{ index: 0, text: "x" }], total_pages: 52, shown_range: [1, 1] };
const out1 = m.formatOcrResult(p1, 4000);
ok("显示按 52 页计费（而非显示的 1 页）", out1.includes("本次按 52 页计费"), out1.split("\n")[1]);
ok("给出金额 ¥0.0780", out1.includes("¥0.0780"), out1.split("\n")[1]);

console.log("\n【parseEnabledTools】");
eq("未设置时全部启用", [...m.parseEnabledTools(undefined).names], ["search", "fetch", "ocr", "tts", "asr"]);
eq("只启用 search", [...m.parseEnabledTools("search").names], ["search"]);
eq("去空白与重复", [...m.parseEnabledTools(" search , search ,fetch ").names], ["search", "fetch"]);
ok("未知名称报错并列出可选值",
  m.parseEnabledTools("serch").error?.includes("未知工具") && m.parseEnabledTools("serch").error?.includes("search"));
ok("只有逗号视为空列表并报错", m.parseEnabledTools(",").error?.includes("未包含任何工具名"));
eq("合法配置无错误", m.parseEnabledTools("tts").error, null);

console.log("\n【sources 内联/远程文件】");
eq("纯 base64 解码", m.decodeSourceBase64(Buffer.from("abc", "utf8").toString("base64")).toString("utf8"), "abc");
eq("data URL base64 解码", m.decodeSourceBase64("data:application/pdf;base64," + Buffer.from("pdf").toString("base64")).toString("utf8"), "pdf");
throws("非法字符拒绝", () => m.decodeSourceBase64("@@@"), "不是合法 Base64");
throws("长度非 4 倍数拒绝", () => m.decodeSourceBase64("abc"), "不是合法 Base64");
eq("name 去掉路径只剩文件名", m.sourceFileName({ name: "../../evil/doc.pdf" }, ""), "doc.pdf");
eq("url 无 name 时取末段", m.sourceFileName({}, "https://x.com/a%20b.pdf"), "a b.pdf");
throws("无 name 且 url 无文件名拒绝", () => m.sourceFileName({}, "https://x.com/"), "name 必需");
ok("私网 IPv4 拒绝", m.isPrivateIp("192.168.1.1") === true);
ok("环回 IPv4 拒绝", m.isPrivateIp("127.0.0.1") === true);
ok("链路本地拒绝", m.isPrivateIp("169.254.169.254") === true);
ok("CGNAT 拒绝", m.isPrivateIp("100.64.0.1") === true);
ok("文档地址拒绝", m.isPrivateIp("203.0.113.9") === true);
ok("公网 IPv4 放行", m.isPrivateIp("1.1.1.1") === false);
ok("IPv6 环回拒绝", m.isPrivateIp("::1") === true);
ok("IPv6 唯一本地拒绝", m.isPrivateIp("fd00::1") === true);
ok("IPv6 链路本地拒绝", m.isPrivateIp("fe80::1") === true);
ok("IPv4-mapped IPv6 私网拒绝", m.isPrivateIp("::ffff:192.168.1.1") === true);
ok("非法 IP 视为不安全", m.isPrivateIp("garbage") === true);

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log("失败项：", fails.join("、"));
  process.exit(1);
}
