#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "=== Polkadot Stack Template - Frontend ==="
echo ""
log_info "This starts only the web app."
log_info "Override ports with STACK_PORT_OFFSET or STACK_*_PORT environment variables."
log_info "First run may take 1-2 minutes while npm dependencies install."
log_info "Works with either ./scripts/start-dev.sh or ./scripts/start-local.sh."
log_info "The Statement Store page requires the relay-backed path."
echo ""

require_port_free "$STACK_FRONTEND_PORT"

cd "$ROOT_DIR/web"
npm install

# Generate PAPI descriptors from the running chain
if curl -s -o /dev/null "$SUBSTRATE_RPC_HTTP" 2>/dev/null; then
    log_info "Node detected at $SUBSTRATE_RPC_WS - updating PAPI descriptors..."
    update_papi_descriptors
else
    log_warn "Node not running at $SUBSTRATE_RPC_WS"
    log_info "Start a chain first with ./scripts/start-dev.sh or ./scripts/start-local.sh"
    log_info "PAPI descriptors may be stale or missing."
    echo ""
fi

export_frontend_runtime_env
log_info "Frontend dev server: $FRONTEND_URL"
npm run dev -- --host 127.0.0.1 --port "$STACK_FRONTEND_PORT"
