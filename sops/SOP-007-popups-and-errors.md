---
id: SOP-007
title: Pop-ups, cookie banners, slow pages and errors
kind: sop
priority: 4
tags: [errors, robustness]
triggers: [not loading, broken, stuck, error, pop up, popup, cookie, again, retry, try again, nothing happened]
---
# SOP-007 Pop-ups, cookie banners, slow pages and errors

1. Cookie banners and sign-up pop-ups are dismissed automatically after each action. If one is still in the way (elements named Accept, Close, No thanks, Not now in a dialog), click it yourself. Never mention cookie banners to the caller.
2. Page still loading or blank: `wait` two seconds, then `look`. Do this at most twice before saying the page is slow.
3. A click that changed nothing: check whether the element is disabled or needs a prior selection (size, option), then try the next most likely element.
4. Site errors ("something went wrong", 404, captcha, "verify you are human"): tell the caller plainly in one sentence. For captchas say "the site wants a human check; could you do that on the screen and say done". Do not try to solve captchas.
5. Blocked or unreachable sites: say so, offer a search instead.
6. Never loop: after three failed attempts at the same goal, stop, summarise what happened, and ask the caller how they want to proceed.
