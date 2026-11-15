#!/bin/bash

# Backup script for the Personal Voice Browser repository.
#
# Commits everything in the working tree as "Backup: <timestamp>" and pushes to
# GitHub (origin/main). If the GitHub repository does not exist yet it is created
# — with the GitHub CLI when installed, otherwise with a GITHUB_TOKEN — and the
# push is retried. Before anything is committed the script refuses to continue if
# a secret or personal-data file is about to be tracked.
#
# Usage:
#   ./backup-repo.sh                 # commit + push (creates the repo if missing, PRIVATE)
#   ./backup-repo.sh --public        # same, but a newly created repo is public
#   ./backup-repo.sh --dry-run       # show what would be committed; no commit, no push
#   ./backup-repo.sh -h|--help
#
# Creating the repo without the GitHub CLI: export GITHUB_TOKEN=<a classic token
# with the "repo" scope, or a fine-grained token with Administration: write> and
# run the script again. Never put the token in this file or in .env.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

GITHUB_USER="${GITHUB_USER:-mickjdunbar}"
REPO_NAME="${REPO_NAME:-personal-voice-browser}"
REPO="$GITHUB_USER/$REPO_NAME"
REMOTE_URL="https://github.com/$REPO.git"
BRANCH="main"
VISIBILITY="private"
DRY_RUN=0

# Paths that must never reach GitHub (mirrors .gitignore; belt and braces).
SENSITIVE_RE='^(\.env$|\.mcp-servers\.json$|\.tasks\.json$|\.tasks-media/|\.test-dial\.json$|\.live-calls\.json$|\.kb-cache\.json$|\.chatbots\.json$|memory/|knowledge/KB-contacts\.md$|knowledge/KB-family\.md$|knowledge/caller-preferences\.md$|public/recaps/|public/ivr-maps/|.ivr-maps/|.who-answered.json|\.profile/|profiles/|logs/|dist/)'

usage() {
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
    case "$arg" in
        --public) VISIBILITY="public" ;;
        --private) VISIBILITY="private" ;;
        --dry-run|-n) DRY_RUN=1 ;;
        -h|--help|help) usage; exit 0 ;;
        *) echo "Unknown option: $arg"; echo; usage; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

echo "=================================="
echo "Personal Voice Browser — GitHub backup"
echo "Timestamp: $TIMESTAMP"
echo "Repo:      $REPO ($BRANCH)"
echo "=================================="

# --- 0. a git repo on the right branch, with the remote set -------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Initialising git repository..."
    git init -q
fi
current_branch=$(git branch --show-current || true)
if [[ "$current_branch" != "$BRANCH" ]]; then
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        git checkout -q "$BRANCH"
    else
        git checkout -q -b "$BRANCH" 2>/dev/null || git branch -M "$BRANCH"
    fi
fi
if git remote get-url origin >/dev/null 2>&1; then
    existing=$(git remote get-url origin)
    if [[ "$existing" != "$REMOTE_URL" ]]; then
        echo "⚠ origin is $existing (expected $REMOTE_URL) — leaving it as is"
        REMOTE_URL="$existing"
    fi
else
    git remote add origin "$REMOTE_URL"
    echo "✓ origin set to $REMOTE_URL"
fi

# --- 1. safety: nothing secret or personal may be tracked ---------------------
echo "Checking for secrets and personal data..."
# what would be added by `git add -A` plus what is already tracked
candidates=$( (git ls-files; git ls-files --others --exclude-standard) | sort -u )
bad=$(echo "$candidates" | grep -E "$SENSITIVE_RE" || true)
if [[ -n "$bad" ]]; then
    echo "✗ Refusing to continue — these paths must stay out of the repository:"
    echo "$bad" | sed 's/^/    /'
    echo "  Add them to .gitignore (or 'git rm --cached <path>' if already tracked) and run again."
    exit 1
fi
# a quick scan of text files that WILL be committed for key-shaped strings
leaks=$(echo "$candidates" | grep -E '\.(js|mjs|md|html|css|json|sh|txt|py)$' | grep -v -E '^(package-lock\.json|docs/showcase-)' \
    | xargs -r grep -l -E '(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[bp]-[0-9A-Za-z-]{20,}|ghp_[0-9A-Za-z]{30,}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' 2>/dev/null || true)
if [[ -n "$leaks" ]]; then
    echo "✗ Refusing to continue — these files look like they contain an API key or private key:"
    echo "$leaks" | sed 's/^/    /'
    exit 1
fi
echo "✓ Nothing sensitive would be published"

# --- 2. commit ----------------------------------------------------------------
if [[ -z $(git status -s) ]]; then
    echo "✓ No changes to commit"
else
    echo "Changes detected:"
    git status -s | head -40
    [[ $(git status -s | wc -l) -gt 40 ]] && echo "    … $(git status -s | wc -l) files in total"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "(dry run) would commit as: Backup: $TIMESTAMP"
    else
        git add -A
        git commit -q -m "Backup: $TIMESTAMP"
        echo "✓ Commit created: Backup: $TIMESTAMP"
    fi
fi
if [[ $DRY_RUN -eq 1 ]]; then
    echo "(dry run) would push $BRANCH to $REMOTE_URL"
    exit 0
fi

# --- 3. push; create the GitHub repository if it does not exist ---------------
create_repo() {
    if command -v gh >/dev/null 2>&1; then
        echo "Creating $REPO on GitHub with the GitHub CLI ($VISIBILITY)..."
        gh repo create "$REPO" "--$VISIBILITY" --description "Personal Voice Browser — a jambonz custom-harness agent that discovers the right channel (web, phone, chat, text, MCP) at runtime" >/dev/null
        return 0
    fi
    local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    if [[ -n "$token" ]]; then
        echo "Creating $REPO on GitHub with the REST API ($VISIBILITY)..."
        local private_json="true"; [[ "$VISIBILITY" == "public" ]] && private_json="false"
        local code
        code=$(curl -s -o /tmp/pvb-create-repo.json -w "%{http_code}" -X POST https://api.github.com/user/repos \
            -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
            -d "{\"name\":\"$REPO_NAME\",\"private\":$private_json,\"description\":\"Personal Voice Browser — a jambonz custom-harness agent that discovers the right channel (web, phone, chat, text, MCP) at runtime\"}")
        if [[ "$code" == "201" ]]; then return 0; fi
        echo "✗ GitHub API answered HTTP $code:"; sed -n '1,5p' /tmp/pvb-create-repo.json; return 1
    fi
    cat <<EOF
✗ The repository $REPO does not exist and I have no way to create it from here.
  Pick one:
    a) install the GitHub CLI and sign in, then run this script again:
         winget install GitHub.cli
         gh auth login
    b) export GITHUB_TOKEN=<token with repo scope> and run this script again
    c) create it by hand at https://github.com/new
         name: $REPO_NAME   visibility: $VISIBILITY   (no README, no .gitignore)
       then run this script again — it will push.
EOF
    return 1
}

echo "Pushing $BRANCH to $REMOTE_URL..."
if out=$(git push -u origin "$BRANCH" 2>&1); then
    echo "$out" | tail -2
else
    if echo "$out" | grep -qi "repository not found\|does not appear to be a git repository"; then
        echo "Repository not found on GitHub."
        create_repo || exit 1
        echo "Pushing again..."
        git push -u origin "$BRANCH" 2>&1 | tail -2
    else
        echo "$out"
        exit 1
    fi
fi

echo ""
echo "=================================="
echo "✓ Done — https://github.com/$REPO"
echo "=================================="
