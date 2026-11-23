// MCP 协议层健壮性：并发乱序、通知无响应、畸形输入、参数校验。全程不发外部请求。
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [process.argv[2]], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_API_BASE: "http://127.0.0.1:1",
  },
});
let buffer = "";
const seen = [];
const waiting = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    seen.push(msg);
    if (msg.id !== null && msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => process.stderr.write(c));

let id = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const myId = id++;
    waiting.set(myId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
  });
const raw = (line) => child.stdin.write(`${line}\n`);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\n【协议协商】");
for (const v of ["2025-06-18", "2025-03-26", "2024-11-05", "1999-01-01", undefined]) {
  const r = await call("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "p", version: "1" } });
  const got = r.result?.protocolVersion;
  const expect = v === "1999-01-01" || v === undefined ? "2025-06-18" : v;
  ok(`protocolVersion=${v ?? "(缺省)"} → ${got}`, got === expect, `期望 ${expect}`);
}
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "1" } });
ok("声明 tools 能力", Boolean(init.result?.capabilities?.tools));
ok("带 instructions", typeof init.result?.instructions === "string");
ok("serverInfo 使用新名称", init.result?.serverInfo?.name === "deepseek-tool-apis", JSON.stringify(init.result?.serverInfo));

console.log("\n【并发乱序】");
const t0 = Date.now();
const batch = await Promise.all([
  call("ping", {}),
  call("tools/list", {}),
  call("tools/call", { name: "deepseek_search", arguments: { queries: [] } }),
  call("tools/list", {}),
  call("ping", {}),
]);
ok("5 个并发请求全部有响应", batch.every((r) => r && (r.result || r.error)));
ok("ping 返回空对象", JSON.stringify(batch[0].result) === "{}" && JSON.stringify(batch[4].result) === "{}");
ok("tools/list 两次一致", JSON.stringify(batch[1].result) === JSON.stringify(batch[3].result));
ok("并发调用的参数错误被正常返回", batch[2].result?.isError === true, JSON.stringify(batch[2].result));
ok("乱序响应不串号", seen.every((m) => m.jsonrpc === "2.0"));
console.log(`    并发耗时 ${Date.now() - t0} ms，收到 ${seen.length} 条响应`);

console.log("\n【通知与畸形输入】");
const before = seen.length;
raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } }));
await new Promise((r) => setTimeout(r, 300));
ok("通知不回响应（无 id）", seen.length === before, `多出 ${seen.length - before} 条`);

raw("{ not valid json ");
await new Promise((r) => setTimeout(r, 200));
const parseErr = seen.at(-1);
ok("非法 JSON → -32700", parseErr?.error?.code === -32700, JSON.stringify(parseErr));

raw(JSON.stringify({ jsonrpc: "2.0", id: 9001 }));
await new Promise((r) => setTimeout(r, 200));
ok("缺 method → -32600", seen.at(-1)?.error?.code === -32600, JSON.stringify(seen.at(-1)));

const unknown = await call("resources/list", {});
ok("未实现方法 → -32601", unknown.error?.code === -32601, JSON.stringify(unknown.error));

const badTool = await call("tools/call", { name: "nope", arguments: {} });
ok("未知工具 → -32602", badTool.error?.code === -32602, JSON.stringify(badTool.error));

const noArgs = await call("tools/call", { name: "deepseek_search" });
ok("缺 arguments 参数体不崩", noArgs.result?.isError === true, JSON.stringify(noArgs.result));

const wrongType = await call("tools/call", { name: "deepseek_search", arguments: { queries: "单个字符串" } });
ok("queries 传字符串被拒绝", wrongType.result?.isError === true);

const badFetch = await call("tools/call", { name: "deepseek_fetch", arguments: { urls: ["not-a-url"] } });
ok("非法 URL 在发请求前被拒", badFetch.result?.isError === true && String(badFetch.result?.content?.[0]?.text).includes("不是合法 URL"));

console.log("\n【并发不串号·乱序大压力】");
const many = await Promise.all(
  Array.from({ length: 12 }, (_, i) => call("ping", { seq: i })),
);
ok("12 个 ping 全部返回", many.length === 12 && many.every((r) => r.result));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log("失败项：", fails.join("、"));
  process.exitCode = 1;
}
child.stdin.end();
