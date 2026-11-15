#!/usr/bin/env bash
# 2026-11-03 (mick-agentic-browser): start the server (Git Bash / Linux / macOS).
# ngrok is NOT started here: run `npm run tunnel` (ngrok http --url=mick.au.ngrok.io 3005) yourself.
#
#   ./start.sh                 # dev mode: restart-safe watcher (scripts/dev.mjs), headed Chromium, port from .env (3005)
#   ./start.sh --once          # no watch (plain node)
#   ./start.sh --headless      # headless Chromium (sites with bot checks will refuse it)
#   ./start.sh --port 3006
#   ./start.sh --bg            # detach: log to logs/server.log, print the pid
#   ./start.sh --stop          # stop the instance of THIS app on the port (never other node processes)
#   ./start.sh --status        # health of the running instance
set -euo pipefail
cd "$(dirname "$0")"

WATCH=1; HEADLESS=""; BG=0; ACTION="start"; PORT_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) WATCH=0; shift ;;
    --headless) HEADLESS=true; shift ;;
    --headed) HEADLESS=false; shift ;;
    --bg) BG=1; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status) ACTION="status"; shift ;;
    --port) PORT_OVERRIDE="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- env ---------------------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "no .env: copy .env.example to .env and fill GEMINI_API_KEY, JAMBONZ_*, PUBLIC_HOST" >&2
  exit 1
fi
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r'; }
PORT="${PORT_OVERRIDE:-$(env_get PORT)}"; PORT="${PORT:-3005}"
PUBLIC_HOST="$(env_get PUBLIC_HOST)"

# --- helpers -----------------------------------------------------------------
# PID of a node process that is THIS app listening on $PORT (Windows: PowerShell; else lsof).
app_pid_on_port() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "
      \$c = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | Where-Object { \$_.OwningProcess -ne 0 } | Select-Object -First 1
      if (\$c) { \$p = Get-CimInstance Win32_Process -Filter \"ProcessId = \$(\$c.OwningProcess)\"
        if (\$p -and \$p.Name -match 'node' -and \$p.CommandLine -match 'src[\\\\/]app\.js') { \$p.ProcessId } }" 2>/dev/null | tr -d '\r '
  else
    for p in $(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
      if ps -o command= -p "$p" | grep -q 'src/app.js'; then echo "$p"; return; fi
    done
  fi
}
health() { curl -s --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null; }

case "$ACTION" in
  status)
    if h="$(health)" && [[ -n "$h" ]]; then
      echo "$h" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('status   ', j.status);console.log('console  ', 'http://localhost:$PORT');console.log('harness  ', j.harness_url);console.log('conductor', j.conductor_url.replace(/token=.*/,'token=…'), '('+j.ws_auth+')');console.log('lanes    ', JSON.stringify(j.lanes));console.log('kb       ', j.kb.backend, '|', j.kb.qdrant, '|', j.kb.embeddings);console.log('obs      ', j.observability.backend);console.log('browser  ', j.browser.running?'running':'stopped', 'headless='+j.browser.headless, 'tabs='+j.browser.tabs.join(','));console.log('calls    ', JSON.stringify(j.live_calls));})"
    else
      echo "not running on port $PORT"; exit 1
    fi; exit 0 ;;
  stop)
    pid="$(app_pid_on_port || true)"
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || taskkill //PID "$pid" //F >/dev/null 2>&1 || true; echo "stopped pid $pid on port $PORT"
    else echo "no mick-agentic-browser instance on port $PORT"; fi
    exit 0 ;;
esac

# --- preflight ---------------------------------------------------------------
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then echo "node >= 22 required (have $(node -v))" >&2; exit 1; fi
if [[ ! -d node_modules ]]; then echo "installing dependencies…"; npm install --no-audit --no-fund; fi
# Playwright's Chromium for this playwright version (no-op when present).
npx --no-install playwright install chromium >/dev/null 2>&1 || echo "warn: could not verify Chromium (npx playwright install chromium)"
# The console's jambonz WebRTC SDK bundle.
npm run -s build:vendor >/dev/null && echo "vendor bundle: public/vendor/jambonz-client.js"

# Evict a previous instance of THIS app on the port (other processes are left alone).
pid="$(app_pid_on_port || true)"
if [[ -n "$pid" ]]; then echo "replacing previous instance (pid $pid) on port $PORT"; kill "$pid" 2>/dev/null || taskkill //PID "$pid" //F >/dev/null 2>&1 || true; sleep 1; fi

# --- run -----------------------------------------------------------------------
export PORT
[[ -n "$HEADLESS" ]] && export BROWSER_HEADLESS="$HEADLESS"
mkdir -p logs
# 16 Nov: the watcher is scripts/dev.mjs — it defers a restart while a call, an IVR map or a task
# turn is live (GET /api/busy) instead of killing them the way `node --watch` did.
if (( WATCH )); then cmd=(node scripts/dev.mjs); else cmd=(node src/app.js); fi

echo "mick-agentic-browser on http://localhost:$PORT  (watch=$WATCH headless=${BROWSER_HEADLESS:-$(env_get BROWSER_HEADLESS)})"
echo "  console    http://localhost:$PORT"
if [[ -n "$PUBLIC_HOST" ]]; then
  echo "  harness    wss://$PUBLIC_HOST/harness?role=navigator&session=main   (Agent Studio custom harness URL)"
  echo "  conductor  wss://$PUBLIC_HOST/ws?token=…                             (jambonz application hook)"
  echo "  tunnel     ngrok http --url=$PUBLIC_HOST $PORT                       (run it yourself)"
fi

if (( BG )); then
  nohup "${cmd[@]}" > logs/server.log 2>&1 &
  echo "started in background, pid $!, log logs/server.log"
  for _ in $(seq 1 30); do sleep 1; if health >/dev/null 2>&1 && [[ -n "$(health)" ]]; then "$0" --status --port "$PORT"; exit 0; fi; done
  echo "server did not answer within 30 s; see logs/server.log" >&2; exit 1
else
  exec "${cmd[@]}"
fi
