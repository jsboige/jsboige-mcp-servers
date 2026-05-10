#!/usr/bin/env bash
# Ensure .env exists for roo-state-manager — restores from .env.template if missing.
# Issue #2089 — Bash equivalent of ensure-env.ps1
# Exit codes: 0 = OK, 1 = missing template, 2 = placeholders detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RSM_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$RSM_DIR/.env"
TEMPLATE_FILE="$RSM_DIR/.env.template"

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log_info()  { [[ $QUIET -eq 0 ]] && echo "[ensure-env] $*"; }
log_warn()  { echo "[ensure-env] WARN: $*" >&2; }
log_error() { echo "[ensure-env] ERROR: $*" >&2; }

if [[ ! -f "$TEMPLATE_FILE" ]]; then
    log_error ".env.template missing at $TEMPLATE_FILE"
    exit 1
fi

# Read keys (lines like KEY=value, ignoring comments and blank lines)
read_keys() {
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1
}

template_keys=$(read_keys "$TEMPLATE_FILE")

if [[ ! -f "$ENV_FILE" ]]; then
    log_warn ".env missing — restoring from .env.template"
    cp "$TEMPLATE_FILE" "$ENV_FILE"
    log_warn "Restored .env contains __FILL_ME__ placeholders for secrets:"
    grep -E '^[^#=]+=__FILL_ME__' "$ENV_FILE" | cut -d= -f1 | sed 's/^/  - /' >&2
    log_warn "Edit .env and replace __FILL_ME__ with real values before starting MCP server."
    exit 2
fi

env_keys=$(read_keys "$ENV_FILE")
missing_keys=$(comm -23 <(echo "$template_keys" | sort -u) <(echo "$env_keys" | sort -u))

if [[ -n "$missing_keys" ]]; then
    missing_count=$(echo "$missing_keys" | grep -c .)
    log_warn "$missing_count keys missing from .env (present in template):"
    echo "$missing_keys" | sed 's/^/  - /' >&2
    log_warn "Appending missing keys from template..."
    {
        echo ""
        echo "# === Added by ensure-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        for key in $missing_keys; do
            grep -E "^$key=" "$TEMPLATE_FILE" || true
        done
    } >> "$ENV_FILE"
    log_warn "Missing keys appended. Edit .env to fill placeholders."
fi

placeholder_keys=$(grep -E '^[^#=]+=__FILL_ME__' "$ENV_FILE" | cut -d= -f1 || true)
if [[ -n "$placeholder_keys" ]]; then
    placeholder_count=$(echo "$placeholder_keys" | grep -c .)
    log_warn "$placeholder_count keys still contain __FILL_ME__ placeholders:"
    echo "$placeholder_keys" | sed 's/^/  - /' >&2
    exit 2
fi

template_count=$(echo "$template_keys" | grep -c .)
log_info ".env OK — all $template_count keys present, no placeholders detected."
exit 0
