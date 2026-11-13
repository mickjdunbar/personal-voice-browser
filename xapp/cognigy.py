"""Minimal Cognigy.AI REST client for the PVB xApp bridge build (na1, project "Mick Scratch").

The API key is read from COGNIGY_API_KEY, from xapp/.env, or (fallback) from the capstone
build's .env — it is never written anywhere by these scripts.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

API_BASE = "https://cognigy-api-na1.nicecxone.com/new/v2.0"
ENDPOINT_BASE = "https://cognigy-endpoint-na1.nicecxone.com"
PROJECT_ID = "6ab3b1d968465bd9152cec4a"  # Mick Scratch
CAPSTONE_ENV = Path("C:/Users/mick/Code/Current/vibes/cognigy/exato/capstone/mick/build/.env")

_locale = None  # {"id", "ref"} discovered once per run


def _read_env_key(p: Path) -> str:
    if not p.exists():
        return ""
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("COGNIGY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def api_key() -> str:
    key = os.environ.get("COGNIGY_API_KEY", "").strip() or _read_env_key(HERE / ".env") or _read_env_key(CAPSTONE_ENV)
    if not key:
        raise SystemExit("Set COGNIGY_API_KEY (env, xapp/.env, or the capstone build/.env)")
    return key


class ApiError(Exception):
    def __init__(self, status, body, method, path):
        super().__init__(f"{method} {path} -> {status}: {str(body)[:600]}")
        self.status = status
        self.body = body


def call(method, path, body=None, params=None, base=API_BASE, raw=False):
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        "X-API-Key": api_key(),
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = text
        raise ApiError(e.code, parsed, method, path) from None
    if raw:
        return text
    return json.loads(text) if text.strip() else None


def get(path, **params):
    return call("GET", path, params=params or None)


def post(path, body, **params):
    return call("POST", path, body=body, params=params or None)


def patch(path, body, **params):
    return call("PATCH", path, body=body, params=params or None)


def delete(path, **params):
    return call("DELETE", path, params=params or None)


def items(result):
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        if isinstance(result.get("items"), list):
            return result["items"]
        emb = result.get("_embedded")
        if isinstance(emb, dict):
            for v in emb.values():
                if isinstance(v, list):
                    return v
    return []


def locale():
    """First locale of the project: {"id", "ref"}."""
    global _locale
    if _locale is None:
        loc = items(get("/locales", projectId=PROJECT_ID))[0]
        _locale = {"id": loc["_id"], "ref": loc["referenceId"]}
    return _locale


# ---- Flow chart helpers -------------------------------------------------------

def chart(flow_id):
    return get(f"/flows/{flow_id}/chart", preferredLocaleId=locale()["id"])


def add_node(flow_id, target, node_type, label, config=None, mode="append", extension="@cognigy/basic-nodes", **extra):
    body = {"type": node_type, "extension": extension, "label": label, "target": target, "mode": mode, "config": config or {}}
    body.update(extra)
    created = post(f"/flows/{flow_id}/chart/nodes", body, preferredLocaleId=locale()["id"])
    return created.get("_id") or created.get("id")


def patch_node(flow_id, node_id, **fields):
    return patch(f"/flows/{flow_id}/chart/nodes/{node_id}", fields, preferredLocaleId=locale()["id"])


def delete_node(flow_id, node_id):
    return delete(f"/flows/{flow_id}/chart/nodes/{node_id}", preferredLocaleId=locale()["id"])


def load_state():
    p = HERE / "state.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_state(state):
    (HERE / "state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")


class Flow:
    """Label-addressed view of a flow chart (labels unique within the flow)."""

    def __init__(self, flow_id):
        self.id = flow_id
        self.refresh()

    def refresh(self):
        self.chart = chart(self.id)
        self.by_label = {}
        for n in self.chart["nodes"]:
            self.by_label.setdefault(n["label"], n)
        self.rel = {r["node"]: r for r in self.chart["relations"]}

    def get(self, label):
        return self.by_label.get(label)

    def child(self, parent_id, node_type):
        ids = self.rel.get(parent_id, {}).get("children", [])
        nodes = {n["_id"]: n for n in self.chart["nodes"]}
        return next((nodes[i] for i in ids if i in nodes and nodes[i]["type"] == node_type), None)

    def ensure(self, label, node_type, config, target, mode="append", extension="@cognigy/basic-nodes"):
        existing = self.get(label)
        if existing:
            patch_node(self.id, existing["_id"], config=config)
            return existing["_id"]
        nid = add_node(self.id, target, node_type, label, config, mode=mode, extension=extension)
        self.refresh()
        print("  +", node_type, label)
        return nid

    def then_of(self, if_id):
        self.refresh()
        return self.child(if_id, "then")["_id"]

    def remove(self, label):
        n = self.get(label)
        if n:
            delete_node(self.id, n["_id"])
            self.refresh()
            print("  - removed", label)


def ensure_flow(state, key, name, description=""):
    description = description.replace("(", "").replace(")", "").replace(":", ",")[:197]
    flows = items(get("/flows", projectId=PROJECT_ID, limit=100))
    flow = next((f for f in flows if f["name"] == name), None)
    if not flow:
        flow = post("/flows", {"projectId": PROJECT_ID, "name": name, "description": description})
        print("created flow", name)
    fid = flow["_id"]
    full = get(f"/flows/{fid}")
    ch = chart(fid)
    start = next(n for n in ch["nodes"] if n["type"] == "start")
    state[key] = {"id": fid, "ref": full["referenceId"], "start": start["_id"], "startRef": start["referenceId"]}
    save_state(state)
    return state[key]


def ensure_rest_endpoint(state, key, name, flow_ref):
    eps = items(get("/endpoints", projectId=PROJECT_ID, limit=100))
    ep = next((e for e in eps if e["name"] == name), None)
    if not ep:
        ep = post("/endpoints", {"projectId": PROJECT_ID, "channel": "rest", "name": name, "flowId": flow_ref, "localeId": locale()["ref"], "useContactProfiles": False})
        print("created endpoint", name)
    ep = get(f"/endpoints/{ep['_id']}")
    state[key] = {"id": ep["_id"], "url": ENDPOINT_BASE + "/" + ep["URLToken"]}
    save_state(state)
    return state[key]


def talk(url, text="", data=None, session=None, user="pvb-xapp-build"):
    """One message to a Cognigy REST endpoint."""
    import uuid
    session = session or "s-" + uuid.uuid4().hex[:12]
    body = json.dumps({"userId": user, "sessionId": session, "text": text, "data": data or {}}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.loads(r.read().decode())
    out["_ms"] = int((time.time() - t0) * 1000)
    out["_session"] = session
    return out


def reply_texts(out):
    """Every text part of a REST reply, in order."""
    parts = []
    for o in (out.get("outputStack") or []):
        if o.get("text"):
            parts.append(o["text"])
    if not parts and out.get("text"):
        parts.append(out["text"])
    return parts
