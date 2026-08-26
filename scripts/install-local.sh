#!/usr/bin/env bash
# Collision-safe user-local install of tfs-ripast and the rpst alias.
# Never sudo. Default is preview; this script only writes prefix bins and a venv.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PREFIX=""

usage() {
  cat <<'EOF'
Usage: scripts/install-local.sh --prefix PREFIX

Build the TypeScript CLI, install the Python companion into
PREFIX/share/tfs-ripast-python, and write PREFIX/bin/tfs-ripast and
PREFIX/bin/rpst. Refuses to overwrite an unrelated rpst. Never uses sudo.
EOF
}

die() {
  printf 'install-local: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix requires a directory"
      PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$PREFIX" ]] || die "required: --prefix PREFIX"
[[ "$(id -u)" -ne 0 ]] || die "refuse to run as root (never sudo)"

mkdir -p "$PREFIX"
PREFIX="$(cd -- "$PREFIX" && pwd)"
CLI="$ROOT/dist/cli.js"
BIN="$PREFIX/bin"
VENV="$PREFIX/share/tfs-ripast-python"
TFS="$BIN/tfs-ripast"
RPST="$BIN/rpst"
PY_LAUNCHER="$BIN/tfs-ripast-py"

rpst_is_ours() {
  local rpst="$1"
  local tfs="$2"
  local cli="$3"

  if [[ ! -e "$rpst" ]]; then
    return 0
  fi

  if [[ -e "$tfs" ]]; then
    local rpst_id tfs_id rpst_real tfs_real
    rpst_id="$(stat -c '%d:%i' "$rpst" 2>/dev/null || true)"
    tfs_id="$(stat -c '%d:%i' "$tfs" 2>/dev/null || true)"
    if [[ -n "$rpst_id" && "$rpst_id" == "$tfs_id" ]]; then
      return 0
    fi
    rpst_real="$(realpath "$rpst" 2>/dev/null || true)"
    tfs_real="$(realpath "$tfs" 2>/dev/null || true)"
    if [[ -n "$rpst_real" && -n "$tfs_real" && "$rpst_real" == "$tfs_real" ]]; then
      return 0
    fi
  fi

  if grep -F -q "$cli" "$rpst" 2>/dev/null; then
    return 0
  fi

  # Existing project alias: exec sibling tfs-ripast (see ~/.local/bin/rpst).
  if grep -q 'tfs-ripast' "$rpst" 2>/dev/null \
    && grep -E -q 'TFS Ripast|dist/cli\.js' "$rpst" 2>/dev/null; then
    return 0
  fi

  return 1
}

preflight_providers() {
  command -v rg >/dev/null 2>&1 || die "rg not found on PATH"
  rg --version >/dev/null || die "rg --version failed"

  command -v ast-grep >/dev/null 2>&1 || die "ast-grep not found on PATH"
  local ast_path ast_real ast_ver
  ast_path="$(command -v ast-grep)"
  ast_real="$(realpath "$ast_path")"
  if [[ "$ast_path" == /usr/bin/sg || "$ast_real" == /usr/bin/sg ]]; then
    die "ast-grep resolved to /usr/bin/sg (unrelated Unix sg); install ast-grep 0.45.x"
  fi
  ast_ver="$(ast-grep --version)"
  if [[ ! "$ast_ver" =~ ^ast-grep[[:space:]]+0\.45 ]]; then
    die "ast-grep --version must start with 0.45. (got: $ast_ver)"
  fi
}

write_atomic() {
  local dest="$1"
  local tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  cat >"$tmp"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$dest"
}

write_tfs_ripast() {
  write_atomic "$TFS" <<EOF
#!/usr/bin/env bash
# Stable launcher for TFS Ripast. Does not depend on \`npm link\` remaining intact.
set -euo pipefail

ROOT="\${TFS_RIPAST_ROOT:-$ROOT}"
CLI="\${ROOT}/dist/cli.js"

if [[ ! -f "\$CLI" ]]; then
  echo "tfs-ripast: CLI not built at \$CLI (run: cd \\"\$ROOT\\" && npm ci && npm run build)" >&2
  exit 127
fi

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in "\$HOME/.nvm/versions.node"/v25*/bin/node "\$HOME/.nvm/versions/node"/*/bin/node; do
    if [[ -x "\$candidate" ]]; then
      printf '%s\\n' "\$candidate"
      return 0
    fi
  done
  return 1
}

NODE="\$(resolve_node)" || {
  echo "tfs-ripast: node not found (need Node.js >= 24)" >&2
  exit 127
}

exec "\$NODE" "\$CLI" "\$@"
EOF
}

write_rpst() {
  write_atomic "$RPST" <<'EOF'
#!/usr/bin/env bash
# Short alias for TFS Ripast. Same binary as tfs-ripast.
exec "$(dirname "$(readlink -f "$0")")/tfs-ripast" "$@"
EOF
}

write_python_launcher() {
  write_atomic "$PY_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Python companion: Jinja RewritePlan compiler + launcher into the TypeScript CLI.
set -euo pipefail

PY="\${TFS_RIPAST_PYTHON:-$VENV/bin/python}"
if [[ ! -x "\$PY" ]]; then
  echo "tfs-ripast-py: venv python not found at \$PY" >&2
  exit 127
fi

export TFS_RIPAST_EXECUTABLE="\${TFS_RIPAST_EXECUTABLE:-$TFS}"
exec "\$PY" -m tfs_ripast "\$@"
EOF
}

maybe_update_env_sh() {
  local home_local env_dir env_file
  home_local="$(cd -- "$HOME/.local" && pwd)"
  [[ "$PREFIX" == "$home_local" ]] || return 0

  env_dir="$HOME/.config/tfs-ripast"
  env_file="$env_dir/env.sh"
  mkdir -p "$env_dir"
  cat >"$env_file" <<EOF
# TFS Ripast local environment
# Sourced from ~/.bashrc. Safe to source more than once.

export TFS_RIPAST_ROOT="\${TFS_RIPAST_ROOT:-$ROOT}"
export TFS_RIPAST_PYTHON="\${TFS_RIPAST_PYTHON:-$VENV/bin/python}"
export TFS_RIPAST_EXECUTABLE="\${TFS_RIPAST_EXECUTABLE:-$TFS}"

# Node is required by the CLI. Prefer an already-resolved node, then nvm v25+.
if ! command -v node >/dev/null 2>&1; then
  _tfs_ripast_node=""
  for _tfs_ripast_cand in "\$HOME/.nvm/versions/node"/v25*/bin/node "\$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "\$_tfs_ripast_cand" ]; then
      _tfs_ripast_node="\$_tfs_ripast_cand"
      break
    fi
  done
  if [ -n "\$_tfs_ripast_node" ]; then
    PATH="\$(dirname "\$_tfs_ripast_node"):\$PATH"
    export PATH
  fi
  unset _tfs_ripast_node _tfs_ripast_cand
fi
EOF
}

preflight_providers
rpst_is_ours "$RPST" "$TFS" "$CLI" || die "refusing to overwrite unrelated $RPST"

command -v python3 >/dev/null 2>&1 || die "python3 not found"
(
  cd "$ROOT"
  npm run build
)

mkdir -p "$BIN" "$(dirname "$VENV")"
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --disable-pip-version-check --upgrade "$ROOT/python"

write_tfs_ripast
write_rpst
write_python_launcher
maybe_update_env_sh

printf 'install-local: installed %s and %s (Python venv %s)\n' "$TFS" "$RPST" "$VENV"
