// 真实接口冒烟：Search 1 次 + Fetch 1 次，约 ¥0.01。不会在 npm test 中运行。
// 用法：DEEPSEEK_API_KEY=sk-... npm run test:live
import { spawn } from "node:child_process";

const serverPath = process.argv[2];
if (!serverPath) throw new Error("用法：node live-smoke.mjs <server.mjs>");
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("未设置 DEEPSEEK_API_KEY，真实接口冒烟会失败。");
}

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
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
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let id = 1;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = id++;
    const timer = setTimeout(() => {
      waiting.delete(myId);
      reject(new Error(`${method} 超时`));
    }, 90_000);
    waiting.set(myId, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
  });

const txt = (response) => response.result?.content?.[0]?.text ?? JSON.stringify(response.error);
const isErr = (response) => response.result?.isError === true;
const yuanOf = (text) => {
  const match = text.match(/约 ¥([\d.]+)/);
  return match ? Number(match[1]) : 0;
};

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-smoke", version: "1" } });
ok("initialize 成功", init.result?.serverInfo?.name === "deepseek-tool-apis", JSON.stringify(init.result?.serverInfo));
const tools = await call("tools/list", {});
ok("tools/list 返回 5 个工具", tools.result?.tools?.length === 5);

const search = await call("tools/call", {
  name: "deepseek_search",
  arguments: { queries: ["DeepSeek API documentation"], count: 2 },
});
const searchText = txt(search);
ok("真实搜索成功", !isErr(search) && searchText.includes("https://"), searchText.slice(0, 200));
ok("搜索结果带计费行", searchText.includes("本次按 1 次成功请求计费"));

const fetched = await call("tools/call", {
  name: "deepseek_fetch",
  arguments: { urls: ["https://example.com"], max_chars: 500 },
});
const fetchText = txt(fetched);
ok("真实抓取成功", !isErr(fetched) && fetchText.includes("Example Domain"), fetchText.slice(0, 200));
ok("抓取结果带计费行", fetchText.includes("本次按 1 次成功抓取计费"));

const cost = yuanOf(searchText) + yuanOf(fetchText);
console.log(`\n本次真实冒烟费用：约 ¥${cost.toFixed(4)}`);
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log("失败项：", fails.join("、"));
  process.exitCode = 1;
}
child.stdin.end();
