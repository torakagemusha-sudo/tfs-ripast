#!/usr/bin/env bash
# Collision-safe user-local install of tfs-ripast and the rpst alias.
# Never sudo. Default is preview; this script only writes prefix bins and a venv.
set -euo pipefail
umask 022

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
PREFIX=""

usage() {
  cat <<'EOF'
Usage: scripts/install-local.sh --prefix PREFIX

Build the TypeScript CLI, install the Python companion into
PREFIX/share/tfs-ripast-python, and write PREFIX/bin/tfs-ripast and
PREFIX/bin/rpst. Refuses unrelated managed targets. Never uses sudo.
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
PREFIX="$(cd -- "$PREFIX" && pwd -P)"
CLI="$ROOT/dist/cli.js"
BIN="$PREFIX/bin"
VENV="$PREFIX/share/tfs-ripast-python"
VENV_PARENT="$(dirname -- "$VENV")"
VENV_RECEIPT="$VENV/.tfs-ripast-managed"
VENV_RECEIPT_TEXT="tfs-ripast installer-managed Python venv v1"
TFS="$BIN/tfs-ripast"
RPST="$BIN/rpst"
PY_LAUNCHER="$BIN/tfs-ripast-py"
ENV_FILE=""
ENV_DIR=""

if [[ -d "$HOME/.local" ]]; then
  home_local="$(cd -- "$HOME/.local" && pwd)"
  if [[ "$PREFIX" == "$home_local" ]]; then
    ENV_DIR="$HOME/.config/tfs-ripast"
    ENV_FILE="$ENV_DIR/env.sh"
  fi
fi

managed_file_is_ours() {
  local path="$1"
  local marker="$2"

  [[ ! -e "$path" && ! -L "$path" ]] && return 0
  [[ -f "$path" && ! -L "$path" ]] || return 1
  head -n 3 "$path" 2>/dev/null | grep -F -x -q "$marker"
}

managed_venv_is_ours() {
  [[ ! -e "$VENV" && ! -L "$VENV" ]] && return 0
  [[ -d "$VENV" && ! -L "$VENV" ]] || return 1
  directory_is_not_shared_writable "$VENV" || return 1
  [[ -f "$VENV_RECEIPT" && ! -L "$VENV_RECEIPT" ]] || return 1
  file_is_not_shared_writable "$VENV_RECEIPT" || return 1
  [[ "$(cat "$VENV_RECEIPT")" == "$VENV_RECEIPT_TEXT" ]] || return 1
  [[ "$(wc -l <"$VENV_RECEIPT" | tr -d '[:space:]')" == "1" ]] || return 1
  [[ "$(wc -c <"$VENV_RECEIPT" | tr -d '[:space:]')" == "$((${#VENV_RECEIPT_TEXT} + 1))" ]]
}

write_venv_receipt() {
  local venv="$1"
  local receipt="$venv/.tfs-ripast-managed"
  local tmp
  tmp="$(mktemp "${receipt}.XXXXXX")"
  printf '%s\n' "$VENV_RECEIPT_TEXT" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$receipt"
}

directory_is_not_shared_writable() {
  local path="$1"
  local mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  mode="$(stat -c '%A' "$path" 2>/dev/null)" || return 1
  [[ "${mode:5:1}" != "w" && "${mode:8:1}" != "w" ]]
}

file_is_not_shared_writable() {
  local path="$1"
  local mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  mode="$(stat -c '%A' "$path" 2>/dev/null)" || return 1
  [[ "${mode:5:1}" != "w" && "${mode:8:1}" != "w" ]]
}

directory_slot_is_safe() {
  local path="$1"
  [[ ! -e "$path" && ! -L "$path" ]] && return 0
  directory_is_not_shared_writable "$path"
}

rpst_is_ours() {
  local rpst="$1"
  local tfs="$2"

  if [[ ! -e "$rpst" && ! -L "$rpst" ]]; then
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

  [[ -f "$rpst" && ! -L "$rpst" ]] || return 1
  head -n 3 "$rpst" 2>/dev/null \
    | grep -F -x -q '# Short alias for TFS Ripast. Same binary as tfs-ripast.' \
    && return 0
  head -n 3 "$rpst" 2>/dev/null \
    | grep -F -x -q '# Stable launcher for TFS Ripast. Does not depend on `npm link` remaining intact.' \
    && return 0

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
    die "ast-grep resolved to /usr/bin/sg (unrelated Unix sg); install ast-grep 0.45.1"
  fi
  ast_ver="$(ast-grep --version)"
  if [[ ! "$ast_ver" =~ ^ast-grep[[:space:]]+0\.45\.1$ ]]; then
    die "ast-grep --version must be exactly 0.45.1 (got: $ast_ver)"
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

write_env_atomic() {
  local dest="$1"
  local tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  cat >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
}

write_tfs_ripast() {
  local root_q
  printf -v root_q '%q' "$ROOT"
  write_atomic "$TFS" <<EOF
#!/usr/bin/env bash
# Stable launcher for TFS Ripast. Does not depend on \`npm link\` remaining intact.
set -euo pipefail

DEFAULT_ROOT=$root_q
ROOT="\${TFS_RIPAST_ROOT:-\$DEFAULT_ROOT}"
unset DEFAULT_ROOT
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
  for candidate in "\$HOME/.nvm/versions/node"/v25*/bin/node "\$HOME/.nvm/versions/node"/*/bin/node; do
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
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/tfs-ripast" "$@"
EOF
}

write_python_launcher() {
  local python_q tfs_q
  printf -v python_q '%q' "$VENV/bin/python"
  printf -v tfs_q '%q' "$TFS"
  write_atomic "$PY_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Python companion: Jinja RewritePlan compiler + launcher into the TypeScript CLI.
set -euo pipefail

DEFAULT_PY=$python_q
PY="\${TFS_RIPAST_PYTHON:-\$DEFAULT_PY}"
unset DEFAULT_PY
if [[ ! -x "\$PY" ]]; then
  echo "tfs-ripast-py: venv python not found at \$PY" >&2
  exit 127
fi

DEFAULT_TFS=$tfs_q
export TFS_RIPAST_EXECUTABLE="\${TFS_RIPAST_EXECUTABLE:-\$DEFAULT_TFS}"
unset DEFAULT_TFS
exec "\$PY" -m tfs_ripast "\$@"
EOF
}

maybe_update_env_sh() {
  local config_dir root_q python_q tfs_q
  [[ -n "$ENV_FILE" ]] || return 0

  config_dir="$HOME/.config"
  if [[ ! -e "$config_dir" && ! -L "$config_dir" ]]; then
    mkdir "$config_dir"
  fi
  directory_is_not_shared_writable "$config_dir" \
    || die "refusing shared-writable or symlinked config directory $config_dir"
  if [[ ! -e "$ENV_DIR" && ! -L "$ENV_DIR" ]]; then
    mkdir "$ENV_DIR"
  fi
  directory_is_not_shared_writable "$ENV_DIR" \
    || die "refusing shared-writable or symlinked config directory $ENV_DIR"
  managed_file_is_ours "$ENV_FILE" "# TFS Ripast local environment" \
    || die "refusing to overwrite unrelated $ENV_FILE"
  printf -v root_q '%q' "$ROOT"
  printf -v python_q '%q' "$VENV/bin/python"
  printf -v tfs_q '%q' "$TFS"
  write_env_atomic "$ENV_FILE" <<EOF
# TFS Ripast local environment
# Sourced from ~/.bashrc. Safe to source more than once.

_tfs_ripast_default_root=$root_q
_tfs_ripast_default_python=$python_q
_tfs_ripast_default_executable=$tfs_q
export TFS_RIPAST_ROOT="\${TFS_RIPAST_ROOT:-\$_tfs_ripast_default_root}"
export TFS_RIPAST_PYTHON="\${TFS_RIPAST_PYTHON:-\$_tfs_ripast_default_python}"
export TFS_RIPAST_EXECUTABLE="\${TFS_RIPAST_EXECUTABLE:-\$_tfs_ripast_default_executable}"
unset _tfs_ripast_default_root _tfs_ripast_default_python _tfs_ripast_default_executable

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
directory_is_not_shared_writable "$PREFIX" \
  || die "refusing shared-writable or symlinked prefix $PREFIX"
directory_slot_is_safe "$BIN" \
  || die "refusing shared-writable or symlinked bin directory $BIN"
directory_slot_is_safe "$VENV_PARENT" \
  || die "refusing shared-writable or symlinked venv parent $VENV_PARENT"
managed_file_is_ours "$TFS" '# Stable launcher for TFS Ripast. Does not depend on `npm link` remaining intact.' \
  || die "refusing to overwrite unrelated $TFS"
managed_file_is_ours "$PY_LAUNCHER" "# Python companion: Jinja RewritePlan compiler + launcher into the TypeScript CLI." \
  || die "refusing to overwrite unrelated $PY_LAUNCHER"
rpst_is_ours "$RPST" "$TFS" || die "refusing to overwrite unrelated $RPST"
if [[ -n "$ENV_FILE" ]]; then
  directory_is_not_shared_writable "$HOME" \
    || die "refusing shared-writable or symlinked home directory $HOME"
  directory_slot_is_safe "$HOME/.config" \
    || die "refusing shared-writable or symlinked config directory $HOME/.config"
  directory_slot_is_safe "$ENV_DIR" \
    || die "refusing shared-writable or symlinked config directory $ENV_DIR"
  managed_file_is_ours "$ENV_FILE" "# TFS Ripast local environment" \
    || die "refusing to overwrite unrelated $ENV_FILE"
fi
managed_venv_is_ours || die "refusing to use unrelated or symlinked $VENV"

command -v python3 >/dev/null 2>&1 || die "python3 not found"
(
  cd "$ROOT"
  npm run build
)

mkdir -p "$BIN" "$VENV_PARENT"
directory_is_not_shared_writable "$BIN" \
  || die "refusing shared-writable or symlinked bin directory $BIN"
directory_is_not_shared_writable "$VENV_PARENT" \
  || die "refusing shared-writable or symlinked venv parent $VENV_PARENT"

# Never execute an interpreter from a pre-existing environment. Build and
# populate a fresh venv, then publish it only after every command succeeds.
STAGED_VENV="$(mktemp -d "$VENV_PARENT/.tfs-ripast-python.stage.XXXXXX")"
if ! (
  python3 -m venv "$STAGED_VENV"
  "$STAGED_VENV/bin/python" -m pip install --disable-pip-version-check --upgrade "$ROOT/python"
  write_venv_receipt "$STAGED_VENV"
); then
  rm -rf -- "$STAGED_VENV"
  die "could not build managed Python venv"
fi

OLD_VENV=""
if [[ -e "$VENV" || -L "$VENV" ]]; then
  OLD_VENV="$(mktemp -d "$VENV_PARENT/.tfs-ripast-python.old.XXXXXX")"
  rmdir "$OLD_VENV"
  if ! mv "$VENV" "$OLD_VENV"; then
    rm -rf -- "$STAGED_VENV"
    die "could not stage the existing managed Python venv"
  fi
fi
if ! mv "$STAGED_VENV" "$VENV"; then
  [[ -z "$OLD_VENV" ]] || mv "$OLD_VENV" "$VENV"
  rm -rf -- "$STAGED_VENV"
  die "could not publish managed Python venv"
fi
if [[ -n "$OLD_VENV" ]]; then
  rm -rf -- "$OLD_VENV"
fi

write_tfs_ripast
write_rpst
write_python_launcher
maybe_update_env_sh

printf 'install-local: installed %s and %s (Python venv %s)\n' "$TFS" "$RPST" "$VENV"
