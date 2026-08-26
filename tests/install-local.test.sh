#!/bin/sh
# Collision-safe local installer. Uses a temp prefix; never sudo.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
INSTALLER="$ROOT/scripts/install-local.sh"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -ne 0 ] || fail "installer test must not run as root"

[ -f "$INSTALLER" ] || fail "missing installer: $INSTALLER"
[ -x "$INSTALLER" ] || fail "installer is not executable: $INSTALLER"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tfs-ripast-install-test.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# Host env.sh points TFS_RIPAST_ROOT at another tree; isolate the prefix bins.
unset TFS_RIPAST_ROOT || true
unset TFS_RIPAST_EXECUTABLE || true
unset TFS_RIPAST_PYTHON || true

HOME_DIR="$TMP/home"
PREFIX="$TMP/prefix"
mkdir -p "$HOME_DIR" "$PREFIX"

# A custom prefix must not require HOME/.local to exist or create env.sh.
HOME="$HOME_DIR" "$INSTALLER" --prefix "$PREFIX"

TFS="$PREFIX/bin/tfs-ripast"
RPST="$PREFIX/bin/rpst"
PY_LAUNCHER="$PREFIX/bin/tfs-ripast-py"

[ -x "$TFS" ] || fail "missing executable $TFS"
[ -x "$RPST" ] || fail "missing executable $RPST"
[ -x "$PY_LAUNCHER" ] || fail "missing executable $PY_LAUNCHER"
[ ! -e "$HOME_DIR/.config/tfs-ripast/env.sh" ] || fail "custom prefix wrote managed env.sh"

TFS_VER="$("$TFS" --version)"
RPST_VER="$("$RPST" --version)"
PY_VER="$("$PY_LAUNCHER" --version)"
[ "$TFS_VER" = "$RPST_VER" ] || fail "version mismatch: '$TFS_VER' vs '$RPST_VER'"
[ "$TFS_VER" = "$PY_VER" ] || fail "Python launcher version mismatch: '$TFS_VER' vs '$PY_VER'"
[ "$TFS_VER" = "tfs-ripast 0.1.1" ] || fail "unexpected version: $TFS_VER"

# A reinstall may replace generated targets.
HOME="$HOME_DIR" "$INSTALLER" --prefix "$PREFIX"

# The documented macOS install path must accept BSD stat(1), whose format
# option is -f rather than GNU stat's -c.
BSD_STAT_BIN="$TMP/bsd-stat-bin"
BSD_STAT_PREFIX="$TMP/bsd-stat-prefix"
BSD_STAT_HOME="$TMP/bsd-stat-home"
mkdir -p "$BSD_STAT_BIN" "$BSD_STAT_HOME"
cat >"$BSD_STAT_BIN/stat" <<'EOF'
#!/bin/sh
if [ "${1-}" = "-c" ]; then
  exit 64
fi
if [ "${1-}" != "-f" ]; then
  exit 65
fi
format="$2"
shift 2
case "$format" in
  '%Sp') exec python3 -c 'import os, stat, sys; print(stat.filemode(os.stat(sys.argv[1]).st_mode))' "$1" ;;
  '%d:%i') exec python3 -c 'import os, sys; value = os.stat(sys.argv[1]); print(f"{value.st_dev}:{value.st_ino}")' "$1" ;;
  *) exit 66 ;;
esac
EOF
chmod +x "$BSD_STAT_BIN/stat"
HOME="$BSD_STAT_HOME" PATH="$BSD_STAT_BIN:$PATH" "$INSTALLER" --prefix "$BSD_STAT_PREFIX"
[ -x "$BSD_STAT_PREFIX/bin/tfs-ripast" ] || fail "BSD stat install did not publish tfs-ripast"

# Older macOS releases do not provide realpath(1); Python is already a required
# installer dependency and must supply the canonicalization fallback.
NO_REALPATH_BIN="$TMP/no-realpath-bin"
NO_REALPATH_PREFIX="$TMP/no-realpath-prefix"
NO_REALPATH_HOME="$TMP/no-realpath-home"
mkdir -p "$NO_REALPATH_BIN" "$NO_REALPATH_HOME"
cat >"$NO_REALPATH_BIN/realpath" <<'EOF'
#!/bin/sh
exit 99
EOF
chmod +x "$NO_REALPATH_BIN/realpath"
HOME="$NO_REALPATH_HOME" PATH="$NO_REALPATH_BIN:$PATH" "$INSTALLER" --prefix "$NO_REALPATH_PREFIX"
[ -x "$NO_REALPATH_PREFIX/bin/tfs-ripast" ] || fail "realpath-free install did not publish tfs-ripast"

# Generated launchers must shell-quote installer-controlled path defaults. This
# prefix contains quotes, command substitutions, backticks, and a newline; none
# may become active shell syntax when the launcher is parsed later.
HOSTILE_RUN="$TMP/hostile-run"
HOSTILE_HOME="$TMP/hostile-home"
HOSTILE_BIN="$TMP/hostile-bin"
HOSTILE_NAME="$(printf '%s\n%s' "prefix-'\$(touch\${IFS}PWNED)-\`touch\${IFS}BACKTICK\`" 'continued')"
HOSTILE_PREFIX="$TMP/$HOSTILE_NAME"
mkdir -p "$HOSTILE_RUN" "$HOSTILE_HOME" "$HOSTILE_BIN"
cat >"$HOSTILE_BIN/python3" <<'EOF'
#!/bin/sh
if [ "${1-}" = "-m" ] && [ "${2-}" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
if [ "${1-}" = "-m" ] && [ "${2-}" = "pip" ]; then
  exit 0
fi
if [ "${1-}" = "-m" ] && [ "${2-}" = "tfs_ripast" ] && [ "${3-}" = "--version" ]; then
  printf '%s\n' 'tfs-ripast 0.1.1'
  exit 0
fi
exit 2
EOF
chmod +x "$HOSTILE_BIN/python3"
HOME="$HOSTILE_HOME" PATH="$HOSTILE_BIN:$PATH" "$INSTALLER" --prefix "$HOSTILE_PREFIX"
(
  cd "$HOSTILE_RUN"
  "$HOSTILE_PREFIX/bin/tfs-ripast-py" --version >/dev/null
)
[ ! -e "$HOSTILE_RUN/PWNED" ] || fail "generated launcher executed command substitution from prefix"
[ ! -e "$HOSTILE_RUN/BACKTICK" ] || fail "generated launcher executed backticks from prefix"

# The optional environment file uses the same literal encoding when HOME/.local
# itself contains hostile shell syntax.
HOSTILE_ENV_NAME="$(printf '%s\n%s' "home-'\$(touch\${IFS}ENV_PWNED)-\`touch\${IFS}ENV_BACKTICK\`" 'continued')"
HOSTILE_ENV_HOME="$TMP/$HOSTILE_ENV_NAME"
HOSTILE_ENV_PREFIX="$HOSTILE_ENV_HOME/.local"
HOSTILE_ENV_RUN="$TMP/hostile-env-run"
mkdir -p "$HOSTILE_ENV_PREFIX" "$HOSTILE_ENV_RUN"
HOME="$HOSTILE_ENV_HOME" PATH="$HOSTILE_BIN:$PATH" "$INSTALLER" --prefix "$HOSTILE_ENV_PREFIX"
(
  cd "$HOSTILE_ENV_RUN"
  HOME="$HOSTILE_ENV_HOME" bash -c '. "$1"' _ "$HOSTILE_ENV_HOME/.config/tfs-ripast/env.sh"
)
[ ! -e "$HOSTILE_ENV_RUN/ENV_PWNED" ] || fail "env.sh executed command substitution from HOME"
[ ! -e "$HOSTILE_ENV_RUN/ENV_BACKTICK" ] || fail "env.sh executed backticks from HOME"

# The optional environment file must not follow a symlinked or shared-writable
# config directory, even when env.sh itself does not exist yet.
ENV_SYMLINK_HOME="$TMP/env-symlink-home"
ENV_SYMLINK_TARGET="$TMP/env-symlink-target"
ENV_SYMLINK_PREFIX="$ENV_SYMLINK_HOME/.local"
mkdir -p "$ENV_SYMLINK_HOME/.config" "$ENV_SYMLINK_PREFIX" "$ENV_SYMLINK_TARGET"
ln -s "$ENV_SYMLINK_TARGET" "$ENV_SYMLINK_HOME/.config/tfs-ripast"
set +e
HOME="$ENV_SYMLINK_HOME" PATH="$HOSTILE_BIN:$PATH" "$INSTALLER" --prefix "$ENV_SYMLINK_PREFIX"
status=$?
set -e
[ "$status" -ne 0 ] || fail "installer accepted a symlinked env.sh parent"
[ ! -e "$ENV_SYMLINK_TARGET/env.sh" ] || fail "installer wrote env.sh through a parent symlink"
[ ! -e "$ENV_SYMLINK_PREFIX/bin/tfs-ripast" ] || fail "env parent collision wrote tfs-ripast"

ENV_WRITABLE_HOME="$TMP/env-writable-home"
ENV_WRITABLE_PREFIX="$ENV_WRITABLE_HOME/.local"
ENV_WRITABLE_DIR="$ENV_WRITABLE_HOME/.config/tfs-ripast"
mkdir -p "$ENV_WRITABLE_PREFIX" "$ENV_WRITABLE_DIR"
chmod 0777 "$ENV_WRITABLE_DIR"
set +e
HOME="$ENV_WRITABLE_HOME" PATH="$HOSTILE_BIN:$PATH" "$INSTALLER" --prefix "$ENV_WRITABLE_PREFIX"
status=$?
set -e
[ "$status" -ne 0 ] || fail "installer accepted a shared-writable env.sh parent"
[ ! -e "$ENV_WRITABLE_DIR/env.sh" ] || fail "installer wrote env.sh in a shared-writable directory"

# The alias must resolve its sibling without GNU readlink(1), which is not
# available with the same flags on every supported platform.
NO_READLINK_BIN="$TMP/no-readlink-bin"
mkdir -p "$NO_READLINK_BIN"
cat >"$NO_READLINK_BIN/readlink" <<'EOF'
#!/bin/sh
exit 91
EOF
chmod +x "$NO_READLINK_BIN/readlink"
set +e
RPST_PORTABLE_VER="$(PATH="$NO_READLINK_BIN:$PATH" "$RPST" --version 2>&1)"
status=$?
set -e
[ "$status" -eq 0 ] || fail "rpst depends on non-portable readlink -f: $RPST_PORTABLE_VER"
[ "$RPST_PORTABLE_VER" = "tfs-ripast 0.1.1" ] || fail "unexpected portable rpst version: $RPST_PORTABLE_VER"

# A symlink at the managed Python environment path must be refused before the
# linked interpreter is invoked or any launchers are written.
SYMLINK_VENV_PREFIX="$TMP/symlink-venv-prefix"
SYMLINK_VENV_TARGET="$TMP/symlink-venv-target"
SYMLINK_VENV="$SYMLINK_VENV_PREFIX/share/tfs-ripast-python"
SYMLINK_VENV_INVOKED="$TMP/symlink-venv-invoked"
mkdir -p "$SYMLINK_VENV_PREFIX/share" "$SYMLINK_VENV_TARGET/bin" "$TMP/symlink-venv-home"
cat >"$SYMLINK_VENV_TARGET/bin/python" <<EOF
#!/bin/sh
: >"$SYMLINK_VENV_INVOKED"
exit 0
EOF
chmod +x "$SYMLINK_VENV_TARGET/bin/python"
ln -s "$SYMLINK_VENV_TARGET" "$SYMLINK_VENV"

set +e
HOME="$TMP/symlink-venv-home" "$INSTALLER" --prefix "$SYMLINK_VENV_PREFIX"
status=$?
set -e

[ "$status" -ne 0 ] || fail "installer accepted a symlinked Python venv"
[ ! -e "$SYMLINK_VENV_INVOKED" ] || fail "installer invoked a symlinked Python venv"
[ -L "$SYMLINK_VENV" ] || fail "installer replaced the symlinked Python venv"
[ ! -e "$SYMLINK_VENV_PREFIX/bin/tfs-ripast" ] || fail "symlinked venv collision wrote tfs-ripast"
[ ! -e "$SYMLINK_VENV_PREFIX/bin/rpst" ] || fail "symlinked venv collision wrote rpst"
[ ! -e "$SYMLINK_VENV_PREFIX/bin/tfs-ripast-py" ] || fail "symlinked venv collision wrote Python launcher"

# An existing Python environment that was not created by this installer must
# be refused before its interpreter is invoked or any launchers are written.
UNRELATED_VENV_PREFIX="$TMP/unrelated-venv-prefix"
UNRELATED_VENV="$UNRELATED_VENV_PREFIX/share/tfs-ripast-python"
UNRELATED_VENV_INVOKED="$TMP/unrelated-venv-invoked"
mkdir -p "$UNRELATED_VENV/bin" "$TMP/unrelated-venv-home"
cat >"$UNRELATED_VENV/bin/python" <<EOF
#!/bin/sh
: >"$UNRELATED_VENV_INVOKED"
exit 0
EOF
chmod +x "$UNRELATED_VENV/bin/python"

set +e
HOME="$TMP/unrelated-venv-home" "$INSTALLER" --prefix "$UNRELATED_VENV_PREFIX"
status=$?
set -e

[ "$status" -ne 0 ] || fail "installer accepted an unrelated existing Python venv"
[ ! -e "$UNRELATED_VENV_INVOKED" ] || fail "installer invoked an unrelated existing Python venv"
[ ! -e "$UNRELATED_VENV_PREFIX/bin/tfs-ripast" ] || fail "venv collision wrote tfs-ripast"
[ ! -e "$UNRELATED_VENV_PREFIX/bin/rpst" ] || fail "venv collision wrote rpst"
[ ! -e "$UNRELATED_VENV_PREFIX/bin/tfs-ripast-py" ] || fail "venv collision wrote Python launcher"

# A public receipt does not make an attacker-writable environment safe to
# execute. The installer must reject it before invoking the planted interpreter.
FORGED_VENV_PREFIX="$TMP/forged-venv-prefix"
FORGED_VENV="$FORGED_VENV_PREFIX/share/tfs-ripast-python"
FORGED_VENV_INVOKED="$TMP/forged-venv-invoked"
mkdir -p "$FORGED_VENV/bin" "$TMP/forged-venv-home"
printf '%s\n' 'tfs-ripast installer-managed Python venv v1' >"$FORGED_VENV/.tfs-ripast-managed"
cat >"$FORGED_VENV/bin/python" <<EOF
#!/bin/sh
: >"$FORGED_VENV_INVOKED"
exit 0
EOF
chmod +x "$FORGED_VENV/bin/python"
chmod 0777 "$FORGED_VENV" "$FORGED_VENV/bin"

set +e
HOME="$TMP/forged-venv-home" "$INSTALLER" --prefix "$FORGED_VENV_PREFIX"
status=$?
set -e

[ "$status" -ne 0 ] || fail "installer accepted an attacker-writable managed venv"
[ ! -e "$FORGED_VENV_INVOKED" ] || fail "installer invoked an attacker-writable managed venv"

# A symlink in the managed environment's ancestry must also be rejected.
ANCESTOR_PREFIX="$TMP/ancestor-symlink-prefix"
ANCESTOR_TARGET="$TMP/ancestor-symlink-target"
ANCESTOR_VENV="$ANCESTOR_TARGET/tfs-ripast-python"
ANCESTOR_INVOKED="$TMP/ancestor-symlink-invoked"
mkdir -p "$ANCESTOR_PREFIX" "$ANCESTOR_VENV/bin" "$TMP/ancestor-symlink-home"
printf '%s\n' 'tfs-ripast installer-managed Python venv v1' >"$ANCESTOR_VENV/.tfs-ripast-managed"
cat >"$ANCESTOR_VENV/bin/python" <<EOF
#!/bin/sh
: >"$ANCESTOR_INVOKED"
exit 0
EOF
chmod +x "$ANCESTOR_VENV/bin/python"
ln -s "$ANCESTOR_TARGET" "$ANCESTOR_PREFIX/share"

set +e
HOME="$TMP/ancestor-symlink-home" "$INSTALLER" --prefix "$ANCESTOR_PREFIX"
status=$?
set -e

[ "$status" -ne 0 ] || fail "installer accepted a symlinked venv ancestor"
[ ! -e "$ANCESTOR_INVOKED" ] || fail "installer invoked through a symlinked venv ancestor"

assert_collision_refused() {
  target="$1"
  prefix="$2"
  home="$3"
  original="$TMP/$(basename "$target").orig"

  mkdir -p "$(dirname "$target")" "$home"
  printf '%s\n' '#!/bin/sh' 'echo unrelated-target' >"$target"
  chmod +x "$target"
  cp "$target" "$original"

  set +e
  HOME="$home" "$INSTALLER" --prefix "$prefix"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "installer should refuse unrelated $target (exit 0)"
  cmp -s "$target" "$original" || fail "unrelated target was overwritten: $target"
  [ ! -e "$prefix/share/tfs-ripast-python" ] || fail "collision initialized Python venv: $target"
}

# Every managed target rejects an unrelated occupant before install mutation.
TFS_COLLIDE="$TMP/collide-tfs"
assert_collision_refused "$TFS_COLLIDE/bin/tfs-ripast" "$TFS_COLLIDE" "$TMP/collide-tfs-home"
[ ! -e "$TFS_COLLIDE/bin/rpst" ] || fail "tfs-ripast collision wrote rpst"
[ ! -e "$TFS_COLLIDE/bin/tfs-ripast-py" ] || fail "tfs-ripast collision wrote Python launcher"

PY_COLLIDE="$TMP/collide-py"
assert_collision_refused "$PY_COLLIDE/bin/tfs-ripast-py" "$PY_COLLIDE" "$TMP/collide-py-home"
[ ! -e "$PY_COLLIDE/bin/tfs-ripast" ] || fail "Python launcher collision wrote tfs-ripast"
[ ! -e "$PY_COLLIDE/bin/rpst" ] || fail "Python launcher collision wrote rpst"

RPST_COLLIDE="$TMP/collide-rpst"
assert_collision_refused "$RPST_COLLIDE/bin/rpst" "$RPST_COLLIDE" "$TMP/collide-rpst-home"
[ ! -e "$RPST_COLLIDE/bin/tfs-ripast" ] || fail "rpst collision wrote tfs-ripast"
[ ! -e "$RPST_COLLIDE/bin/tfs-ripast-py" ] || fail "rpst collision wrote Python launcher"

# Dangling aliases and unrelated scripts containing broad project substrings
# are collisions, not installer-owned launchers.
DANGLING_RPST_PREFIX="$TMP/dangling-rpst-prefix"
mkdir -p "$DANGLING_RPST_PREFIX/bin" "$TMP/dangling-rpst-home"
ln -s "$TMP/missing-rpst-target" "$DANGLING_RPST_PREFIX/bin/rpst"
set +e
HOME="$TMP/dangling-rpst-home" "$INSTALLER" --prefix "$DANGLING_RPST_PREFIX"
status=$?
set -e
[ "$status" -ne 0 ] || fail "installer accepted a dangling rpst symlink"
[ -L "$DANGLING_RPST_PREFIX/bin/rpst" ] || fail "installer replaced dangling rpst symlink"

SUBSTRING_RPST_PREFIX="$TMP/substring-rpst-prefix"
mkdir -p "$SUBSTRING_RPST_PREFIX/bin" "$TMP/substring-rpst-home"
printf '%s\n' '#!/bin/sh' '# TFS Ripast notes mention dist/cli.js' 'echo unrelated-tfs-ripast' >"$SUBSTRING_RPST_PREFIX/bin/rpst"
chmod +x "$SUBSTRING_RPST_PREFIX/bin/rpst"
cp "$SUBSTRING_RPST_PREFIX/bin/rpst" "$TMP/substring-rpst.orig"
set +e
HOME="$TMP/substring-rpst-home" "$INSTALLER" --prefix "$SUBSTRING_RPST_PREFIX"
status=$?
set -e
[ "$status" -ne 0 ] || fail "installer accepted an unrelated rpst substring match"
cmp -s "$SUBSTRING_RPST_PREFIX/bin/rpst" "$TMP/substring-rpst.orig" || fail "installer replaced substring-matched rpst"

ENV_HOME="$TMP/collide-env-home"
ENV_PREFIX="$ENV_HOME/.local"
ENV_FILE="$ENV_HOME/.config/tfs-ripast/env.sh"
assert_collision_refused "$ENV_FILE" "$ENV_PREFIX" "$ENV_HOME"
[ ! -e "$ENV_PREFIX/bin/tfs-ripast" ] || fail "env.sh collision wrote tfs-ripast"
[ ! -e "$ENV_PREFIX/bin/rpst" ] || fail "env.sh collision wrote rpst"
[ ! -e "$ENV_PREFIX/bin/tfs-ripast-py" ] || fail "env.sh collision wrote Python launcher"

# Provider preflight requires the exact supported ast-grep patch version.
WRONG_AST_BIN="$TMP/wrong-ast-bin"
WRONG_AST_PREFIX="$TMP/wrong-ast-prefix"
mkdir -p "$WRONG_AST_BIN"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "ast-grep 0.45.0"' >"$WRONG_AST_BIN/ast-grep"
chmod +x "$WRONG_AST_BIN/ast-grep"
set +e
HOME="$TMP/wrong-ast-home" PATH="$WRONG_AST_BIN:$PATH" "$INSTALLER" --prefix "$WRONG_AST_PREFIX"
status=$?
set -e
[ "$status" -ne 0 ] || fail "installer accepted ast-grep 0.45.0"
[ ! -e "$WRONG_AST_PREFIX/share/tfs-ripast-python" ] || fail "wrong ast-grep initialized Python venv"

printf 'install-local.test.sh: ok\n'
