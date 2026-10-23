// A scripted MCP client for any endpoint: checks the handshake, the tools and memory across sessions,
// and times each call. Prints one JSON line per step.
//
//   node scripts/smoke.mjs http://127.0.0.1:8787/mcp
//   MCP_TOKEN=... MCP_SHOP_HEADER=X-Amzn-Bedrock-AgentCore-Runtime-Custom-Shop node scripts/smoke.mjs "<AgentCore URL>"

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = new URL(process.argv[2] || "http://127.0.0.1:8787/mcp");
const shop = process.env.MCP_SHOP || `smoke-${Date.now().toString(36)}`;
const headers = { [process.env.MCP_SHOP_HEADER || "x-imali-shop"]: shop };
if (process.env.MCP_TOKEN) headers.authorization = `Bearer ${process.env.MCP_TOKEN}`;

const out = (step, data) => console.log(JSON.stringify({ step, ...data }));
const timed = async (step, fn) => {
  const t0 = performance.now();
  const r = await fn();
  out(step, { ms: Math.round(performance.now() - t0), ...(r && typeof r === "object" && !Array.isArray(r) ? r : { r }) });
  return r;
};

async function session(label) {
  const client = new Client({ name: "imali-smoke", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    out(`${label}:elicitation`, { message: req.params.message });
    return { action: "accept", content: { confirm: true, payment: "on_account" } };
  });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await timed(`${label}:initialize`, async () => {
    await client.connect(transport);
    return { protocolVersion: transport.protocolVersion, server: client.getServerVersion()?.name, session: transport.sessionId?.slice(0, 8) };
  });
  return { client, transport };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then((r) => r.structuredContent);

const a = await session("first");
await timed("first:tools/list", async () => ({ tools: (await a.client.listTools()).tools.length }));
await timed("first:record_sale", async () => {
  const r = await call(a.client, "record_sale", { items: [{ item: "bread", qty: 3 }, { item: "cooking oil", qty: 2 }], payment: "cash" });
  return { ok: r.ok, amount: r.entry?.amount, balanced: r.entry?.balanced, speech: r.speech };
});
await timed("first:credit_sale", async () => {
  const r = await call(a.client, "record_sale", { items: [{ item: "sugar", qty: 2 }, { item: "maize meal", qty: 1 }], payment: "credit", customer: "Mai Tendai" });
  return { ok: r.ok, speech: r.speech };
});
await timed("first:reorder_stock", async () => {
  const r = await call(a.client, "reorder_stock", {});
  return { status: r.order?.status, total: r.order?.total, speech: r.speech };
});
await a.client.close();

const b = await session("second");
await timed("second:get_customer_tabs", async () => ({ speech: (await call(b.client, "get_customer_tabs", { customer: "Mai Tendai" })).speech }));
await timed("second:close_day", async () => {
  const r = await call(b.client, "close_day", { counted_cash: 52 });
  return { expected: r.expected, difference: r.difference, speech: r.speech };
});
await timed("second:journal", async () => {
  const j = JSON.parse((await b.client.readResource({ uri: "imali-ai://books/journal" })).contents[0].text);
  return { entries: j.entries.length, trial_balance: j.trial_balance };
});
await b.client.close();
out("done", { shop });
