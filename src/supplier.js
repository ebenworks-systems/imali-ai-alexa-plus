// The supplier side as its own MCP server: an invented wholesaler and bakery on a supplier network, the way Imali
// AI's supplier edition serves the shops it supplies. The shop's books server is its client: it asks for a quote
// before the owner confirms a purchase order, and places the order here once the owner says yes.
// Every supplier, price and order here is invented for the demonstration.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { money, normalise } from "./ledger.js";

export const SUPPLIER_INFO = { name: "imali-ai-supplier-network", title: "Imali AI supplier network (demo)", version: "1.0.0" };

// item id: [unit price in cents, units available, the supplier's own name]
const SUPPLIERS = {
  "kudzai-wholesale": {
    name: "Kudzai Wholesale",
    code: "KW",
    deliveryDays: 1,
    stock: {
      "cooking-oil-2l": [370, 200, "Cooking oil 2 L"],
      "sugar-2kg": [205, 300, "Sugar 2 kg"],
      "maize-meal-10kg": [620, 120, "Maize meal 10 kg"],
      "rice-2kg": [220, 150, "Rice 2 kg"],
      "eggs-tray": [440, 40, "Eggs, tray of 30"],
      "milk-1l": [100, 240, "Fresh milk 1 L"],
      "salt-1kg": [40, 400, "Salt 1 kg"],
      "soap-bar": [55, 500, "Bath soap"],
      matches: [35, 600, "Matches, box of 10"],
      "candles-6": [90, 4, "Candles, pack of 6"],
      "soft-drink-2l": [130, 180, "Soft drink 2 L"],
    },
  },
  "harare-bakery": { name: "Harare Bakery", code: "HB", deliveryDays: 0, stock: { bread: [85, 400, "Bread loaf"] } },
};

function supplierOf(name) {
  const q = normalise(name).replace(/ /g, "-");
  return Object.entries(SUPPLIERS).find(([id, s]) => id === q || normalise(s.name) === normalise(name)) ?? null;
}

function deliveryDate(clock, days) {
  return new Date(clock().getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

// Prices and fills each line from the supplier's stock: a line it cannot fill in full is cut to what it has.
export function quote(supplierName, lines, clock = () => new Date()) {
  const found = supplierOf(supplierName);
  if (!found) return { ok: false, question: `${supplierName} is not on the supplier network.` };
  const [id, s] = found;
  const out = [];
  for (const l of lines) {
    const row = s.stock[l.item];
    if (!row) {
      out.push({ item: l.item, name: l.name || l.item, asked: l.qty, qty: 0, unitPrice: 0, total: 0, note: "not stocked" });
      continue;
    }
    const [price, available, name] = row;
    const qty = Math.min(l.qty, available);
    out.push({ item: l.item, name, asked: l.qty, qty, unitPrice: price, total: price * qty, ...(qty < l.qty ? { note: `only ${available} available` } : {}) });
  }
  const total = out.reduce((t, l) => t + l.total, 0);
  return { ok: true, supplierId: id, supplier: s.name, lines: out, total, deliveryDate: deliveryDate(clock, s.deliveryDays) };
}

const LineIn = z.object({ item: z.string().min(1).max(60).describe("The item id from the shop's books, e.g. candles-6"), qty: z.number().positive().max(10000), name: z.string().max(60).optional() });
const QuoteOut = {
  ok: z.boolean(),
  supplier: z.string(),
  lines: z.array(z.object({ item: z.string(), name: z.string(), asked: z.number(), qty: z.number(), unitPrice: z.string(), unit_cents: z.number(), total: z.string(), note: z.string().optional() })),
  total: z.string(),
  total_cents: z.number(),
  delivery_date: z.string(),
  order_id: z.string().optional(),
  status: z.string(),
  speech: z.string(),
};

function view(q, extra = {}) {
  return {
    ok: true,
    supplier: q.supplier,
    lines: q.lines.map((l) => ({ ...l, unit_cents: l.unitPrice, unitPrice: money(l.unitPrice), total: money(l.total) })),
    total: money(q.total),
    total_cents: q.total,
    delivery_date: q.deliveryDate,
    status: "quote",
    speech: `${q.supplier} can deliver on ${q.deliveryDate} for ${money(q.total)}.`,
    ...extra,
  };
}

export function createSupplierServer({ store, buyer, clock = () => new Date(), log = () => {} }) {
  const server = new McpServer(SUPPLIER_INFO, {
    capabilities: { tools: {} },
    instructions: "An invented supplier network for the Imali AI demo. Quote before ordering; place an order only after the shop owner has confirmed it.",
  });
  const docKey = `network-${buyer}`;
  const answer = (structured) => ({ content: [{ type: "text", text: structured.speech }], structuredContent: structured });
  const fail = (speech) => ({ content: [{ type: "text", text: speech }], structuredContent: { ok: false, supplier: "", lines: [], total: "$0.00", total_cents: 0, delivery_date: "", status: "refused", speech }, isError: false });

  server.registerTool(
    "quote_order",
    { title: "Quote an order", description: "Price an order and say what the supplier can deliver and when. Places nothing.", inputSchema: { supplier: z.string().max(40), lines: z.array(LineIn).min(1).max(30) }, outputSchema: QuoteOut, annotations: { readOnlyHint: true, openWorldHint: false } },
    async ({ supplier, lines }) => {
      const q = quote(supplier, lines, clock);
      return q.ok ? answer(view(q)) : fail(q.question);
    },
  );

  server.registerTool(
    "place_order",
    {
      title: "Place an order",
      description: "Place a confirmed order with the supplier. Only after the shop owner has confirmed it. Returns the supplier's order number and delivery date.",
      inputSchema: { supplier: z.string().max(40), lines: z.array(LineIn).min(1).max(30), buyer_reference: z.string().max(40).describe("The shop's purchase order number"), payment: z.enum(["on_account", "cash", "mobile"]).default("on_account") },
      outputSchema: QuoteOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ supplier, lines, buyer_reference, payment }) =>
      store.update(docKey, async (doc) => {
        const books = doc;
        const repeat = books.orders.find((o) => o.buyerReference === buyer_reference && o.supplier === supplier);
        if (repeat) return { books, out: answer({ ...repeat.view, speech: `${repeat.view.supplier} already has ${buyer_reference} as order ${repeat.view.order_id}.` }) };
        const q = quote(supplier, lines, clock);
        if (!q.ok) return { books, out: fail(q.question) };
        if (!q.total) return { books, out: fail(`${q.supplier} has none of those items in stock.`) };
        const id = `${SUPPLIERS[q.supplierId].code}-${String(1001 + books.orders.length)}`;
        const placed = view(q, { order_id: id, status: "accepted", speech: `${q.supplier} accepted order ${id} for ${money(q.total)}, delivering on ${q.deliveryDate}.` });
        log("supplier-order", { buyer, id, total: q.total });
        return { books: { ...books, orders: [...books.orders, { buyerReference: buyer_reference, supplier, payment, at: clock().toISOString(), view: placed }] }, out: answer(placed) };
      }, () => ({ kind: "supplier-network", orders: [] })).then((r) => r.out),
  );

  return server;
}
