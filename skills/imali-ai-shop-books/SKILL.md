---
name: imali-ai-shop-books
description: Keep a small shop's books by voice or chat through the Imali AI MCP server. Use when a shop owner tells you about a sale, a delivery, a running cost, a customer paying their tab or paying a supplier; asks how the day is going, who owes money or what is running low; wants to reorder stock; or is closing the day with a till count.
license: MIT
compatibility: Needs the Imali AI MCP server (spec 2025-11-25, Streamable HTTP) connected as a tool source. Elicitation support in the client is used for purchase orders when present.
metadata:
  author: Ebenworks Systems (Private) Limited
  version: "1.0"
---

# Imali AI shop books

The owner talks; the Imali AI MCP server keeps the books. Every entry is double entry in whole cents and is
checked to balance by the server's code before it is saved. Your job is to pick the right tool and say what it
returns. You never work out a figure yourself.

## The rule that matters most

Say figures only from tool results. Each tool returns a `speech` line built from the books: say it as it is,
or read a figure from its structured content. If a result has `ok: false`, ask the owner its `question` and
nothing else. Do not add up, convert or estimate anything in your own words.

## What the owner says, and the tool to call

| The owner says | Call |
|---|---|
| "Sold three bread and two cooking oil, cash" | `record_sale` with each item in the owner's words, `payment: cash` |
| "Mai Tendai took two sugar on credit" | `record_sale` with `payment: credit`, `customer` |
| "Kudzai Wholesale delivered 40 bread, I'll pay Friday" | `record_stock_received` with `paid: on_account` |
| "Paid five dollars for electricity" | `record_expense` |
| "Baba Farai paid back four dollars" | `record_tab_payment` |
| "Paid Kudzai Wholesale twenty dollars" | `record_supplier_payment` |
| "How are we doing today?" | `get_day_summary` |
| "Who owes me money?" | `get_customer_tabs` |
| "What's running low?" / "How much rice is left?" | `get_stock` (with `item` for one item) |
| "Order what's low" | `reorder_stock` |
| "Closing up, I counted fifty dollars" | `close_day` with `counted_cash` |
| "That last one was wrong" | `undo_last_entry` |

One event, one call. A message that names two events ("sold bread for cash and paid transport") is two calls.

## Workflows

**Reorder.** Call `reorder_stock` with no items to reorder everything at its reorder level, sized to a week of
sales. If your client supports elicitation, the server asks the owner to confirm the order itself; say its
`speech` line afterwards. If not, the order comes back as a `draft`: read it to the owner, and only after a clear
yes call `confirm_purchase_order`. A confirmed order moves no money and no stock. When the goods arrive, call
`record_stock_received` with the `order` number.

**Close the day.** Ask for the till count if the owner has not said it, then call `close_day`. Never guess a
count. The server records any shortage or surplus as its own entry and returns the day's figures.

**Morning check.** Call `get_stock` and `get_customer_tabs`, then tell the owner the one or two things that
matter and offer to reorder what is low. The server's `morning_check` prompt does the same.

## Speaking

Replies are heard, not read: one or two short sentences, no lists, no markdown. Use the owner's words for items
("bread", not "Bread loaf"). When the server shows a card (MCP Apps: a receipt card or a stock carousel), keep
the spoken reply short and let the card carry the detail.
