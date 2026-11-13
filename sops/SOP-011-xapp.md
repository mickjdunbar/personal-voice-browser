---
id: SOP-011
title: Maps — showing WHERE on the Personal Voice Browser (drop_pin) vs visual input via xApp
kind: sop
priority: 2
tags: [xapp, map, location, screen, visual, pin]
triggers: [send me a map, drop a pin, pick a location, show me where, pin drop, send it to my phone, pick on a map, choose on the map, exact location, pickup spot, delivery location, where exactly, xapp, the map, dropped a pin, dropped the pin, map link, picked a location, done with the map, where is it, on the map, meeting spot, text me the location]
---
# SOP-011 Maps: show WHERE with drop_pin; xApp only when the caller must PICK a spot

TWO DIFFERENT JOBS — decide first:

A. **YOU show the caller WHERE something is** ("drop a pin on it", "show me where it is", "where's
   the bar", a meeting spot, an address they should see): call the `drop_pin` tool with the place
   name plus suburb/city. It puts a map with a marker straight onto the caller's PERSONAL VOICE
   BROWSER screen (no link, no QR, no xApp). Then say ONCE: "I've pulled that up on your Personal
   Voice Browser — the pin's on <place>" and give the address in words. If they want it on their
   phone ("text me the location"), text the `share_link` the tool returned (Google Maps) with
   `use_mcp_tool` (Zapier → twilio_send_sms), e.g. "<Place>, <address>. Map: <share_link>" — ONE
   text, then confirm it has been SENT (only after the tool succeeded). Never create an xApp for
   this job.

B. **The CALLER must GIVE you a location** that is miserable by voice — "pick up from here",
   "deliver to this spot", "let me pick on a map" — push an INPUT xApp to their screen and read
   the answer back (steps 1-7 below).

1. Create it with the `xapp` chatbot. Call `ask_chatbot` with bot `xapp` and a message that is
   EXACTLY one line in this form (compose the title/prompt from the conversation; pick a
   sensible map centre near the caller's city, default Brisbane):
   `xapp create {"type":"map_pin","title":"Pickup location","prompt":"Drop a pin where we should pick up","center":{"lat":-27.4698,"lng":153.0251},"zoom":13}`
   The reply is `LINK <url>` (or `ERROR ...` — fix the JSON and retry once).
2. Do NOT mention the link, the URL, or any website name at all — not even once. The console
   AUTOMATICALLY shows a tappable map card with a QR code the moment the link is created; say
   only "I've put a map on your screen — tap the card, or scan the code with your phone."
3. SMS is EXTRA, only when the caller is on a real phone away from a screen AND you know
   their mobile (they gave it, or it is in their saved context): send the link with
   `use_mcp_tool` (Zapier → twilio_send_sms), message like "Tap to drop a pin: <url>".
   NEVER claim you have texted anything unless that tool call actually succeeded.
4. The result is PUSHED to you automatically: the system watches the map and tells you (as a
   background update you relay) when the caller opens it and again the moment they confirm the
   pin — you do NOT need to poll. Only if the caller says "done" and no update has arrived yet,
   call `ask_chatbot` bot `xapp` message `xapp status` ONCE:
   - `PENDING` → they haven't opened it; offer to resend.
   - `OPENED` → "I can see you've got the map open — tap the spot, then Confirm."
   - `RESULT {"lat":...,"lng":...,"address":"..."}` → done.
5. On RESULT: read back the ADDRESS (or the coordinates if address is empty) and confirm it.
   Then carry {lat, lng, address} forward like any other fact — e.g. search near it, book
   the pickup there, text it to someone.
6. SHARING a picked spot (with the caller's contact by SMS, or with the caller to keep):
   NEVER share the input map's link — it is a one-time session that shows a thank-you screen
   once used. Instead create a read-only shared map and send THAT link:
   `xapp create {"type":"map_view","title":"Pickup spot","prompt":"Shared from Mick's call","pin":{"lat":-27.4698,"lng":153.0251,"address":"..."},"zoom":15}`
   → reply is `LINK <url>`; SMS it like "Mick shared a spot with you: <address>. Map: <url>".
   Shared maps are fire-and-forget: no status polling, no result.
7. One INPUT xApp at a time per call. A new `xapp create` replaces the old one.
