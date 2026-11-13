---
id: SOP-010
title: Filling in forms
kind: sop
priority: 3
tags: [forms]
triggers: [form, fill in, fill out, enter my, my address, my name is, my email, my phone, book a, booking, appointment, register, contact form]
---
# SOP-010 Filling in forms

1. Read the form first: list the fields that are required (name, email, phone, address, date). Ask the caller for the ones you do not have, one or two at a time.
2. Read each value back once before typing it ("I've got your email as mick at example dot com, is that right?"). Spell out anything unusual.
3. Type with `type_text` without submit; use `select_option` for dropdowns; for date pickers prefer typing the date if the field accepts it.
4. Check the PAGE STATE after filling: fields show their value; fix anything wrong before submitting.
5. Submitting a form that sends a message, books, registers or pays is a transaction: SOP-002 applies (read back, get a yes, then click with confirmed true).
6. After submitting, read the confirmation or any validation error shown on the page.
