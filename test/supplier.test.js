// The supplier network on its own, and what the books server does when the supplier cannot be reached.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http.js";
import { MemoryStore } from "../src/store.js";
import { quote } from "../src/supplier.js";

async function serve(env) {
  const app = createApp({ store: new MemoryStore(), env: { SERVE_WEB: "0", ...env }, log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  return { base: `http://127.0.0.1:${app.server.address().port}`, stop };
}

async function client(url, shop, elicit) {
  const c = new Client({ name: "t", version: "1" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) c.setRequestHandler((await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema, elicit);
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { "x-imali-shop": shop } } }));
  return c;
}

test("a quote fills what the supplier has and prices it", () => {
  const q = quote("Kudzai Wholesale", [{ item: "candles-6", qty: 6 }, { item: "sugar-2kg", qty: 10 }, { item: "bread", qty: 5 }]);
  assert.equal(q.lines[0].qty, 4);
  assert.equal(q.lines[1].total, 2050);
  assert.equal(q.lines[2].note, "not stocked");
  assert.equal(q.total, 360 + 2050);
});

test("the supplier server places an order once per purchase order number", async () => {
  const { base, stop } = await serve({});
  const c = await client(`${base}/supplier/mcp`, "t-supplier");
  const args = { supplier: "Harare Bakery", lines: [{ item: "bread", qty: 20 }], buyer_reference: "PO-0007" };
  const first = (await c.callTool({ name: "place_order", arguments: args })).structuredContent;
  const again = (await c.callTool({ name: "place_order", arguments: args })).structuredContent;
  assert.equal(first.order_id, "HB-1001");
  assert.equal(again.order_id, "HB-1001");
  assert.match(again.speech, /already has PO-0007/);
  await c.close();
  await stop();
});

test("if the supplier cannot be reached, the order stays in the books and the owner is told", async () => {
  const { base, stop } = await serve({ SUPPLIER_MCP_URL: "http://127.0.0.1:9/mcp" });
  const c = await client(`${base}/mcp`, "t-offline", async () => ({ action: "accept", content: { confirm: true } }));
  const r = (await c.callTool({ name: "reorder_stock", arguments: {} })).structuredContent;
  assert.equal(r.order.status, "confirmed");
  assert.match(r.warnings[0], /did not answer, so the order is in your books only/);
  await c.close();
  await stop();
});
