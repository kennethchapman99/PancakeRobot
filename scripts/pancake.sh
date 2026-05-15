#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE="22.22.2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Homebrew/global npm can export prefix vars that make nvm refuse to run.
# The wrapper owns the project runtime, so clear them before selecting Node.
unset npm_config_prefix || true
unset NPM_CONFIG_PREFIX || true
unset PREFIX || true

cmd="${1:-web}"
shift || true

have() { command -v "$1" >/dev/null 2>&1; }

current_node_version() {
  node -v 2>/dev/null || true
}

select_node_with_volta() {
  local volta_home="${VOLTA_HOME:-$HOME/.volta}"
  if [ -d "$volta_home/bin" ]; then
    export VOLTA_HOME="$volta_home"
    export PATH="$VOLTA_HOME/bin:$PATH"
    hash -r || true
  fi

  if ! have volta; then
    return 1
  fi

  volta install "node@$REQUIRED_NODE" >/dev/null
  volta pin "node@$REQUIRED_NODE" >/dev/null
  hash -r || true

  [ "$(current_node_version)" = "v$REQUIRED_NODE" ]
}

select_node_with_nvm() {
  unset npm_config_prefix || true
  unset NPM_CONFIG_PREFIX || true
  unset PREFIX || true

  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
    return 1
  fi

  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm install "$REQUIRED_NODE" >/dev/null
  nvm use "$REQUIRED_NODE" >/dev/null
  hash -r || true

  [ "$(current_node_version)" = "v$REQUIRED_NODE" ]
}

ensure_node() {
  if select_node_with_volta; then
    return 0
  fi

  if select_node_with_nvm; then
    return 0
  fi

  echo "[Pancake Robot] Could not activate Node $REQUIRED_NODE." >&2
  echo "Current node: $(current_node_version) ($(command -v node 2>/dev/null || echo 'not found'))" >&2
  echo "" >&2
  echo "Fix options:" >&2
  echo "  1) Install/use Volta: curl https://get.volta.sh | bash" >&2
  echo "  2) Or run: source ~/.nvm/nvm.sh && nvm install $REQUIRED_NODE && nvm use $REQUIRED_NODE" >&2
  echo "  3) Then rerun: npm run pancake:doctor" >&2
  exit 1
}

ensure_node

actual="$(node -v)"
if [ "$actual" != "v$REQUIRED_NODE" ]; then
  echo "[Pancake Robot] Wrong Node version after setup: $actual; expected v$REQUIRED_NODE" >&2
  echo "[Pancake Robot] node path: $(command -v node)" >&2
  exit 1
fi

ensure_deps() {
  if [ ! -d node_modules ]; then
    npm install
  fi

  if ! node -e "require('better-sqlite3'); require('canvas');" >/dev/null 2>&1; then
    echo "[Pancake Robot] Rebuilding native modules for Node $REQUIRED_NODE..."
    npm rebuild better-sqlite3 canvas
  fi
}

case "$cmd" in
  doctor)
    echo "[Pancake Robot] repo: $ROOT_DIR"
    echo "[Pancake Robot] node: $(node -v) ($(command -v node))"
    echo "[Pancake Robot] npm:  $(npm -v) ($(command -v npm))"
    ensure_deps
    node scripts/ensure-node-runtime.js
    echo "[Pancake Robot] native modules OK"
    ;;
  install)
    npm install
    npm rebuild better-sqlite3 canvas
    node scripts/ensure-node-runtime.js
    ;;
  web)
    ensure_deps
    npm run web
    ;;
  test)
    ensure_deps
    npm test
    ;;
  cleanup|catalog:cleanup)
    ensure_deps
    npm run catalog:cleanup
    ;;
  stack|dev:mobile)
    ensure_deps
    npm run dev:mobile
    ;;
  telegram)
    ensure_deps
    npm run telegram
    ;;
  *)
    ensure_deps
    npm run "$cmd" -- "$@"
    ;;
esac
