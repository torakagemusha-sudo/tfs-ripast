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

PREFIX="$TMP/prefix"
mkdir -p "$PREFIX"

"$INSTALLER" --prefix "$PREFIX"

TFS="$PREFIX/bin/tfs-ripast"
RPST="$PREFIX/bin/rpst"

[ -x "$TFS" ] || fail "missing executable $TFS"
[ -x "$RPST" ] || fail "missing executable $RPST"

TFS_VER="$("$TFS" --version)"
RPST_VER="$("$RPST" --version)"
[ "$TFS_VER" = "$RPST_VER" ] || fail "version mismatch: '$TFS_VER' vs '$RPST_VER'"
[ "$TFS_VER" = "tfs-ripast 0.1.1" ] || fail "unexpected version: $TFS_VER"

# Pre-existing unrelated rpst must be refused without overwrite.
COLLIDE="$TMP/collide"
mkdir -p "$COLLIDE/bin"
printf '%s\n' '#!/bin/sh' 'echo unrelated-rpst' >"$COLLIDE/bin/rpst"
chmod +x "$COLLIDE/bin/rpst"
cp "$COLLIDE/bin/rpst" "$TMP/rpst.orig"

set +e
"$INSTALLER" --prefix "$COLLIDE"
status=$?
set -e

[ "$status" -ne 0 ] || fail "installer should refuse an unrelated rpst (exit 0)"
cmp -s "$COLLIDE/bin/rpst" "$TMP/rpst.orig" || fail "unrelated rpst was overwritten"
[ ! -e "$COLLIDE/bin/tfs-ripast" ] || fail "refused install still wrote tfs-ripast"

printf 'install-local.test.sh: ok\n'
