// The demo shop. Every name, price and figure here is invented for the demonstration;
// no real shop, customer or supplier is behind any of it.

const ITEMS = [
  ["bread", "Bread loaf", "loaf", ["bread", "loaf", "loaves", "chingwa"], 1.1, 0.85, 18, 6],
  ["cooking-oil-2l", "Cooking oil 2 L", "bottle", ["cooking oil", "oil", "mafuta"], 4.5, 3.6, 9, 4],
  ["sugar-2kg", "Sugar 2 kg", "pack", ["sugar", "shuga"], 2.6, 2.05, 14, 5],
  ["maize-meal-10kg", "Maize meal 10 kg", "bag", ["maize meal", "mealie meal", "corn meal", "upfu"], 7.5, 6.2, 4, 3],
  ["rice-2kg", "Rice 2 kg", "pack", ["rice", "mupunga"], 2.8, 2.2, 10, 4],
  ["eggs-tray", "Eggs, tray of 30", "tray", ["eggs", "egg tray", "egg", "mazai"], 5.5, 4.4, 3, 2],
  ["milk-1l", "Fresh milk 1 L", "carton", ["milk", "mukaka"], 1.3, 1.0, 12, 4],
  ["salt-1kg", "Salt 1 kg", "pack", ["salt", "munyu"], 0.6, 0.4, 15, 5],
  ["soap-bar", "Bath soap", "bar", ["soap", "sipo"], 0.8, 0.55, 20, 6],
  ["matches", "Matches, box of 10", "box", ["matches", "machisi"], 0.5, 0.35, 12, 4],
  ["candles-6", "Candles, pack of 6", "pack", ["candles", "candle"], 1.2, 0.9, 3, 3],
  ["soft-drink-2l", "Soft drink 2 L", "bottle", ["soft drink", "cool drink", "soda", "fizzy"], 1.8, 1.3, 10, 4],
];

// Units sold over the week before the shop joined, so a reorder has a week of movement to read.
const PAST_WEEK = { bread: 70, "cooking-oil-2l": 14, "sugar-2kg": 18, "maize-meal-10kg": 9, "rice-2kg": 3, "eggs-tray": 6, "milk-1l": 30, "salt-1kg": 2, "soap-bar": 16, matches: 10, "candles-6": 9, "soft-drink-2l": 5 };

export const SHOP_TIMEZONE = "Africa/Harare";

// The shop's calendar day, in its own time zone, so "today" turns over at the shop's midnight.
export function shopDay(date = new Date(), timeZone = SHOP_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function sampleBooks(now = new Date()) {
  const items = {};
  const stock = [];
  let stockCost = 0;
  for (const [id, name, unit, aliases, price, cost, qty, reorderAt] of ITEMS) {
    items[id] = { id, name, unit, aliases, price: Math.round(price * 100), cost: Math.round(cost * 100), reorderAt };
    stock.push({ item: id, qty, unitCost: Math.round(cost * 100) });
    stockCost += Math.round(cost * 100) * qty;
  }
  return {
    version: 1,
    demo: true,
    shop: { name: "Rudo's Corner Shop", place: "Harare", owner: "Rudo", currency: "USD", timeZone: SHOP_TIMEZONE, note: "Invented for the demonstration" },
    createdAt: now.toISOString(),
    today: shopDay(now),
    items,
    pastWeek: { ...PAST_WEEK },
    customers: [{ name: "Baba Farai" }, { name: "Mai Tendai" }],
    suppliers: [{ name: "Kudzai Wholesale" }, { name: "Harare Bakery" }],
    orders: [],
    closes: [],
    journal: [
      {
        id: "opening",
        at: now.toISOString(),
        kind: "opening",
        memo: "Opening balances: till float, mobile money, stock on the shelves, Baba Farai's tab",
        lines: [
          { account: "cash", debit: 4000 },
          { account: "mobile", debit: 1250 },
          { account: "stock", debit: stockCost },
          { account: "debtors", debit: 400, party: "Baba Farai" },
          { account: "capital", credit: 4000 + 1250 + stockCost + 400 },
        ],
        stock,
      },
    ],
  };
}
