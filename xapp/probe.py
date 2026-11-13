"""Step 0 verification (README-xapp.md): does an xApp submission on a REST-endpoint session
execute the flow and write to Context?

Builds a throwaway flow "PVB xApp Probe" + REST endpoint in Mick Scratch:

  make    -> initAppSession -> showXAppHtml (button SDK.submit) -> "LINK <input.apps.url>"
  status  -> "STATE <context.probeState> RESULT <context.probeResult>"
  (xApp submission arrives with input.data._cognigy._app -> code node writes context)

Run:  python probe.py build     # create/refresh the flow + endpoint
      python probe.py make      # start a session, print the LINK + session id
      python probe.py status <session>
"""
import json
import sys

import cognigy as c

STATE = c.load_state()

PROBE_HTML = (
    '<div style="font-family:sans-serif;text-align:center;padding-top:4rem">'
    "<h1>PVB probe</h1>"
    '<p>Tap the button; the result should land in the Cognigy session context.</p>'
    '<button id="go" style="font-size:2rem;padding:1rem 2rem" '
    "onclick=\"SDK.submit({ok:true,at:Date.now()})\">Submit</button>"
    "</div>"
)

IS_APP_SUBMIT = "!!(input.data && input.data._cognigy && input.data._cognigy._app)"
IS_MAKE = "String(input.text||'').trim().toLowerCase().indexOf('make')===0"
IS_STATUS = "String(input.text||'').trim().toLowerCase().indexOf('status')===0"


def cond(expr):
    return {"condition": {"type": "condition", "rule": {"left": "1", "operand": "eq", "right": "1"}, "condition": expr}}


def say_config(text):
    return {"say": {"data": "", "linear": False, "loop": False, "text": [text], "type": "text", "_cognigy": {}, "_data": {"_cognigy": {}}}}


def build():
    c.ensure_flow(STATE, "probeFlow", "PVB xApp Probe", "Throwaway. Verifies xApp submit on a REST session writes context.")
    f = c.Flow(STATE["probeFlow"]["id"])
    start = STATE["probeFlow"]["start"]

    # NOTE: branch content hangs off the then node's NEXT pointer (mode "append" with the
    # then node as target) — appendChild makes it a chart child the runtime never executes.
    i1 = f.ensure("xApp submission?", "if", cond(IS_APP_SUBMIT), start)
    f.ensure("Record submission", "code", {"code": (
        "context.probeResult = input.data._cognigy._app.payload || input.data._cognigy._app;"
        "context.probeState = 'done';"
    )}, f.then_of(i1))

    i2 = f.ensure("make?", "if", cond(IS_MAKE), i1)
    t2 = f.then_of(i2)
    init = f.ensure("xApp: Init Session", "initAppSession", {"pageTitle": "PVB Probe", "logo": "none"}, t2)
    show = f.ensure("xApp: Show Probe", "setHTMLAppState", {
        "mode": "body", "body": PROBE_HTML, "html": "", "waitForInput": False, "storeResultInContext": False, "contextKey": "result",
        "screenTitle": "", "showCloseIcon": False, "sendEventOnCloseIconClick": False, "autoOpen": True, "closeOnSubmit": False, "feedbackMessage": "",
    }, init)
    links = f.ensure("Remember xApp link", "code", {"code": "context.probeUrl = (input.apps && input.apps.url) || context.probeUrl || '';"}, show)
    f.ensure("Say LINK", "say", say_config("LINK {{input.apps.url}}"), links)

    i3 = f.ensure("status?", "if", cond(IS_STATUS), i2)
    f.ensure("Say status", "say", say_config(
        "STATE {{context.probeState || 'PENDING'}} RESULT {{JSON.stringify(context.probeResult || null)}}"
    ), f.then_of(i3))

    c.ensure_rest_endpoint(STATE, "probeEndpoint", "PVB xApp Probe REST", STATE["probeFlow"]["ref"])
    print("endpoint:", STATE["probeEndpoint"]["url"])


def make():
    out = c.talk(STATE["probeEndpoint"]["url"], "make")
    print("session:", out["_session"])
    for t in c.reply_texts(out):
        print("reply:", t)


def status(session):
    out = c.talk(STATE["probeEndpoint"]["url"], "status", session=session)
    for t in c.reply_texts(out):
        print("reply:", t)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    if cmd == "build":
        build()
    elif cmd == "make":
        make()
    elif cmd == "status":
        status(sys.argv[2])
    else:
        raise SystemExit(f"unknown command {cmd}")
