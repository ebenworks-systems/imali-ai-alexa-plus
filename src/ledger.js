// The books. Plain double-entry bookkeeping in whole cents, taken from the Imali AI shop agent we built
// for the Nebius x NVIDIA hackathon (MIT). The model never writes here directly: a tool call proposes,
// these functions check and build the entry, and applyEntry() refuses anything that does not balance.

export const ACCOUNTS = {
  cash: { code: "1000", name: "Cash in the till", type: "asset" },
  mobile: { code: "1010", name: "Mobile money", type: "asset" },
  debtors: { code: "1100", name: "Customers owe you", type: "asset" },
  stock: { code: "1200", name: "Stock at cost", type: "asset" },
  creditors: { code: "2000", name: "You owe suppliers", type: "liability" },
  capital: { code: "3000", name: "Owner's capital", type: "equity" },
  drawings: { code: "3100", name: "Owner's drawings", type: "equity" },
  sales: { code: "4000", name: "Sales", type: "income" },
  cogs: { code: "5000", name: "Cost of goods sold", type: "expense" },
  expenses: { code: "6000", name: "Running costs", type: "expense" },
  overshort: { code: "6900", name: "Cash over or short", type: "expense" },
};

const METHOD_ACCOUNT = { cash: "cash", mobile: "mobile" };
const MAX_CENTS = 100_000_00;
const MAX_QTY = 10_000;

export function toCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function money(cents, currency = "USD") {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const symbol = currency === "USD" ? "$" : currency + " ";
  return `${sign}${symbol}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singular(word) {
  if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function words(text) {
  return normalise(text).split(" ").filter(Boolean).map(singular);
}

// Finds a catalogue item from the words an owner or a model used: the id, the name or an alias,
// in any of the shop's languages. Returns null rather than guessing between two close matches.
export function findItem(books, query) {
  if (!query) return null;
  const items = Object.values(books.items);
  const q = normalise(query);
  const exact = items.find((it) => it.id === query || normalise(it.name) === q || it.aliases.some((a) => normalise(a) === q));
  if (exact) return exact;
  const qWords = words(query);
  if (!qWords.length) return null;
  const scored = items
    .map((it) => {
      const names = [it.name, ...it.aliases].map(words);
      const best = Math.max(...names.map((n) => n.filter((w) => qWords.includes(w)).length / Math.max(n.length, 1)));
      return { it, best };
    })
    .filter((s) => s.best > 0)
    .sort((a, b) => b.best - a.best);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].best === scored[1].best) return null;
  return scored[0].best >= 0.5 ? scored[0].it : null;
}

// Local item names in a message, including chiShona and isiNdebele words with "and" joined on the front
// (nemunyu = ne + munyu, lamaqanda = la + amaqanda). The agent hands these to the model as hints.
const JOINED = ["ne", "na", "no", "la", "le", "lo", "l"];

export function localItemWords(books, text) {
  const local = new Map();
  for (const it of Object.values(books.items)) {
    const english = new Set(words(it.name));
    for (const a of it.aliases) {
      const n = normalise(a);
      if (!n.includes(" ") && !english.has(singular(n))) local.set(n, it.id);
    }
  }
  const found = new Set();
  for (const word of normalise(text).split(" ")) {
    const tries = [word, ...JOINED.filter((p) => word.startsWith(p) && word.length > p.length + 2).map((p) => word.slice(p.length))];
    const hit = tries.find((t) => local.has(t));
    if (hit) found.add(`${word} = ${local.get(hit)}`);
  }
  return [...found];
}

// Whether a message names a catalogue item: its name or an alias, in any of the shop's languages, including a
// local word with "and" joined on the front. The agent records an item only when the owner's message names it.
export function mentionsItem(item, text) {
  if (!item) return false;
  const msg = normalise(text);
  const seen = new Set();
  for (const w of msg.split(" ")) {
    for (const t of [w, ...JOINED.filter((p) => w.startsWith(p) && w.length > p.length + 2).map((p) => w.slice(p.length))]) {
      seen.add(t);
      seen.add(singular(t));
    }
  }
  return [item.name, ...item.aliases].some((form) => {
    const n = normalise(form);
    return n.includes(" ") ? ` ${msg} `.includes(` ${n} `) : seen.has(n) || seen.has(singular(n));
  });
}

export function findParty(list, name) {
  if (!name) return null;
  const q = normalise(name);
  return list.find((p) => normalise(p.name) === q) ?? list.find((p) => normalise(p.name).includes(q) || q.includes(normalise(p.name))) ?? null;
}

function slug(text) {
  return normalise(text).replace(/ /g, "-").slice(0, 40) || "item";
}

function qtyOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY) return null;
  return Math.round(n * 1000) / 1000;
}

function methodOf(value) {
  const m = normalise(value);
  if (!m) return null;
  if (/credit|chikwereti|later|owe|account|tab/.test(m)) return "credit";
  if (/mobile|ecocash|onemoney|innbucks|mpesa|momo|transfer|swipe|card/.test(m)) return "mobile";
  if (/cash|mari|imali|notes/.test(m)) return "cash";
  return null;
}

export function newId(prefix = "e") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---- reading the books -------------------------------------------------------------------

export function balances(books) {
  const out = Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, 0]));
  for (const entry of books.journal) for (const l of entry.lines) out[l.account] += (l.debit || 0) - (l.credit || 0);
  return out;
}

export function partyBalances(books, account) {
  const out = {};
  for (const entry of books.journal)
    for (const l of entry.lines) if (l.account === account && l.party) out[l.party] = (out[l.party] || 0) + (l.debit || 0) - (l.credit || 0);
  return out;
}

export function stockLevels(books) {
  const out = Object.fromEntries(Object.keys(books.items).map((id) => [id, 0]));
  for (const entry of books.journal) for (const m of entry.stock || []) out[m.item] = Math.round(((out[m.item] || 0) + m.qty) * 1000) / 1000;
  return out;
}

export function trialBalance(books) {
  let debit = 0;
  let credit = 0;
  for (const entry of books.journal)
    for (const l of entry.lines) {
      debit += l.debit || 0;
      credit += l.credit || 0;
    }
  return { debit, credit, balanced: debit === credit };
}

export function dayOf(iso) {
  return String(iso).slice(0, 10);
}

export function daySummary(books, day = books.today) {
  const s = { day, sales: 0, cash: 0, mobile: 0, credit: 0, cogs: 0, expenses: 0, overshort: 0, collected: 0, count: 0 };
  for (const entry of books.journal) {
    if (entry.kind === "opening" || dayOf(entry.at) !== day) continue;
    s.count += 1;
    for (const l of entry.lines) {
      if (l.account === "sales") s.sales += (l.credit || 0) - (l.debit || 0);
      if (l.account === "cogs") s.cogs += (l.debit || 0) - (l.credit || 0);
      if (l.account === "expenses") s.expenses += (l.debit || 0) - (l.credit || 0);
      if (l.account === "overshort") s.overshort += (l.debit || 0) - (l.credit || 0);
    }
    if (entry.kind === "sale") {
      const paid = entry.lines.find((l) => l.debit && ["cash", "mobile", "debtors"].includes(l.account));
      if (paid) s[paid.account === "debtors" ? "credit" : paid.account] += paid.debit;
    }
    if (entry.kind === "customer-payment") s.collected += entry.lines.find((l) => l.debit)?.debit || 0;
  }
  s.grossProfit = s.sales - s.cogs;
  s.net = s.grossProfit - s.expenses - s.overshort;
  return s;
}

export function stockReport(books) {
  const levels = stockLevels(books);
  return Object.values(books.items)
    .map((it) => ({ id: it.id, name: it.name, unit: it.unit, qty: levels[it.id] || 0, reorderAt: it.reorderAt, price: it.price, cost: it.cost, low: (levels[it.id] || 0) <= it.reorderAt }))
    .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));
}

export function unitsSold(books, days = 7) {
  const out = { ...(books.pastWeek || {}) };
  const cutoff = new Date(`${books.today}T00:00:00Z`).getTime() - (days - 1) * 86_400_000;
  for (const entry of books.journal) {
    if (entry.kind !== "sale" || new Date(entry.at).getTime() < cutoff) continue;
    for (const m of entry.stock || []) out[m.item] = (out[m.item] || 0) - m.qty;
  }
  return out;
}

// What the model sees of the books: small, plain and enough to answer from.
export function snapshotForModel(books) {
  const levels = stockLevels(books);
  const debtors = partyBalances(books, "debtors");
  const creditors = partyBalances(books, "creditors");
  const b = balances(books);
  const today = daySummary(books);
  return {
    shop: books.shop,
    today: books.today,
    catalogue: Object.values(books.items).map((it) => ({
      id: it.id,
      name: it.name,
      also_called: it.aliases,
      sell_price: it.price === null ? null : it.price / 100,
      cost: it.cost / 100,
      in_stock: levels[it.id] || 0,
      reorder_at: it.reorderAt,
    })),
    customers_owe: Object.entries(debtors).filter(([, v]) => v).map(([name, v]) => ({ name, owes: v / 100 })),
    owed_to_suppliers: Object.entries(creditors).filter(([, v]) => v).map(([name, v]) => ({ name, owed: -v / 100 })),
    known_customers: books.customers.map((c) => c.name),
    known_suppliers: books.suppliers.map((s) => s.name),
    money: { cash_in_till: b.cash / 100, mobile_money: b.mobile / 100 },
    today_so_far: {
      sales: today.sales / 100,
      cash_sales: today.cash / 100,
      mobile_sales: today.mobile / 100,
      credit_sales: today.credit / 100,
      gross_profit: today.grossProfit / 100,
      running_costs: today.expenses / 100,
      entries: today.count,
    },
  };
}

// ---- building entries ----------------------------------------------------------------------

function entry(books, kind, memo, lines, stock = [], extra = {}) {
  return { id: newId(kind.slice(0, 2)), at: extra.at || books.now || new Date().toISOString(), kind, memo, lines: lines.filter((l) => l.debit || l.credit), stock, ...extra };
}

function fail(question) {
  return { ok: false, question };
}

export function buildSale(books, args = {}) {
  const method = methodOf(args.payment) ?? (args.customer ? "credit" : null);
  if (!method) return fail("Was that cash, mobile money or on credit?");
  const lines = [];
  const stock = [];
  const warnings = [];
  const levels = stockLevels(books);
  let listTotal = 0;
  let costTotal = 0;
  const parts = [];
  const rawItems = Array.isArray(args.items) ? args.items : [];
  if (!rawItems.length) return fail("Which items did you sell?");
  for (const raw of rawItems) {
    const item = findItem(books, raw.item ?? raw.id ?? raw.name);
    if (!item) return fail(`I don't have "${raw.item ?? raw.name ?? "that"}" in your stock list. Which item is it?`);
    const qty = qtyOf(raw.qty ?? raw.quantity ?? 1);
    if (!qty) return fail(`How many ${item.name} did you sell?`);
    const unit = raw.unit_price !== undefined && raw.unit_price !== null ? toCents(raw.unit_price) : item.price;
    if (unit === null) return fail(`What do you sell ${item.name} for?`);
    if (unit <= 0 || unit > MAX_CENTS) return fail(`The price for ${item.name} looks wrong. What did you charge?`);
    const lineTotal = Math.round(unit * qty);
    listTotal += lineTotal;
    costTotal += Math.round(item.cost * qty);
    stock.push({ item: item.id, qty: -qty });
    parts.push(`${fmtQty(qty)} × ${item.name}`);
    const left = (levels[item.id] || 0) - qty;
    if (left < 0) warnings.push(`Your books show only ${fmtQty(levels[item.id] || 0)} ${item.name} in stock. Recording it anyway; a stock count will settle it.`);
    else if (left <= item.reorderAt) warnings.push(`${item.name} is down to ${fmtQty(left)}. Time to reorder.`);
  }
  let total = listTotal;
  let received = toCents(args.amount_received);
  let foreign = "";
  if (args.paid_amount !== undefined && args.paid_amount !== null && args.rate) {
    const units = Number(args.paid_amount);
    const rate = Number(args.rate);
    if (!(units > 0) || !(rate > 0)) return fail("How much did they pay, and at what rate?");
    received = Math.round((units / rate) * 100);
    foreign = `${fmtQty(units)} ${args.paid_currency_name || args.paid_currency}`;
    warnings.unshift(`${foreign} at ${rate} to the US dollar${args.rate_note ? ` (${args.rate_note})` : ""} is ${money(received)}.`);
  }
  if (received !== null && received > 0 && received !== listTotal) {
    if (Math.abs(received - listTotal) > Math.max(500, listTotal * 0.5)) return fail(`Your prices add up to ${money(listTotal)} but you said ${money(received)}. Which is right?`);
    warnings.push(`Price list total is ${money(listTotal)}; recording the ${money(received)} you received.`);
    total = received;
  }
  let party;
  if (method === "credit") {
    if (!args.customer) return fail("Who took it on credit?");
    party = findParty(books.customers, args.customer)?.name ?? titleCase(args.customer);
    lines.push({ account: "debtors", debit: total, party });
  } else {
    lines.push({ account: METHOD_ACCOUNT[method], debit: total });
  }
  lines.push({ account: "sales", credit: total });
  lines.push({ account: "cogs", debit: costTotal });
  lines.push({ account: "stock", credit: costTotal });
  const how = (method === "credit" ? `on credit to ${party}` : method === "mobile" ? "by mobile money" : "in cash") + (foreign ? `, paid ${foreign}` : "");
  // A foreign payment keeps its rate and where the rate came from, so the books carry their own audit trail.
  const src = args.rate_source;
  const fx = foreign && src ? { paid: foreign, rate: Number(args.rate), source: src.source, url: src.url, asOf: src.asOf, kind: src.kind, readAt: src.readAt, fingerprint: src.fingerprint, crossChecked: Boolean(src.crossChecked) } : undefined;
  return { ok: true, entry: entry(books, "sale", `Sold ${parts.join(", ")} ${how}`, lines, stock, { amount: total, method, party, ...(fx ? { fx } : {}) }), warnings };
}

export function buildStockIn(books, args = {}) {
  const rawItems = Array.isArray(args.items) ? args.items : [];
  if (!rawItems.length) return fail("Which items came in?");
  const supplier = args.supplier ? findParty(books.suppliers, args.supplier)?.name ?? titleCase(args.supplier) : "Supplier";
  const paid = methodOf(args.paid) ?? (normalise(args.paid).includes("account") ? "credit" : null);
  if (!paid) return fail(`Did you pay ${supplier} in cash, by mobile money, or do you owe them?`);
  const stock = [];
  const parts = [];
  const newItems = [];
  const warnings = [];
  let total = 0;
  for (const raw of rawItems) {
    const qty = qtyOf(raw.qty ?? raw.quantity);
    if (!qty) return fail(`How many ${raw.item ?? raw.name ?? "items"} came in?`);
    const unitCost = toCents(raw.unit_cost ?? (raw.line_total !== undefined ? Number(raw.line_total) / qty : null));
    let item = findItem(books, raw.item ?? raw.name);
    if (unitCost === null || unitCost <= 0 || unitCost > MAX_CENTS) return fail(`What did each ${item?.name ?? raw.item ?? "item"} cost?`);
    if (!item) {
      const name = firstUpper(raw.item ?? raw.name ?? "New item");
      item = { id: slug(name), name, unit: raw.unit || "each", aliases: [], price: null, cost: unitCost, reorderAt: 2 };
      newItems.push(item);
      warnings.push(`${name} is new to your stock list. Tell me what you will sell it for.`);
    } else if (Math.abs(unitCost - item.cost) >= 5) {
      warnings.push(`${item.name} cost ${money(unitCost)} this time, ${unitCost > item.cost ? "up" : "down"} from ${money(item.cost)}.`);
    }
    const lineTotal = Math.round(unitCost * qty);
    total += lineTotal;
    stock.push({ item: item.id, qty, unitCost });
    parts.push(`${fmtQty(qty)} × ${item.name}`);
  }
  const stated = toCents(args.total);
  if (stated !== null && stated > 0 && Math.abs(stated - total) > 2) warnings.push(`The lines add up to ${money(total)}, not the ${money(stated)} printed as the total. Recording ${money(total)}; check the invoice.`);
  const lines = [{ account: "stock", debit: total }];
  if (paid === "credit") lines.push({ account: "creditors", credit: total, party: supplier });
  else lines.push({ account: METHOD_ACCOUNT[paid], credit: total });
  const how = paid === "credit" ? `on account with ${supplier}` : `paid ${paid === "mobile" ? "by mobile money" : "in cash"} to ${supplier}`;
  return { ok: true, entry: entry(books, "stock-in", `Stock in: ${parts.join(", ")}, ${how}`, lines, stock, { amount: total, method: paid, party: supplier, newItems }), warnings };
}

export function buildExpense(books, args = {}) {
  const amount = toCents(args.amount);
  if (!amount || amount <= 0 || amount > MAX_CENTS) return fail("How much was it?");
  const method = methodOf(args.payment) ?? "cash";
  if (method === "credit") return fail("Did you pay it in cash or by mobile money?");
  const what = String(args.category || args.note || "Running cost").slice(0, 60);
  const lines = [{ account: "expenses", debit: amount, party: titleCase(what) }, { account: METHOD_ACCOUNT[method], credit: amount }];
  return { ok: true, entry: entry(books, "expense", `Paid ${money(amount)} for ${what.toLowerCase()}`, lines, [], { amount, method }), warnings: [] };
}

export function buildCustomerPayment(books, args = {}) {
  const amount = toCents(args.amount);
  if (!amount || amount <= 0 || amount > MAX_CENTS) return fail("How much did they pay?");
  const method = methodOf(args.method ?? args.payment) ?? "cash";
  if (method === "credit") return fail("Did they pay in cash or by mobile money?");
  const owed = partyBalances(books, "debtors");
  const party = findParty(Object.keys(owed).map((name) => ({ name })), args.customer)?.name;
  if (!party) return fail(`I have no record of ${args.customer || "that customer"} owing you. Who paid?`);
  const warnings = amount > owed[party] ? [`${party} owed ${money(owed[party])}; the extra ${money(amount - owed[party])} shows as money you hold for them.`] : [];
  const lines = [{ account: METHOD_ACCOUNT[method], debit: amount }, { account: "debtors", credit: amount, party }];
  return { ok: true, entry: entry(books, "customer-payment", `${party} paid ${money(amount)} ${method === "mobile" ? "by mobile money" : "in cash"}`, lines, [], { amount, method, party }), warnings };
}

export function buildSupplierPayment(books, args = {}) {
  const amount = toCents(args.amount);
  if (!amount || amount <= 0 || amount > MAX_CENTS) return fail("How much did you pay them?");
  const method = methodOf(args.method ?? args.payment) ?? "cash";
  if (method === "credit") return fail("Did you pay in cash or by mobile money?");
  const party = findParty(books.suppliers, args.supplier)?.name ?? titleCase(args.supplier || "Supplier");
  const lines = [{ account: "creditors", debit: amount, party }, { account: METHOD_ACCOUNT[method], credit: amount }];
  return { ok: true, entry: entry(books, "supplier-payment", `Paid ${party} ${money(amount)}`, lines, [], { amount, method, party }), warnings: [] };
}

export function buildDrawing(books, args = {}) {
  const amount = toCents(args.amount);
  if (!amount || amount <= 0 || amount > MAX_CENTS) return fail("How much did you take out?");
  const method = methodOf(args.method ?? args.payment) ?? "cash";
  const lines = [{ account: "drawings", debit: amount }, { account: METHOD_ACCOUNT[method === "credit" ? "cash" : method], credit: amount }];
  return { ok: true, entry: entry(books, "drawing", `You took ${money(amount)} for yourself${args.note ? ` (${String(args.note).slice(0, 40)})` : ""}`, lines, [], { amount, method }), warnings: [] };
}

export function buildCashCount(books, args = {}) {
  const counted = toCents(args.counted_cash ?? args.counted);
  if (counted === null || counted < 0 || counted > MAX_CENTS) return fail("How much cash did you count in the till?");
  const expected = balances(books).cash;
  const diff = counted - expected;
  if (diff === 0) return { ok: true, entry: null, expected, counted, diff, warnings: [] };
  const lines = diff < 0 ? [{ account: "overshort", debit: -diff }, { account: "cash", credit: -diff }] : [{ account: "cash", debit: diff }, { account: "overshort", credit: diff }];
  return {
    ok: true,
    entry: entry(books, "cash-count", `Till count ${money(counted)}: ${diff < 0 ? "short" : "over"} by ${money(Math.abs(diff))}`, lines, [], { amount: Math.abs(diff) }),
    expected,
    counted,
    diff,
    warnings: [],
  };
}

export function buildPrice(books, args = {}) {
  const item = findItem(books, args.item);
  if (!item) return fail(`Which item is "${args.item}"?`);
  const price = toCents(args.sell_price ?? args.price);
  if (!price || price <= 0 || price > MAX_CENTS) return fail(`What price for ${item.name}?`);
  if (price === item.price) return fail(`${item.name} already sells at ${money(price)}. What should the new price be?`);
  return { ok: true, price: { item: item.id, name: item.name, from: item.price, to: price }, warnings: price < item.cost ? [`${money(price)} is below what ${item.name} costs you (${money(item.cost)}).`] : [] };
}

// ---- changing the books ----------------------------------------------------------------------

export function isBalanced(e) {
  let d = 0;
  let c = 0;
  for (const l of e.lines) {
    if (!ACCOUNTS[l.account]) return false;
    if ((l.debit && l.credit) || (l.debit || 0) < 0 || (l.credit || 0) < 0) return false;
    d += l.debit || 0;
    c += l.credit || 0;
  }
  return d === c && d > 0;
}

export function applyEntry(books, e) {
  if (!isBalanced(e)) throw new Error("Entry does not balance");
  const items = { ...books.items };
  for (const it of e.newItems || []) if (!items[it.id]) items[it.id] = { ...it };
  for (const m of e.stock || []) if (!items[m.item]) throw new Error(`Unknown item ${m.item}`);
  const parties = (list, name) => (name && !findParty(list, name) ? [...list, { name }] : list);
  return {
    ...books,
    items,
    customers: e.kind === "sale" && e.method === "credit" ? parties(books.customers, e.party) : books.customers,
    suppliers: e.kind === "stock-in" ? parties(books.suppliers, e.party) : books.suppliers,
    journal: [...books.journal, { ...e, newItems: undefined }],
  };
}

export function applyPrice(books, change) {
  const item = books.items[change.item];
  if (!item) throw new Error("Unknown item");
  return { ...books, items: { ...books.items, [item.id]: { ...item, price: change.to } } };
}

export function removeEntry(books, id) {
  return { ...books, journal: books.journal.filter((e) => e.id !== id || e.kind === "opening") };
}

// ---- purchase orders -------------------------------------------------------------------------
// An order to a supplier is a promise, not a transaction: it changes no account until the stock arrives.
// It lives beside the journal, and record_stock_received closes it.

// How many to order: enough for a week of sales at last week's pace, less what is on the shelf,
// and never below twice the reorder level.
export function suggestedQty(books, item) {
  const level = stockLevels(books)[item.id] || 0;
  const week = Math.max(0, unitsSold(books, 7)[item.id] || 0);
  const want = Math.max(week, item.reorderAt * 2) - level;
  return want > 0 ? Math.ceil(want) : 0;
}

export function draftPurchaseOrder(books, args = {}) {
  const supplier = args.supplier ? findParty(books.suppliers, args.supplier)?.name ?? titleCase(args.supplier) : books.suppliers[0]?.name;
  if (!supplier) return fail("Which supplier should I order from?");
  const wanted = Array.isArray(args.items) && args.items.length ? args.items : stockReport(books).filter((r) => r.low).map((r) => ({ item: r.id }));
  if (!wanted.length) return fail("Nothing is at its reorder level. Which items do you want to order?");
  const lines = [];
  for (const raw of wanted) {
    const item = findItem(books, raw.item ?? raw.id ?? raw.name);
    if (!item) return fail(`I don't have "${raw.item ?? raw.name ?? "that"}" in your stock list. Which item is it?`);
    const qty = raw.qty !== undefined && raw.qty !== null ? qtyOf(raw.qty) : suggestedQty(books, item);
    if (!qty) continue;
    lines.push({ item: item.id, name: item.name, unit: item.unit, qty, unitCost: item.cost, total: Math.round(item.cost * qty) });
  }
  if (!lines.length) return fail("You have enough of those for a week. Do you still want to order some?");
  const total = lines.reduce((t, l) => t + l.total, 0);
  const number = `PO-${String((books.orders || []).length + 1).padStart(4, "0")}`;
  return {
    ok: true,
    order: { id: newId("po"), number, supplier, status: "draft", at: books.now || new Date().toISOString(), lines, total },
    warnings: [],
  };
}

export function addOrder(books, order) {
  return { ...books, orders: [...(books.orders || []).filter((o) => o.id !== order.id), order] };
}

export function findOrder(books, ref) {
  const orders = books.orders || [];
  if (!ref) return [...orders].reverse().find((o) => o.status === "draft" || o.status === "sent") ?? null;
  const q = normalise(ref).replace(/ /g, "");
  return orders.find((o) => o.id === ref || normalise(o.number).replace(/ /g, "") === q || normalise(o.number).replace(/ /g, "").endsWith(q)) ?? null;
}

// ---- closing the day -------------------------------------------------------------------------

export function closeDay(books, args = {}) {
  const count = buildCashCount(books, args);
  if (!count.ok) return count;
  const after = count.entry ? applyEntry(books, count.entry) : books;
  return { ...count, summary: daySummary(after), books: after };
}

// ---- small helpers ----------------------------------------------------------------------------

export function fmtQty(q) {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100);
}

function firstUpper(text) {
  const t = String(text).trim().slice(0, 40);
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function titleCase(text) {
  return String(text)
    .trim()
    .slice(0, 40)
    .split(/\s+/)
    .map((w) => (w.length > 2 || /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export const BUILDERS = {
  record_sale: buildSale,
  record_stock_in: buildStockIn,
  record_expense: buildExpense,
  record_customer_payment: buildCustomerPayment,
  record_supplier_payment: buildSupplierPayment,
  record_owner_withdrawal: buildDrawing,
  set_price: buildPrice,
};
