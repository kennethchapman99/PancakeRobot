#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE="22.22.2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.pancake-runtime"
cd "$ROOT_DIR"

# Homebrew/global npm can export prefix vars that poison nvm/npm. The wrapper owns this repo runtime.
unset npm_config_prefix || true
unset NPM_CONFIG_PREFIX || true
unset PREFIX || true

cmd="${1:-web}"
shift || true

have() { command -v "$1" >/dev/null 2>&1; }

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

select_repo_node() {
  local platform archive node_dir node_bin url tmp_file
  platform="$(detect_platform)"
  archive="node-v$REQUIRED_NODE-$platform.tar.xz"
  node_dir="$RUNTIME_DIR/node-v$REQUIRED_NODE-$platform"
  node_bin="$node_dir/bin/node"
  url="https://nodejs.org/dist/v$REQUIRED_NODE/$archive"
  tmp_file="$RUNTIME_DIR/$archive"

  if [ ! -x "$node_bin" ]; then
    mkdir -p "$RUNTIME_DIR"
    echo "[Pancake Robot] Installing repo-local Node v$REQUIRED_NODE for $platform..."
    if have curl; then
      curl -fsSL "$url" -o "$tmp_file"
    elif have wget; then
      wget -q "$url" -O "$tmp_file"
    else
      echo "[Pancake Robot] Need curl or wget to download Node runtime." >&2
      exit 1
    fi
    tar -xJf "$tmp_file" -C "$RUNTIME_DIR"
    rm -f "$tmp_file"
  fi

  export PATH="$node_dir/bin:$PATH"
  hash -r || true

  [ "$(current_node_version)" = "v$REQUIRED_NODE" ]
}

ensure_node() {
  if select_repo_node; then
    return 0
  fi

  echo "[Pancake Robot] Could not activate repo-local Node $REQUIRED_NODE." >&2
  echo "Current node: $(current_node_version) ($(command -v node 2>/dev/null || echo 'not found'))" >&2
  echo "Runtime dir: $RUNTIME_DIR" >&2
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
    echo "[Pancake Robot] runtime: $RUNTIME_DIR"
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
