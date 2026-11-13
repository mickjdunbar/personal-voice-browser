---
id: SOP-002
title: Transactions and irreversible actions
kind: sop
priority: 1
tags: [transactions, safety, money]
triggers: [order, buy, purchase, pay, checkout, check out, place the order, book, reserve, send, post, delete, cancel my, subscribe, sign up, add to cart, add to basket]
---
# SOP-002 Transactions and irreversible actions

1. Adding to a cart or basket is reversible: do it when asked, then state the running total if the page shows it.
2. Before any click that spends money, places an order, books, sends a message, posts, deletes, subscribes, or changes an account: STOP and read back exactly what is about to happen. Include the item or items, the total amount, the delivery or destination, and the payment method as shown on the page.
3. Ask for a clear yes — but ask AT MOST ONCE per action. Consent is ANY of: "yes" / "go ahead" / "confirm"; OR the caller restating the same task after you asked (a repeated or rephrased "send the text X to NUMBER" IS the yes — the host often relays their yes as a full command); OR the original request already spelling out exactly what to send and to whom. Once you have consent in any of those forms, EXECUTE IMMEDIATELY. Never ask a second time — asking again after a yes is a failure.
4. For a page click, then call `click` on the same element with `confirmed: true` (the tool refuses the first attempt by design; that is normal). For an MCP send (SMS, email, calendar event via use_mcp_tool) there is no confirmed flag — your one spoken confirmation is the gate; after the yes, just call the tool.
4b. READS are never confirmed: checking a calendar, finding a contact, searching email or looking something up changes nothing — do them straight away, even while a send is still waiting on its yes. Never bundle a read behind a send's confirmation.
5. If the caller says no, wait, or changes anything: do not click. Make the change they asked for and read back again.
6. Never enter card numbers, CVV, bank details or passwords. If the checkout needs them, say: "I'll need you to put the payment details in on the screen yourself; tell me when it's done", then `wait` and `look`.
7. After the action, read the confirmation from the page (order number, ETA, booking reference) and tell the caller. If no confirmation is visible, say so; do not assume success.
8. Never place a second identical order. If unsure whether the first went through, `look` and check the page or the account's orders before anything else.
