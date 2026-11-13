"""End-to-end test of the Cognigy half of the xApp bridge (no PVB, no phone):

  1. xapp create {map_pin spec}        -> expect LINK <url>
  2. (browser opens the page)          -> xapp status expect OPENED
  3. (browser taps the map + Confirm)  -> xapp status expect RESULT {lat,lng,address}

The browser steps run in headless Chromium via e2e-browser.mjs (the PVB repo's playwright).
"""
import json
import re
import subprocess
import sys
import time

import cognigy as c

STATE = c.load_state()
URL = STATE["bridgeEndpoint"]["url"]

SPEC = {
    "type": "map_pin",
    "title": "Pickup location",
    "prompt": "Drop a pin where the courier should pick up",
    "center": {"lat": -27.4698, "lng": 153.0251},
    "zoom": 14,
}


def say(session, text):
    out = c.talk(URL, text, session=session)
    return c.reply_texts(out), out["_session"]


def main():
    replies, session = say(None, "xapp create " + json.dumps(SPEC))
    print("create ->", replies)
    link = next((r for r in replies if r.startswith("LINK ")), "")
    assert link, "no LINK reply"
    url = link.split(" ", 1)[1].strip()

    # help line sanity + status before opening
    print("status ->", say(session, "xapp status")[0], "(expect PENDING)")

    # drive the page while polling: the out-of-band opened ping should flip status to OPENED
    # before the browser taps Confirm.
    proc = subprocess.Popen(["node", "e2e-browser.mjs", url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    opened = False
    for _ in range(10):
        time.sleep(1.5)
        replies, _ = say(session, "xapp status")
        if replies and replies[0] == "OPENED":
            opened = True
            print("status -> ['OPENED'] (page load ping worked)")
            break
        if replies and replies[0].startswith("RESULT"):
            opened = True  # already past opened — fine
            break
    out, err = proc.communicate(timeout=120)
    print(out[-2000:])
    if proc.returncode != 0:
        print(err[-1500:])
        sys.exit("browser step failed")
    if not opened:
        print("WARNING: OPENED was never observed (ping may have failed)")

    for attempt in range(6):
        time.sleep(1.5)
        replies, _ = say(session, "xapp status")
        print("status ->", replies)
        if replies and replies[0].startswith("RESULT "):
            result = json.loads(replies[0][7:])
            assert isinstance(result.get("lat"), (int, float)) and isinstance(result.get("lng"), (int, float)), result
            print("PASS: RESULT with lat/lng; address:", (result.get("address") or "(none)")[:90])
            return
    sys.exit("no RESULT after submit")


if __name__ == "__main__":
    main()
