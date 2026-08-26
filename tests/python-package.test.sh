#!/bin/sh
# Build fresh Python artifacts and exercise the installed console-script boundary.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tfs-ripast-python-package.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

ARTIFACTS="$TMP/dist"
VENV="$TMP/venv"
SDIST="$ARTIFACTS/tfs_ripast-0.1.1.tar.gz"
WHEEL="$ARTIFACTS/tfs_ripast-0.1.1-py3-none-any.whl"

"$PYTHON" -m build --sdist --wheel --outdir "$ARTIFACTS" "$ROOT/python"
[ -f "$SDIST" ] || { printf '%s\n' "missing sdist: $SDIST" >&2; exit 1; }
[ -f "$WHEEL" ] || { printf '%s\n' "missing wheel: $WHEEL" >&2; exit 1; }

"$PYTHON" - "$SDIST" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    names = archive.getnames()

if not any(name.endswith("/TEMPLATING.md") for name in names):
    raise SystemExit("sdist omits TEMPLATING.md referenced by its README")
for forbidden in ("/.agents/", "/.codex/", "/docs/superpowers/"):
    if any(forbidden in f"/{name}" for name in names):
        raise SystemExit(f"sdist contains internal agent artifact: {forbidden}")
PY

"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --disable-pip-version-check "$WHEEL"

CLI_WRAPPER="$TMP/tfs-ripast"
cat >"$CLI_WRAPPER" <<'EOF'
#!/bin/sh
exec node "$TFS_RIPAST_DIST_CLI" "$@"
EOF
chmod +x "$CLI_WRAPPER"
version="$(
  TFS_RIPAST_DIST_CLI="$ROOT/dist/cli.js" \
  TFS_RIPAST_EXECUTABLE="$CLI_WRAPPER" \
  "$VENV/bin/tfs-ripast-py" --version
)"
[ "$version" = "tfs-ripast 0.1.1" ] || {
  printf '%s\n' "unexpected installed console version: $version" >&2
  exit 1
}

SIGNALLED="$TMP/signalled-child"
cat >"$SIGNALLED" <<'EOF'
#!/bin/sh
kill -TERM "$$"
EOF
chmod +x "$SIGNALLED"
set +e
TFS_RIPAST_EXECUTABLE="$SIGNALLED" "$VENV/bin/tfs-ripast-py" --version \
  >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 143 ] || {
  printf '%s\n' "installed console did not preserve SIGTERM status (got $status)" >&2
  exit 1
}

printf 'python-package.test.sh: ok\n'
