// End to end over real HTTP with the official MCP client: version negotiation, tools, structured output,
// MCP Apps resources, elicitation, and books that persist across sessions. No network beyond localhost.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/http.js";
import { FileStore } from "../src/store.js";

let app;
let base;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "imali-mcp-"));
  app = createApp({ store: new FileStore(dir), env: { SERVE_WEB: "0" }, log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

async function connect(shop, { elicit } = {}) {
  const client = new Client({ name: "imali-test", version: "1.0.0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "x-imali-shop": shop } } });
  await client.connect(transport);
  return { client, transport };
}

const call = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;

describe("Imali AI MCP server", () => {
  test("negotiates protocol 2025-11-25 over Streamable HTTP and lists its tools", async () => {
    const { client, transport } = await connect("t-handshake");
    assert.equal(transport.protocolVersion, "2025-11-25");
    assert.equal(client.getServerVersion().name, "imali-ai-shop-books");
    assert.match(client.getInstructions(), /Never work out or state a figure yourself/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of ["record_sale", "record_stock_received", "record_expense", "record_tab_payment", "record_supplier_payment", "get_day_summary", "get_customer_tabs", "get_stock", "close_day", "reorder_stock", "confirm_purchase_order", "undo_last_entry", "reset_demo_shop"]) assert.ok(names.includes(n), n);
    const sale = tools.find((t) => t.name === "record_sale");
    assert.equal(sale._meta.ui.resourceUri, "ui://imali-ai/card.html");
    assert.ok(sale.outputSchema.properties.entry);
    assert.equal(tools.find((t) => t.name === "get_stock")._meta.ui.resourceUri, "ui://imali-ai/stock.html");
    await client.close();
  });

  test("serves the MCP Apps views as text/html;profile=mcp-app", async () => {
    const { client } = await connect("t-ui");
    const card = await client.readResource({ uri: "ui://imali-ai/card.html" });
    assert.equal(card.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(card.contents[0].text, /ui\/initialize/);
    const stock = await client.readResource({ uri: "ui://imali-ai/stock.html" });
    assert.match(stock.contents[0].text, /reorder_stock/);
    await client.close();
  });

  test("records a cash sale as a balanced entry and says it from the books", async () => {
    const { client } = await connect("t-sale");
    const r = await call(client, "record_sale", { items: [{ item: "bread", qty: 3 }, { item: "cooking oil", qty: 2 }], payment: "cash" });
    assert.equal(r.ok, true);
    assert.equal(r.entry.balanced, true);
    assert.equal(r.entry.amount, "$12.30");
    assert.deepEqual(r.entry.totals, { debit: "$22.05", credit: "$22.05" });
    assert.match(r.speech, /\$12\.30/);
    const stock = await call(client, "get_stock", { item: "bread" });
    assert.equal(stock.items[0].qty, 15);
    await client.close();
  });

  test("asks rather than guesses when an item is not on the list", async () => {
    const { client } = await connect("t-ask");
    const r = await call(client, "record_sale", { items: [{ item: "paraffin", qty: 1 }], payment: "cash" });
    assert.equal(r.ok, false);
    assert.match(r.question, /paraffin/);
    await client.close();
  });

  test("keeps a shop's books across sessions, and keeps shops apart", async () => {
    const first = await connect("t-memory");
    const sale = await call(first.client, "record_sale", { items: [{ item: "sugar", qty: 2 }, { item: "maize meal", qty: 1 }], payment: "credit", customer: "Mai Tendai" });
    assert.equal(sale.entry.amount, "$12.70");
    await first.client.close();

    const second = await connect("t-memory");
    const tabs = await call(second.client, "get_customer_tabs", { customer: "Mai Tendai" });
    assert.equal(tabs.speech, "Mai Tendai owes $12.70.");
    const paid = await call(second.client, "record_tab_payment", { customer: "mai tendai", amount: 5 });
    assert.match(paid.speech, /still owe \$7\.70/);
    await second.client.close();

    const other = await connect("t-other-shop");
    const none = await call(other.client, "get_customer_tabs", { customer: "Mai Tendai" });
    assert.equal(none.speech, "Mai Tendai owes you nothing.");
    await other.client.close();
  });

  test("reorder asks the owner through elicitation and counts only after yes", async () => {
    let asked;
    const { client } = await connect("t-po-yes", {
      elicit: async (req) => {
        asked = req.params;
        return { action: "accept", content: { confirm: true, payment: "on_account" } };
      },
    });
    const r = await call(client, "reorder_stock", {});
    assert.match(asked.message, /^Send order PO-0001 to Kudzai Wholesale\?/);
    assert.equal(asked.requestedSchema.properties.payment.oneOf.length, 3);
    assert.equal(r.order.status, "confirmed");
    assert.equal(r.confirmed_by, "owner, through elicitation");
    assert.ok(r.order.lines.some((l) => l.item === "candles-6"));
    const day = await call(client, "get_day_summary");
    assert.equal(day.entries, 0, "an order moves no money and no stock");
    await client.close();
  });

  test("a declined order is cancelled", async () => {
    const { client } = await connect("t-po-no", { elicit: async () => ({ action: "decline" }) });
    const r = await call(client, "reorder_stock", { items: [{ item: "eggs", qty: 2 }] });
    assert.equal(r.order.status, "cancelled");
    await client.close();
  });

  test("without elicitation the order waits as a draft until confirm_purchase_order", async () => {
    const { client } = await connect("t-po-draft");
    const r = await call(client, "reorder_stock", { supplier: "Harare Bakery", items: [{ item: "bread", qty: 40 }] });
    assert.equal(r.order.status, "draft");
    assert.equal(r.order.total, "$34.00");
    const c = await call(client, "confirm_purchase_order", { order: "PO-0001" });
    assert.equal(c.order.status, "confirmed");
    const delivered = await call(client, "record_stock_received", { supplier: "Harare Bakery", items: [{ item: "bread", qty: 40 }], paid: "on_account", order: "PO-0001" });
    assert.equal(delivered.entry.amount, "$34.00");
    assert.equal(delivered.entry.balanced, true);
    await client.close();
  });

  test("closes the day against the owner's till count", async () => {
    const { client } = await connect("t-close");
    await call(client, "record_sale", { items: [{ item: "bread", qty: 2 }], payment: "cash" });
    await call(client, "record_expense", { amount: 5, category: "electricity" });
    const r = await call(client, "close_day", { counted_cash: 37 });
    assert.equal(r.expected, "$37.20");
    assert.equal(r.difference, "-$0.20");
    assert.equal(r.entry.balanced, true);
    assert.match(r.speech, /short by \$0\.20/);
    const journal = JSON.parse((await client.readResource({ uri: "imali-ai://books/journal" })).contents[0].text);
    assert.equal(journal.trial_balance.balanced, true);
    await client.close();
  });

  test("undo asks first, in words without elicitation and through a form with it", async () => {
    const { client } = await connect("t-undo");
    await call(client, "record_sale", { items: [{ item: "milk", qty: 1 }], payment: "mobile" });
    const ask = await call(client, "undo_last_entry");
    assert.equal(ask.ok, false);
    assert.match(ask.question, /Fresh milk/);
    assert.equal((await call(client, "get_day_summary")).entries, 1, "nothing removed before a yes");
    const u = await call(client, "undo_last_entry", { confirm: true });
    assert.match(u.speech, /^Removed: /);
    assert.equal((await call(client, "get_day_summary")).entries, 0);
    await client.close();

    const asked = [];
    const withForm = await connect("t-undo-form", { elicit: async (req) => (asked.push(req.params.message), { action: "accept", content: { confirm: true } }) });
    await call(withForm.client, "record_sale", { items: [{ item: "salt", qty: 1 }], payment: "cash" });
    const r = await call(withForm.client, "undo_last_entry");
    assert.match(asked[0], /Take out this entry\? Sold 1 × Salt 1 kg in cash/);
    assert.match(r.speech, /^Removed: /);
    await withForm.client.close();
  });

  test("reset asks first, and a no keeps the books", async () => {
    const { client } = await connect("t-reset", { elicit: async () => ({ action: "accept", content: { confirm: false } }) });
    await call(client, "record_sale", { items: [{ item: "bread", qty: 1 }], payment: "cash" });
    const r = await call(client, "reset_demo_shop");
    assert.equal(r.speech, "Okay, the books stay as they are.");
    assert.equal((await call(client, "get_day_summary")).entries, 1);
    await client.close();
  });

  test("a repeated request id is recorded once", async () => {
    const { client } = await connect("t-repeat");
    const req = { name: "record_sale", arguments: { items: [{ item: "bread", qty: 2 }], payment: "cash" }, _meta: { "io.ebenworks.imali/request-id": "call-123" } };
    const first = (await client.callTool(req)).structuredContent;
    const again = (await client.callTool(req)).structuredContent;
    assert.equal(again.entry.id, first.entry.id);
    assert.match(again.speech, /already recorded/);
    assert.equal((await call(client, "get_day_summary")).entries, 1);
    await client.close();
  });

  test("asks before stock or cash would go below zero, or when the total does not match the prices", async () => {
    const { client } = await connect("t-guards");
    const tooMany = await call(client, "record_sale", { items: [{ item: "eggs", qty: 50 }], payment: "cash" });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.question, /only 3 Eggs, tray of 30/);
    const onWord = await call(client, "record_sale", { items: [{ item: "eggs", qty: 4 }], payment: "cash", books_behind_shelf: true });
    assert.equal(onWord.ok, true);
    const bigCost = await call(client, "record_expense", { amount: 100000, category: "rent" });
    assert.equal(bigCost.ok, false);
    assert.match(bigCost.question, /in the till, less than \$100,000\.00/);
    const mismatch = await call(client, "record_sale", { items: [{ item: "bread", qty: 2 }], payment: "cash", amount_received: 5 });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.question, /add up to \$2\.20 but you said \$5\.00/);
    await client.close();
  });
});
