// Imali AI's shop books as an MCP server. Every tool reads or changes one shop's books through the
// ledger, which checks each entry balances in whole cents. The spoken line each tool returns is built
// here from the books, so an assistant can say it as it is and never has to work out a figure.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as L from "./ledger.js";
import { sampleBooks, shopDay } from "./shop.js";

export const SERVER_INFO = { name: "imali-ai-shop-books", title: "Imali AI shop books", version: "1.0.0", websiteUrl: "https://imali-ai.ebenworks.co" };
export const CARD_URI = "ui://imali-ai/card.html";
export const STOCK_URI = "ui://imali-ai/stock.html";
export const APP_MIME = "text/html;profile=mcp-app";

const UI_DIR = new URL("../ui/", import.meta.url);
const CARD_HTML = readFileSync(new URL("card.html", UI_DIR), "utf8");
const STOCK_HTML = readFileSync(new URL("stock.html", UI_DIR), "utf8");

export const INSTRUCTIONS = `Imali AI keeps one shop's double-entry books. The owner talks; you call the tools.
- Call a record tool for every sale, delivery, running cost or payment the owner mentions, one call per event. Pass the owner's own words for items; the server matches them to the stock list.
- Never work out or state a figure yourself. Every amount, count and balance comes from a tool result: say its "speech" line, or read figures from its structured content.
- When a result has ok=false, ask the owner its "question" and nothing more.
- For a reorder, call reorder_stock: the server shows the owner the order and asks them to confirm before it counts.
- Replies are spoken aloud: one or two short sentences, no lists, no markdown.`;

// ---- shaping results -------------------------------------------------------------------------

const cents = (c) => L.money(c ?? 0);

function prepare(books, now = new Date()) {
  const tz = books.shop?.timeZone || "Africa/Harare";
  return { ...books, orders: books.orders || [], closes: books.closes || [], today: shopDay(now, tz), now: now.toISOString() };
}

function lineView(l) {
  const acc = L.ACCOUNTS[l.account];
  return { code: acc.code, account: acc.name, debit: l.debit ? cents(l.debit) : "", credit: l.credit ? cents(l.credit) : "", ...(l.party ? { party: l.party } : {}) };
}

function entryView(e) {
  const debit = e.lines.reduce((t, l) => t + (l.debit || 0), 0);
  const credit = e.lines.reduce((t, l) => t + (l.credit || 0), 0);
  return { id: e.id, at: e.at, kind: e.kind, memo: e.memo, amount: cents(e.amount ?? debit), lines: e.lines.map(lineView), totals: { debit: cents(debit), credit: cents(credit) }, balanced: L.isBalanced(e) };
}

function shopView(books) {
  return { name: books.shop.name, owner: books.shop.owner, today: books.today, demo: Boolean(books.demo) };
}

// A tool result: the spoken line as text for any client, the same facts as structured content,
// and nothing the model has to calculate.
function result(structured, { isError = false } = {}) {
  const text = structured.ok === false ? structured.question : structured.speech;
  return { content: [{ type: "text", text }], structuredContent: structured, ...(isError ? { isError } : {}) };
}

function askBack(books, kind, question) {
  return result({ ok: false, kind, question, speech: question, shop: shopView(books), warnings: [] });
}

// How an owner says an item: "bread", "cooking oil", not "Bread loaf" or "Cooking oil 2 L".
function spoken(item) {
  return item?.aliases?.[0] || item?.name?.toLowerCase() || "item";
}

function listOf(parts) {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function itemsSaid(books, moves) {
  return listOf(moves.map((m) => `${L.fmtQty(Math.abs(m.qty))} ${spoken(books.items[m.item])}`));
}

function levelsLine(books, entry) {
  const levels = L.stockLevels(books);
  const low = (entry.stock || [])
    .map((m) => books.items[m.item])
    .filter((it, i, all) => it && all.indexOf(it) === i && levels[it.id] <= it.reorderAt)
    .map((it) => `${spoken(it)[0].toUpperCase()}${spoken(it).slice(1)} is down to ${L.fmtQty(levels[it.id])}`);
  return low.length ? ` ${low.join(". ")}.` : "";
}

// ---- the server ------------------------------------------------------------------------------

const ItemLine = z.object({
  item: z.string().min(1).max(60).describe("The item in the owner's words, e.g. 'bread' or 'cooking oil'"),
  qty: z.number().positive().max(10000).describe("How many"),
  unit_price: z.number().positive().max(100000).optional().describe("Price per unit in dollars, only if the owner said a price different from the list"),
});

const EntryOut = {
  ok: z.boolean(),
  kind: z.string(),
  speech: z.string().describe("The sentence to say to the owner, built from the books"),
  question: z.string().optional().describe("When ok is false: the one question to ask the owner"),
  entry: z
    .object({
      id: z.string(),
      at: z.string(),
      kind: z.string(),
      memo: z.string(),
      amount: z.string(),
      lines: z.array(z.object({ code: z.string(), account: z.string(), debit: z.string(), credit: z.string(), party: z.string().optional() })),
      totals: z.object({ debit: z.string(), credit: z.string() }),
      balanced: z.boolean(),
    })
    .optional(),
  warnings: z.array(z.string()),
  shop: z.object({ name: z.string(), owner: z.string(), today: z.string(), demo: z.boolean() }),
};

const OrderView = z.object({
  id: z.string(),
  number: z.string(),
  supplier: z.string(),
  status: z.enum(["draft", "confirmed", "cancelled", "received"]),
  at: z.string(),
  lines: z.array(z.object({ item: z.string(), name: z.string(), qty: z.number(), unit: z.string(), unitCost: z.string(), total: z.string() })),
  total: z.string(),
  payment: z.string().optional(),
});

function orderView(o) {
  return { id: o.id, number: o.number, supplier: o.supplier, status: o.status, at: o.at, total: cents(o.total), ...(o.payment ? { payment: o.payment } : {}), lines: o.lines.map((l) => ({ item: l.item, name: l.name, qty: l.qty, unit: l.unit, unitCost: cents(l.unitCost), total: cents(l.total) })) };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const cardMeta = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };
const stockMeta = { ui: { resourceUri: STOCK_URI }, "ui/resourceUri": STOCK_URI };

export function createMcpServer({ store, shopId, clock = () => new Date(), log = () => {} }) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
    instructions: INSTRUCTIONS,
  });

  // Runs fn on this shop's books inside the store's lock. fn returns { books?, out }.
  const withBooks = (fn) =>
    store.update(shopId, async (raw) => {
      const books = prepare(raw, clock());
      const res = await fn(books);
      return { books: res.books ? stripTransient(res.books) : null, out: res.out };
    }).then((r) => r.out);

  function stripTransient(books) {
    const { now, ...rest } = books;
    return rest;
  }

  // A record tool: build the entry with the ledger, refuse it unless it balances, apply it, say it.
  function recordTool(name, title, description, inputSchema, build, speak) {
    server.registerTool(
      name,
      { title, description, inputSchema, outputSchema: EntryOut, annotations: { title, ...WRITE }, _meta: cardMeta },
      async (args) =>
        withBooks((books) => {
          const built = build(books, args);
          if (!built.ok) return { out: askBack(books, name, built.question) };
          if (!L.isBalanced(built.entry)) return { out: askBack(books, name, "That entry would not balance, so I left the books as they were. Can you say it again?") };
          const after = L.applyEntry(books, built.entry);
          log("entry", { shopId, kind: built.entry.kind, amount: built.entry.amount });
          const speech = speak(built.entry, after, args) + levelsLine(after, built.entry);
          return { books: after, out: result({ ok: true, kind: built.entry.kind, speech, entry: entryView(built.entry), warnings: built.warnings, shop: shopView(after) }) };
        }),
    );
  }

  recordTool(
    "record_sale",
    "Record a sale",
    "Record a sale at the counter: what sold, how many, and how the customer paid (cash, mobile money or on credit to a named customer's tab). Prices come from the shop's list unless the owner says otherwise.",
    {
      items: z.array(ItemLine).min(1).max(20),
      payment: z.enum(["cash", "mobile", "credit"]).describe("cash, mobile money, or credit (on the customer's tab)"),
      customer: z.string().max(40).optional().describe("Who took it on credit; required for credit"),
      amount_received: z.number().positive().optional().describe("Only if the owner said the total they took"),
    },
    L.buildSale,
    (e, after) => `Got it: ${itemsSaid(after, e.stock)}, ${e.method === "credit" ? `on credit to ${e.party}` : e.method === "mobile" ? "mobile money" : "cash"}, ${cents(e.amount)}.`,
  );

  recordTool(
    "record_stock_received",
    "Record stock received",
    "Record a delivery from a supplier: items, quantities and the cost of each, and whether it was paid in cash, by mobile money or is owed to the supplier. Name the purchase order if the delivery fills one.",
    {
      supplier: z.string().max(40),
      items: z.array(z.object({ item: z.string().min(1).max(60), qty: z.number().positive().max(10000), unit_cost: z.number().positive().max(100000).optional().describe("Cost per unit in dollars; leave out to use the order's or the list's cost") })).min(1).max(30),
      paid: z.enum(["cash", "mobile", "on_account"]).describe("on_account means the shop owes the supplier"),
      order: z.string().max(20).optional().describe("The purchase order number this delivery fills, e.g. PO-0001"),
    },
    (books, args) => {
      const order = args.order ? L.findOrder(books, args.order) : null;
      const items = args.items.map((raw) => {
        const it = L.findItem(books, raw.item);
        const fromOrder = order?.lines.find((l) => l.item === it?.id);
        const unitCost = raw.unit_cost ?? (fromOrder ? fromOrder.unitCost / 100 : it ? it.cost / 100 : undefined);
        return { item: raw.item, qty: raw.qty, unit_cost: unitCost };
      });
      const built = L.buildStockIn(books, { supplier: args.supplier, items, paid: args.paid === "on_account" ? "account" : args.paid });
      if (built.ok && order) built.entry.order = order.id;
      return built;
    },
    (e, after) => `Booked in from ${e.party}: ${itemsSaid(after, e.stock)}, ${cents(e.amount)}${e.method === "credit" ? ", owed to them" : `, paid ${e.method === "mobile" ? "by mobile money" : "in cash"}`}.`,
  );

  recordTool(
    "record_expense",
    "Record a running cost",
    "Record money paid out for running the shop: rent, electricity, transport, wages, airtime and the like.",
    {
      amount: z.number().positive().max(100000).describe("Dollars"),
      category: z.string().min(1).max(60).describe("What it was for, e.g. electricity"),
      payment: z.enum(["cash", "mobile"]).default("cash"),
    },
    L.buildExpense,
    (e) => `Recorded ${cents(e.amount)} for ${e.lines[0].party.toLowerCase()}, paid ${e.method === "mobile" ? "by mobile money" : "in cash"}.`,
  );

  recordTool(
    "record_tab_payment",
    "Record a customer paying their tab",
    "Record a customer paying back money they owe on their tab.",
    { customer: z.string().min(1).max(40), amount: z.number().positive().max(100000), method: z.enum(["cash", "mobile"]).default("cash") },
    L.buildCustomerPayment,
    (e, after) => {
      const left = L.partyBalances(after, "debtors")[e.party] || 0;
      return `${e.party} paid ${cents(e.amount)}. ${left > 0 ? `They still owe ${cents(left)}.` : left < 0 ? `You now hold ${cents(-left)} for them.` : "Their tab is clear."}`;
    },
  );

  recordTool(
    "record_supplier_payment",
    "Record paying a supplier",
    "Record the shop paying money it owes a supplier.",
    { supplier: z.string().min(1).max(40), amount: z.number().positive().max(100000), method: z.enum(["cash", "mobile"]).default("cash") },
    L.buildSupplierPayment,
    (e, after) => {
      const left = -(L.partyBalances(after, "creditors")[e.party] || 0);
      return `Paid ${e.party} ${cents(e.amount)}. ${left > 0 ? `You still owe them ${cents(left)}.` : "You owe them nothing now."}`;
    },
  );

  // ---- questions answered from the books ------------------------------------------------------

  server.registerTool(
    "get_day_summary",
    {
      title: "How is today going",
      description: "Today's takings, profit and money position from the books: sales by cash, mobile money and credit, gross profit, running costs, and what is in the till.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        kind: z.string(),
        speech: z.string(),
        day: z.string(),
        sales: z.string(),
        cash_sales: z.string(),
        mobile_sales: z.string(),
        credit_sales: z.string(),
        gross_profit: z.string(),
        running_costs: z.string(),
        net: z.string(),
        cash_in_till: z.string(),
        mobile_money: z.string(),
        entries: z.number(),
        shop: EntryOut.shop,
        warnings: z.array(z.string()),
      },
      annotations: { title: "How is today going", ...READ },
      _meta: cardMeta,
    },
    async () =>
      withBooks((books) => {
        const s = L.daySummary(books);
        const b = L.balances(books);
        const speech = s.count
          ? `Today you've sold ${cents(s.sales)}${s.credit ? `, ${cents(s.credit)} of it on credit` : ""}. Gross profit is ${cents(s.grossProfit)}${s.expenses ? ` and running costs ${cents(s.expenses)}, so you're up ${cents(s.net)}` : ""}. The till should hold ${cents(b.cash)}.`
          : `Nothing recorded yet today. The till should hold ${cents(b.cash)}.`;
        return { out: result({ ok: true, kind: "day-summary", speech, day: s.day, sales: cents(s.sales), cash_sales: cents(s.cash), mobile_sales: cents(s.mobile), credit_sales: cents(s.credit), gross_profit: cents(s.grossProfit), running_costs: cents(s.expenses), net: cents(s.net), cash_in_till: cents(b.cash), mobile_money: cents(b.mobile), entries: s.count, shop: shopView(books), warnings: [] }) };
      }),
  );

  server.registerTool(
    "get_customer_tabs",
    {
      title: "Who owes the shop",
      description: "Customers' tabs from the books: who owes how much. Name a customer to hear just theirs.",
      inputSchema: { customer: z.string().max(40).optional() },
      outputSchema: { ok: z.boolean(), kind: z.string(), speech: z.string(), tabs: z.array(z.object({ name: z.string(), owes: z.string() })), total: z.string(), shop: EntryOut.shop, warnings: z.array(z.string()) },
      annotations: { title: "Who owes the shop", ...READ },
      _meta: cardMeta,
    },
    async ({ customer }) =>
      withBooks((books) => {
        const owed = L.partyBalances(books, "debtors");
        const tabs = Object.entries(owed).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const total = tabs.reduce((t, [, v]) => t + v, 0);
        let speech;
        let shown = tabs;
        if (customer) {
          const who = L.findParty(Object.keys(owed).map((name) => ({ name })), customer)?.name;
          shown = who ? tabs.filter(([n]) => n === who) : [];
          speech = who && owed[who] > 0 ? `${who} owes ${cents(owed[who])}.` : `${who ?? customer} owes you nothing.`;
        } else {
          speech = tabs.length ? `${tabs.length === 1 ? "One customer owes" : `${tabs.length} customers owe`} you ${cents(total)}: ${tabs.map(([n, v]) => `${n} ${cents(v)}`).join(", ")}.` : "Nobody owes you anything.";
        }
        return { out: result({ ok: true, kind: "tabs", speech, tabs: shown.map(([name, v]) => ({ name, owes: cents(v) })), total: cents(total), shop: shopView(books), warnings: [] }) };
      }),
  );

  server.registerTool(
    "get_stock",
    {
      title: "What's on the shelves",
      description: "Stock levels from the books, lowest first, with what is at its reorder level and what sold over the last seven days. Name an item to hear just that one.",
      inputSchema: { item: z.string().max(60).optional() },
      outputSchema: {
        ok: z.boolean(),
        kind: z.string(),
        speech: z.string(),
        items: z.array(z.object({ id: z.string(), name: z.string(), unit: z.string(), qty: z.number(), reorder_at: z.number(), low: z.boolean(), price: z.string(), sold_7_days: z.number() })),
        low_count: z.number(),
        shop: EntryOut.shop,
        warnings: z.array(z.string()),
      },
      annotations: { title: "What's on the shelves", ...READ },
      _meta: stockMeta,
    },
    async ({ item }) =>
      withBooks((books) => {
        const sold = L.unitsSold(books, 7);
        let rows = L.stockReport(books).map((r) => ({ id: r.id, name: r.name, unit: r.unit, qty: r.qty, reorder_at: r.reorderAt, low: r.low, price: r.price === null ? "no price" : cents(r.price), sold_7_days: Math.max(0, sold[r.id] || 0) }));
        const low = rows.filter((r) => r.low);
        let speech;
        if (item) {
          const it = L.findItem(books, item);
          if (!it) return { out: askBack(books, "stock", `I don't have "${item}" in your stock list. Which item is it?`) };
          rows = rows.filter((r) => r.id === it.id);
          const r = rows[0];
          speech = `You have ${L.fmtQty(r.qty)} ${spoken(it)} left${r.low ? ", at its reorder level" : ""}. ${r.sold_7_days} sold in the last seven days.`;
        } else {
          speech = low.length ? `${low.length} ${low.length === 1 ? "item is" : "items are"} at the reorder level: ${listOf(low.map((r) => `${spoken(books.items[r.id])} with ${L.fmtQty(r.qty)} left`))}.` : "Everything is above its reorder level.";
        }
        return { out: result({ ok: true, kind: "stock", speech, items: rows, low_count: low.length, shop: shopView(books), warnings: [] }) };
      }),
  );

  // ---- closing the day -------------------------------------------------------------------------

  server.registerTool(
    "close_day",
    {
      title: "Close the day",
      description: "Close today's books with the owner's count of the cash in the till. Compares it with what the books expect, records any shortage or surplus, and gives the day's figures. Only call it with a count the owner said.",
      inputSchema: { counted_cash: z.number().min(0).max(100000).describe("Dollars the owner counted in the till") },
      outputSchema: { ...EntryOut, expected: z.string(), counted: z.string(), difference: z.string(), sales: z.string(), gross_profit: z.string(), running_costs: z.string(), net: z.string() },
      annotations: { title: "Close the day", ...WRITE },
      _meta: cardMeta,
    },
    async ({ counted_cash }) =>
      withBooks((books) => {
        const c = L.closeDay(books, { counted_cash });
        if (!c.ok) return { out: askBack(books, "day-close", c.question) };
        const s = c.summary;
        const diffLine = c.diff === 0 ? "The till matches the books to the cent." : `The till is ${c.diff < 0 ? "short" : "over"} by ${cents(Math.abs(c.diff))}, and that's recorded.`;
        const speech = `${diffLine} You sold ${cents(s.sales)} today${s.expenses ? `, spent ${cents(s.expenses)} on running costs` : ""}, and you're ${s.net < 0 ? "down" : "up"} ${cents(Math.abs(s.net))} after cost of goods${s.overshort ? " and the till" : ""}.`;
        const after = { ...c.books, closes: [...(c.books.closes || []), { day: books.today, at: books.now, expected: c.expected, counted: c.counted, diff: c.diff }] };
        return {
          books: after,
          out: result({ ok: true, kind: "day-close", speech, ...(c.entry ? { entry: entryView(c.entry) } : {}), expected: cents(c.expected), counted: cents(c.counted), difference: cents(c.diff), sales: cents(s.sales), gross_profit: cents(s.grossProfit), running_costs: cents(s.expenses), net: cents(s.net), warnings: [], shop: shopView(after) }),
        };
      }),
  );

  // ---- reordering: a purchase order the owner confirms ------------------------------------------

  const OrderOut = { ok: z.boolean(), kind: z.string(), speech: z.string(), question: z.string().optional(), order: OrderView.optional(), confirmed_by: z.string().optional(), shop: EntryOut.shop, warnings: z.array(z.string()) };

  server.registerTool(
    "reorder_stock",
    {
      title: "Reorder from a supplier",
      description: "Draft a purchase order for low stock (or the items named) from a supplier, sized to a week of sales, and ask the owner to confirm it before it counts. Changes no account: stock and money move only when the delivery is recorded.",
      inputSchema: {
        supplier: z.string().max(40).optional().describe("Supplier name; defaults to the shop's usual wholesaler"),
        items: z.array(z.object({ item: z.string().min(1).max(60), qty: z.number().positive().max(10000).optional() })).max(20).optional().describe("Leave out to reorder everything at its reorder level"),
      },
      outputSchema: OrderOut,
      annotations: { title: "Reorder from a supplier", ...WRITE },
      _meta: cardMeta,
    },
    async (args, extra) => {
      // Draft and save the order first, so a client without elicitation can confirm it with confirm_purchase_order.
      const drafted = await withBooks((books) => {
        const d = L.draftPurchaseOrder(books, args);
        if (!d.ok) return { out: { books, d } };
        return { books: L.addOrder(books, d.order), out: { books: L.addOrder(books, d.order), d } };
      });
      if (!drafted.d.ok) return askBack(drafted.books, "purchase-order", drafted.d.question);
      const order = drafted.d.order;
      const summary = itemsSaid(drafted.books, order.lines);

      const caps = server.server.getClientCapabilities();
      let answer = null;
      if (caps?.elicitation) {
        try {
          answer = await extra.sendRequest(
            {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: `Send order ${order.number} to ${order.supplier}? ${summary}. Estimated cost ${cents(order.total)}.`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    confirm: { type: "boolean", title: `Confirm ${order.number}`, description: "Nothing counts until you confirm", default: true },
                    payment: { type: "string", title: "How will you pay?", oneOf: [{ const: "on_account", title: "On account with the supplier" }, { const: "cash", title: "Cash on delivery" }, { const: "mobile", title: "Mobile money on delivery" }], default: "on_account" },
                  },
                  required: ["confirm"],
                },
              },
            },
            ElicitResultSchema,
            { timeout: 180_000 },
          );
        } catch (err) {
          log("elicitation-failed", { shopId, message: String(err?.message || err) });
          answer = null;
        }
      }

      if (!answer) {
        const speech = `I've drafted ${order.number} to ${order.supplier}: ${summary}, about ${cents(order.total)}. Say yes to confirm it.`;
        return result({ ok: true, kind: "purchase-order", speech, order: orderView(order), shop: shopView(drafted.books), warnings: ["Waiting for the owner to confirm: call confirm_purchase_order once they say yes."] });
      }

      return withBooks((books) => {
        const current = L.findOrder(books, order.id) ?? order;
        if (answer.action === "accept" && answer.content?.confirm === true) {
          const done = { ...current, status: "confirmed", confirmedAt: books.now, payment: answer.content.payment || "on_account" };
          const after = L.addOrder(books, done);
          log("order-confirmed", { shopId, number: done.number, total: done.total });
          const speech = `Done. ${done.number} to ${done.supplier} is confirmed, about ${cents(done.total)}. I'll book the stock in when it arrives.`;
          return { books: after, out: result({ ok: true, kind: "purchase-order", speech, order: orderView(done), confirmed_by: "owner, through elicitation", shop: shopView(after), warnings: [] }) };
        }
        const status = answer.action === "decline" || answer.content?.confirm === false ? "cancelled" : "draft";
        const kept = { ...current, status };
        const after = L.addOrder(books, kept);
        const speech = status === "cancelled" ? `Okay, I've cancelled ${kept.number}. Nothing was ordered.` : `${kept.number} stays a draft. Nothing is ordered until you confirm it.`;
        return { books: after, out: result({ ok: true, kind: "purchase-order", speech, order: orderView(kept), shop: shopView(after), warnings: [] }) };
      });
    },
  );

  server.registerTool(
    "confirm_purchase_order",
    {
      title: "Confirm a drafted purchase order",
      description: "Confirm a drafted purchase order after the owner has clearly said yes to it. For clients that cannot show the confirmation form themselves.",
      inputSchema: { order: z.string().max(20).optional().describe("The order number, e.g. PO-0001; defaults to the latest draft"), payment: z.enum(["on_account", "cash", "mobile"]).default("on_account") },
      outputSchema: OrderOut,
      annotations: { title: "Confirm a drafted purchase order", ...WRITE },
      _meta: cardMeta,
    },
    async ({ order: ref, payment }) =>
      withBooks((books) => {
        const order = L.findOrder(books, ref);
        if (!order || order.status !== "draft") return { out: askBack(books, "purchase-order", ref ? `I can't find a draft order ${ref}. Which order do you mean?` : "There's no draft order waiting. What would you like to order?") };
        const done = { ...order, status: "confirmed", confirmedAt: books.now, payment };
        const after = L.addOrder(books, done);
        const summary = itemsSaid(books, done.lines);
        return { books: after, out: result({ ok: true, kind: "purchase-order", speech: `Order ${done.number} to ${done.supplier} is confirmed: ${summary}, about ${cents(done.total)}.`, order: orderView(done), confirmed_by: "owner, by voice", shop: shopView(after), warnings: [] }) };
      }),
  );

  // ---- putting things right ---------------------------------------------------------------------

  server.registerTool(
    "undo_last_entry",
    {
      title: "Undo the last entry",
      description: "Take out the most recent entry recorded today, when the owner says it was wrong.",
      inputSchema: {},
      outputSchema: { ok: z.boolean(), kind: z.string(), speech: z.string(), question: z.string().optional(), removed: z.string().optional(), shop: EntryOut.shop, warnings: z.array(z.string()) },
      annotations: { title: "Undo the last entry", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async () =>
      withBooks((books) => {
        const last = [...books.journal].reverse().find((e) => e.kind !== "opening" && L.dayOf(e.at) === books.today);
        if (!last) return { out: askBack(books, "undo", "There's nothing recorded today to undo.") };
        const after = L.removeEntry(books, last.id);
        return { books: after, out: result({ ok: true, kind: "undo", speech: `Removed: ${last.memo}.`, removed: last.memo, shop: shopView(after), warnings: [] }) };
      }),
  );

  server.registerTool(
    "reset_demo_shop",
    {
      title: "Reset the demo shop",
      description: "Put this shop's books back to the invented demo shop's opening position. Only when the owner asks to start the demo again.",
      inputSchema: {},
      outputSchema: { ok: z.boolean(), kind: z.string(), speech: z.string(), shop: EntryOut.shop, warnings: z.array(z.string()) },
      annotations: { title: "Reset the demo shop", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      withBooks(() => {
        const fresh = prepare(sampleBooks(clock()), clock());
        return { books: fresh, out: result({ ok: true, kind: "reset", speech: `${fresh.shop.name} is back to its opening books.`, shop: shopView(fresh), warnings: [] }) };
      }),
  );

  // ---- MCP Apps views ---------------------------------------------------------------------------

  const viewMeta = { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } };
  server.registerResource(
    "card",
    CARD_URI,
    { title: "Imali AI receipt card", description: "Shows a recorded entry, a day's figures, a purchase order or customers' tabs as a card.", mimeType: APP_MIME, _meta: viewMeta },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: APP_MIME, text: CARD_HTML, _meta: viewMeta }] }),
  );
  server.registerResource(
    "stock",
    STOCK_URI,
    { title: "Imali AI stock carousel", description: "Shows the shop's stock as a swipeable carousel, lowest first.", mimeType: APP_MIME, _meta: viewMeta },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: APP_MIME, text: STOCK_HTML, _meta: viewMeta }] }),
  );

  // The journal itself, for clients that read resources.
  server.registerResource(
    "journal",
    "imali-ai://books/journal",
    { title: "The shop's journal", description: "Every entry in the shop's books, newest first, with its debit and credit lines.", mimeType: "application/json" },
    async (uri) => {
      const books = prepare((await store.load(shopId)) ?? sampleBooks(clock()), clock());
      const tb = L.trialBalance(books);
      const body = { shop: shopView(books), trial_balance: { debit: cents(tb.debit), credit: cents(tb.credit), balanced: tb.balanced }, entries: [...books.journal].reverse().map(entryView), orders: (books.orders || []).map(orderView) };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---- prompts: the owner's daily routines ------------------------------------------------------

  server.registerPrompt(
    "close_the_day",
    { title: "Close the day", description: "The end-of-day routine: count the till, close the books, hear the day's figures.", argsSchema: { counted_cash: z.string().optional().describe("The till count, if the owner already said it") } },
    ({ counted_cash }) => ({
      messages: [{ role: "user", content: { type: "text", text: counted_cash ? `I'm closing up. I counted $${counted_cash} in the till. Close the day with close_day and tell me how we did.` : "I'm closing up. Ask me how much cash I counted in the till, then close the day with close_day and tell me how we did." } }],
    }),
  );
  server.registerPrompt(
    "morning_check",
    { title: "Morning check", description: "Start of day: what is low, who owes the shop, and whether to reorder." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: "Good morning. Check my stock with get_stock and my customers' tabs with get_customer_tabs, tell me the one or two things that matter, and offer to reorder what is low." } }] }),
  );

  return server;
}
