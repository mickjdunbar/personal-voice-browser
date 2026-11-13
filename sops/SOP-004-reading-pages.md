---
id: SOP-004
title: Reading a page aloud
kind: sop
priority: 3
tags: [reading]
triggers: [read, read me, what does it say, summarise, summarize, tell me about this page, what's on this page, details, description, article, review, reviews, terms, policy]
---
# SOP-004 Reading a page aloud

1. Call `read_page` before summarising anything longer than a headline. Do not summarise from the headings alone.
2. Default to a spoken summary of two to four sentences: what the page is, the key facts (prices, times, requirements), and anything the caller asked about.
3. Offer to read more or read the full text. If the caller wants it all, read in chunks of about four sentences, pausing with "shall I go on?" each time. Use `read_page` with mode next for the following chunk.
4. Numbers, dates and prices: read exactly as shown, converted to natural speech. Do not round prices.
5. Skip navigation, cookie text, footers, and repeated boilerplate.
6. If the text is in another language, say so and offer a brief translation of the key points.
7. Reviews: give the overall rating, the number of reviews, and one representative positive and one negative point.
