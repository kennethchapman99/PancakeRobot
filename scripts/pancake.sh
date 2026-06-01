#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE="22.22.2"
EXPECTED_ABI="127"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${PANCAKE_RUNTIME_DIR:-$ROOT_DIR/.pancake-runtime}"
cd "$ROOT_DIR"

# Zscaler TLS inspection re-signs HTTPS with a root Node doesn't ship. Point Node at
# the exported Zscaler root so the web server and every pipeline child it spawns can
# reach the Anthropic API regardless of which shell launched the wrapper.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$HOME/.certs/zscaler-root.pem" ]; then
  export NODE_EXTRA_CA_CERTS="$HOME/.certs/zscaler-root.pem"
fi

cmd="${1:-web}"
shift || true

have() { command -v "$1" >/dev/null 2>&1; }

print_help() {
  cat <<EOF
Pancake Robot launcher

Usage: ./bin/pancakerobot <command> [-- args]

The launcher pins Node.js $REQUIRED_NODE (via Volta or a repo-local runtime),
rebuilds native modules when the Node ABI changes, then runs the command.
You never need 'nvm use' or to remember a Node version.

Common commands:
  web                              Start the Release Cockpit web app
  test -- test/<file>.test.js      Run tests; everything after -- goes to the test runner
  stack                            Start the full local/mobile stack (default)
  doctor                           Verify the Node runtime + native modules
  install                          Install deps and rebuild native modules
  telegram                         Start the Telegram bot
  <npm-script> [-- args]           Run any package.json script

Examples:
  ./bin/pancakerobot web
  PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot web
  ./bin/pancakerobot test -- test/<file>.test.js
  ./bin/pancakerobot test -- test/magic-release-browsy-recordings.test.js
EOF
}

case "$cmd" in
  help|--help|-h)
    print_help
    exit 0
    ;;
esac

# Homebrew/global npm can export prefix vars that poison nvm/npm. The wrapper owns this repo runtime.
unset npm_config_prefix || true
unset NPM_CONFIG_PREFIX || true
unset PREFIX || true

current_node_version() {
  node -v 2>/dev/null || true
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "Unsupported OS: $os" >&2; return 1 ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "Unsupported architecture: $arch" >&2; return 1 ;;
  esac

  echo "$os-$arch"
}

NODE_SOURCE="unknown"

# 1. The active shell Node already matches the requirement.
use_current_node() {
  # Test hook: force the resolver to exercise repo-local/Volta/download instead.
  [ "${PANCAKE_FORCE_RESOLVE:-}" = "1" ] && return 1
  [ "$(current_node_version)" = "v$REQUIRED_NODE" ] || return 1
  NODE_SOURCE="current"
  return 0
}

# 2. A repo-local Node has already been downloaded — use it without touching the network.
use_repo_node_existing() {
  local platform node_dir node_bin
  platform="$(detect_platform)" || return 1
  node_dir="$RUNTIME_DIR/node-v$REQUIRED_NODE-$platform"
  node_bin="$node_dir/bin/node"
  [ -x "$node_bin" ] || return 1
  export PATH="$node_dir/bin:$PATH"
  hash -r || true
  [ "$(current_node_version)" = "v$REQUIRED_NODE" ] || return 1
  NODE_SOURCE="repo-local"
  return 0
}

# 3. Volta is installed — let it resolve (and fetch if needed) the pinned Node.
use_volta_node() {
  [ "${PANCAKE_DISABLE_VOLTA:-}" = "1" ] && return 1
  have volta || return 1
  local node_path node_bin_dir
  node_path="$(volta run --node "$REQUIRED_NODE" node -e 'process.stdout.write(process.execPath)' 2>/dev/null)" || return 1
  [ -n "$node_path" ] && [ -x "$node_path" ] || return 1
  node_bin_dir="$(dirname "$node_path")"
  export PATH="$node_bin_dir:$PATH"
  hash -r || true
  [ "$(current_node_version)" = "v$REQUIRED_NODE" ] || return 1
  NODE_SOURCE="volta"
  return 0
}

# 4. Last resort: download a repo-local Node from nodejs.org.
use_download_node() {
  [ "${PANCAKE_DISABLE_DOWNLOAD:-}" = "1" ] && return 1
  local platform archive node_dir node_bin url tmp_file
  platform="$(detect_platform)" || return 1
  archive="node-v$REQUIRED_NODE-$platform.tar.xz"
  node_dir="$RUNTIME_DIR/node-v$REQUIRED_NODE-$platform"
  node_bin="$node_dir/bin/node"
  url="https://nodejs.org/dist/v$REQUIRED_NODE/$archive"
  tmp_file="$RUNTIME_DIR/$archive"

  mkdir -p "$RUNTIME_DIR"
  echo "[Pancake Robot] Installing repo-local Node v$REQUIRED_NODE for $platform..." >&2
  if have curl; then
    curl -fsSL "$url" -o "$tmp_file" || return 1
  elif have wget; then
    wget -q "$url" -O "$tmp_file" || return 1
  else
    echo "[Pancake Robot] Need curl or wget to download the Node runtime." >&2
    return 1
  fi
  tar -xJf "$tmp_file" -C "$RUNTIME_DIR"
  rm -f "$tmp_file"

  [ -x "$node_bin" ] || return 1
  export PATH="$node_dir/bin:$PATH"
  hash -r || true
  [ "$(current_node_version)" = "v$REQUIRED_NODE" ] || return 1
  NODE_SOURCE="download"
  return 0
}

ensure_node() {
  if use_current_node; then return 0; fi
  if use_repo_node_existing; then return 0; fi
  if use_volta_node; then return 0; fi
  if use_download_node; then return 0; fi

  echo "" >&2
  echo "[Pancake Robot] Could not provide Node v$REQUIRED_NODE." >&2
  echo "  Active node: $(current_node_version) ($(command -v node 2>/dev/null || echo 'not found'))" >&2
  echo "  Runtime dir: $RUNTIME_DIR" >&2
  echo "  Volta:       $(command -v volta 2>/dev/null || echo 'not installed')" >&2
  echo "" >&2
  echo "Fix it with one of:" >&2
  echo "  - Install Volta (https://volta.sh), then re-run ./bin/pancakerobot <command>" >&2
  echo "  - volta install node@$REQUIRED_NODE" >&2
  echo "  - Restore network access so the launcher can download Node v$REQUIRED_NODE" >&2
  echo "" >&2
  echo "Then run the blessed command, e.g.:" >&2
  echo "  ./bin/pancakerobot test -- test/<file>.test.js" >&2
  exit 1
}

ensure_node

actual="$(node -v)"
if [ "$actual" != "v$REQUIRED_NODE" ]; then
  echo "[Pancake Robot] Wrong Node version after setup: $actual; expected v$REQUIRED_NODE" >&2
  echo "[Pancake Robot] node path: $(command -v node)" >&2
  exit 1
fi

# Allow an optional `--` separator before test args:
#   ./bin/pancakerobot test -- test/foo.test.js
if [ "$cmd" = "test" ] && [ "${1:-}" = "--" ]; then
  shift
fi

# Decide what we will run. RUN_KIND drives a special path (doctor/install);
# otherwise RUN_CMD is the npm invocation we exec.
RUN_KIND="run"
RUN_CMD=()
case "$cmd" in
  doctor)
    RUN_KIND="doctor"
    ;;
  install)
    RUN_KIND="install"
    ;;
  web)
    RUN_CMD=(npm run web)
    ;;
  test)
    RUN_CMD=(npm test -- "$@")
    ;;
  cleanup|catalog:cleanup)
    RUN_CMD=(npm run catalog:cleanup -- "$@")
    ;;
  release-cockpit:cleanup-tests)
    RUN_CMD=(npm run release-cockpit:cleanup-tests -- "$@")
    ;;
  stack|dev:mobile)
    RUN_CMD=(npm run dev:mobile)
    ;;
  telegram)
    RUN_CMD=(npm run telegram)
    ;;
  *)
    RUN_CMD=(npm run "$cmd" -- "$@")
    ;;
esac

# Test/diagnostic hook: resolve Node + parse the command, print the plan, and stop
# before installing deps or running anything.
if [ "${PANCAKE_PLAN_ONLY:-}" = "1" ]; then
  echo "PANCAKE_PLAN node_source=$NODE_SOURCE"
  echo "PANCAKE_PLAN node_version=$(node -v)"
  echo "PANCAKE_PLAN command=$cmd"
  echo "PANCAKE_PLAN run_kind=$RUN_KIND"
  if [ "$RUN_KIND" = "run" ]; then
    echo "PANCAKE_PLAN run=${RUN_CMD[*]}"
  fi
  exit 0
fi

native_modules_ok() {
  node --input-type=module - <<'EOF' >/dev/null 2>&1
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.prepare('SELECT 1 AS ok').get();
db.close();
const { createCanvas } = require('canvas');
const canvas = createCanvas(1, 1);
const ctx = canvas.getContext('2d');
ctx.fillRect(0, 0, 1, 1);
EOF
}

ensure_deps() {
  if [ ! -d node_modules ]; then
    npm install
  fi

  # A Node ABI change (e.g. switching major versions) breaks native addons.
  if ! native_modules_ok; then
    echo "[Pancake Robot] Rebuilding native modules for Node $REQUIRED_NODE (ABI $EXPECTED_ABI)..."
    npm rebuild better-sqlite3 canvas
  fi

  if ! native_modules_ok; then
    echo "[Pancake Robot] Native modules still invalid after rebuild; reinstalling dependencies..."
    rm -rf node_modules
    npm install
    npm rebuild better-sqlite3 canvas
  fi

  if ! native_modules_ok; then
    echo "[Pancake Robot] Native modules failed under Node $REQUIRED_NODE after reinstall." >&2
    exit 1
  fi
}

case "$RUN_KIND" in
  doctor)
    echo "[Pancake Robot] repo: $ROOT_DIR"
    echo "[Pancake Robot] runtime: $RUNTIME_DIR"
    echo "[Pancake Robot] node source: $NODE_SOURCE"
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
  run)
    ensure_deps
    exec "${RUN_CMD[@]}"
    ;;
esac
