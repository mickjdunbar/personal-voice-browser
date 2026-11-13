"""Builds the PVB xApp Bridge in Cognigy (na1, project "Mick Scratch"): one deterministic
flow + REST endpoint implementing the text protocol from README-xapp.md:

  xapp create {"type":"map_pin", ...spec}  ->  LINK <xapp session url>
  xapp status                              ->  PENDING | OPENED | RESULT {...} | ERROR ... | NONE
  (xApp page submissions arrive as flow executions with input.data._cognigy._app.payload:
   {kind:"opened"} marks opened; anything else is stored as the result.)

Run:  python build.py          # create/refresh everything
Then: python e2e.py            # full REST + headless-browser test of the loop
"""
import json
from pathlib import Path

import cognigy as c

STATE = c.load_state()
HERE = Path(__file__).resolve().parent

IS_SUBMISSION = "!!(input.data && input.data._cognigy && input.data._cognigy._app)"
IS_CREATE = "/^\\s*xapp\\s+create\\b/i.test(String(input.text||''))"
IS_STATUS = "/^\\s*xapp\\s+status\\b/i.test(String(input.text||''))"
IS_OPENED = "/^\\s*xapp\\s+opened\\b/i.test(String(input.text||''))"
IS_HELP = ("!(input.data && input.data._cognigy && input.data._cognigy._app) && "
           "!/^\\s*xapp\\s+(create|status|opened)\\b/i.test(String(input.text||''))")

# Any SDK.submit is a RESULT (the opened ping arrives out-of-band as "xapp opened" text —
# an in-band ping would make the shell tear the page down).
RECORD_SUBMISSION = """\
const p = (input.data._cognigy._app || {}).payload || {};
context.xapp = context.xapp || {};
context.xapp.result = p;
context.xapp.state = 'done';
"""

DONE_HTML = (
    '<!DOCTYPE html><html><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    '<script src="/sdk/app-page-sdk.js"></script>'
    '<style>body{margin:0;font:17px/1.5 system-ui,sans-serif;background:#0e1017;color:#f2f4fa;'
    'display:grid;place-items:center;min-height:100vh;text-align:center}'
    '.t{font-size:56px;margin-bottom:8px}p{color:#9aa3b8;margin:4px 0 0}</style></head>'
    '<body><div><div class="t">✅</div><h2>Got it — thanks!</h2>'
    "<p>You can go back to the call now.</p></div></body></html>"
)

PARSE_SPEC = """\
context.xapp = { state: 'pending', result: null, spec: null, error: '' };
try {
  const raw = String(input.text || '').replace(/^\\s*xapp\\s+create\\s*/i, '');
  const spec = JSON.parse(raw);
  if (!spec || typeof spec !== 'object' || !spec.type) throw new Error('spec must be a JSON object with a \"type\"');
  context.xapp.spec = spec;
} catch (err) {
  context.xapp.error = 'bad spec: ' + String((err && err.message) || err);
}
"""

BUILD_STATUS_REPLY = """\
const x = context.xapp || {};
context.xappReply =
  x.error ? ('ERROR ' + x.error)
  : x.state === 'done' ? ('RESULT ' + JSON.stringify(x.result))
  : x.state === 'opened' ? 'OPENED'
  : x.spec ? 'PENDING'
  : 'NONE (no xapp was created in this session; send: xapp create {json spec})';
"""

HELP_TEXT = ("COMMANDS: xapp create {\"type\":\"map_pin\",\"title\":\"...\",\"prompt\":\"...\","
             "\"center\":{\"lat\":-27.47,\"lng\":153.03},\"zoom\":13}  ->  replies LINK <url>. "
             "Then: xapp status  ->  PENDING | OPENED | RESULT {lat,lng,address}.")


def cond(expr):
    return {"condition": {"type": "condition", "rule": {"left": "1", "operand": "eq", "right": "1"}, "condition": expr}}


def say_config(text):
    return {"say": {"data": "", "linear": False, "loop": False, "text": [text], "type": "text", "_cognigy": {}, "_data": {"_cognigy": {}}}}


def show_config(html):
    return {
        "mode": "full", "html": html, "body": "", "waitForInput": False, "storeResultInContext": False, "contextKey": "result",
        "screenTitle": "", "showCloseIcon": False, "sendEventOnCloseIconClick": False, "autoOpen": True, "closeOnSubmit": False, "feedbackMessage": "",
    }


def build():
    html = (HERE / "page" / "xapp.html").read_text(encoding="utf-8")
    c.ensure_flow(STATE, "bridgeFlow", "PVB xApp Bridge",
                  "Text protocol for the Personal Voice Browser, xapp create spec returns LINK, xapp status returns PENDING, OPENED or RESULT. Submissions from the xApp page land in context.")
    f = c.Flow(STATE["bridgeFlow"]["id"])
    start = STATE["bridgeFlow"]["start"]

    # 1) xApp page submissions (a flow execution with input.data._cognigy._app): store the
    #    result, then render the static done page so the shell's post-submit teardown lands well.
    i1 = f.ensure("xApp submission?", "if", cond(IS_SUBMISSION), start)
    rec = f.ensure("Record submission", "code", {"code": RECORD_SUBMISSION}, f.then_of(i1))
    f.ensure("xApp: Show Done", "setHTMLAppState", show_config(DONE_HTML), rec)

    # 2) xapp create {spec}
    i2 = f.ensure("create?", "if", cond(IS_CREATE), i1)
    parse = f.ensure("Parse spec", "code", {"code": PARSE_SPEC}, f.then_of(i2))
    ok = f.ensure("Spec ok?", "if", cond("!context.xapp.error"), parse)
    init = f.ensure("xApp: Init Session", "initAppSession", {
        "logo": "none", "pageTitle": "Personal Voice Browser",
        "backgroundColor": "#0e1017", "textColor": "#f2f4fa",
        "appLoadingText": "Loading your map…",
        "intermediateScreenCustomizationType": "override",
        "intermediateScreenOverrideText": "Stay on the call — what you need will appear here.",
        "connectionScreenCustomizationType": "override",
        "connectionScreenOverrideConnectingText": "Connecting…",
        "connectionScreenOverrideInvalidText": "This link has expired.",
        "connectionScreenOverrideUnavailableText": "The page is not available right now.",
    }, f.then_of(ok))
    show = f.ensure("xApp: Show Page", "setHTMLAppState", show_config(html), init)
    link = f.ensure("Remember link", "code", {"code": "context.xapp.url = (input.apps && input.apps.url) || context.xapp.url || '';"}, show)
    f.ensure("Say LINK", "say", say_config("LINK {{context.xapp.url}}"), link)
    f.refresh()
    els = f.child(f.get("Spec ok?")["_id"], "else")
    f.ensure("Say spec error", "say", say_config("ERROR {{context.xapp.error}}"), els["_id"])

    # 3) xapp opened (out-of-band ping from the page itself)
    io = f.ensure("opened?", "if", cond(IS_OPENED), i2)
    f.ensure("Mark opened", "code", {"code": "context.xapp = context.xapp || {}; if (context.xapp.state !== 'done') context.xapp.state = 'opened';"}, f.then_of(io))

    # 4) xapp status
    i3 = f.ensure("status?", "if", cond(IS_STATUS), io)
    rep = f.ensure("Build status reply", "code", {"code": BUILD_STATUS_REPLY}, f.then_of(i3))
    f.ensure("Say status", "say", say_config("{{context.xappReply}}"), rep)

    # 5) anything else -> help line (never fires for submissions or matched commands)
    i4 = f.ensure("help?", "if", cond(IS_HELP), i3)
    f.ensure("Say help", "say", say_config(HELP_TEXT), f.then_of(i4))

    c.ensure_rest_endpoint(STATE, "bridgeEndpoint", "PVB xApp Bridge REST", STATE["bridgeFlow"]["ref"])
    # ensure_rest_endpoint never re-points an existing endpoint: do it explicitly (rebuilds).
    ep = c.get("/endpoints/" + STATE["bridgeEndpoint"]["id"])
    if ep.get("flowId") != STATE["bridgeFlow"]["ref"]:
        c.patch("/endpoints/" + STATE["bridgeEndpoint"]["id"], {"flowId": STATE["bridgeFlow"]["ref"]})
        print("endpoint re-pointed at the bridge flow")

    # The page needs the endpoint URL baked in (for the out-of-band opened ping) — patch the
    # Show Page node now the endpoint is known.
    f.refresh()
    final_html = html.replace("__PVB_XAPP_ENDPOINT__", STATE["bridgeEndpoint"]["url"])
    c.patch_node(f.id, f.get("xApp: Show Page")["_id"], config=show_config(final_html))
    print("bridge endpoint:", STATE["bridgeEndpoint"]["url"])


if __name__ == "__main__":
    build()
