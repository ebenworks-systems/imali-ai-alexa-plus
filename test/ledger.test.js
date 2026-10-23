// The books on their own: every entry balances in whole cents, and orders move no money.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/ledger.js";
import { sampleBooks, shopDay } from "../src/shop.js";

const NOW = new Date("2026-10-23T09:15:00.000Z");
const books = () => ({ ...sampleBooks(NOW), now: NOW.toISOString() });

test("the demo shop opens balanced, with its till float and Baba Farai's tab", () => {
  const b = books();
  assert.ok(L.trialBalance(b).balanced);
  assert.equal(L.balances(b).cash, 4000);
  assert.equal(L.partyBalances(b, "debtors")["Baba Farai"], 400);
  assert.equal(b.today, "2026-10-23");
});

test("the shop's day turns over at midnight in Harare, not UTC", () => {
  assert.equal(shopDay(new Date("2026-10-23T22:30:00Z")), "2026-10-24");
  assert.equal(shopDay(new Date("2026-10-23T21:30:00Z")), "2026-10-23");
});

test("a sale balances: cash and sales on one side, cost of goods out of stock on the other", () => {
  const r = L.buildSale(books(), { items: [{ item: "bread", qty: 3 }], payment: "cash" });
  assert.ok(r.ok);
  assert.ok(L.isBalanced(r.entry));
  assert.equal(r.entry.amount, 330);
  const after = L.applyEntry(books(), r.entry);
  assert.equal(L.stockLevels(after).bread, 15);
  assert.ok(L.trialBalance(after).balanced);
});

test("an unbalanced entry is refused", () => {
  const bad = { id: "x", at: NOW.toISOString(), kind: "sale", memo: "bad", lines: [{ account: "cash", debit: 100 }, { account: "sales", credit: 99 }] };
  assert.equal(L.isBalanced(bad), false);
  assert.throws(() => L.applyEntry(books(), bad), /does not balance/);
});

test("a credit sale needs a customer, and the tab carries it", () => {
  assert.equal(L.buildSale(books(), { items: [{ item: "sugar", qty: 1 }], payment: "credit" }).ok, false);
  const r = L.buildSale(books(), { items: [{ item: "sugar", qty: 1 }], payment: "credit", customer: "Mai Tendai" });
  const after = L.applyEntry(books(), r.entry);
  assert.equal(L.partyBalances(after, "debtors")["Mai Tendai"], 260);
});

test("a till count records only the difference", () => {
  const short = L.closeDay(books(), { counted_cash: 39.5 });
  assert.equal(short.diff, -50);
  assert.ok(L.isBalanced(short.entry));
  const exact = L.closeDay(books(), { counted_cash: 40 });
  assert.equal(exact.entry, null);
});

test("a purchase order sizes each line to a week of sales and moves no money", () => {
  const b = books();
  const d = L.draftPurchaseOrder(b, {});
  assert.ok(d.ok);
  const candles = d.order.lines.find((l) => l.item === "candles-6");
  assert.equal(candles.qty, 6, "9 sold last week, 3 on the shelf");
  assert.equal(d.order.total, d.order.lines.reduce((t, l) => t + l.total, 0));
  const after = L.addOrder(b, d.order);
  assert.deepEqual(L.balances(after), L.balances(b));
  assert.equal(L.findOrder(after, "po-0001").number, "PO-0001");
});
