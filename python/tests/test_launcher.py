from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time

import pytest

from tfs_ripast import launcher
from tfs_ripast.__main__ import _read_bounded_utf8
from tfs_ripast.compiler import PlanCompilationError
from tfs_ripast.launcher import ExecutableNotFoundError, launch, resolve_executable


def make_fake_executable(tmp_path: Path, body: str) -> Path:
    executable = tmp_path / "tfs-ripast"
    executable.write_text(f"#!/usr/bin/env python3\n{body}\n", encoding="utf-8")
    executable.chmod(0o755)
    return executable


def test_template_input_reader_stops_at_its_byte_limit(tmp_path: Path) -> None:
    source = tmp_path / "large.json.j2"
    source.write_bytes(b"x" * 33)

    with pytest.raises(PlanCompilationError, match="exceeds 32 bytes"):
        _read_bounded_utf8(source, 32, "template")


def test_launch_forwards_exact_argv_stdin_streams_and_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    record = tmp_path / "record.json"
    executable = make_fake_executable(tmp_path, """
import json, os, sys
with open(os.environ["RECORD"], "w", encoding="utf-8") as stream:
    json.dump({"argv": sys.argv[1:], "stdin": sys.stdin.read()}, stream)
print("child-out", flush=True)
print("child-err", file=sys.stderr, flush=True)
raise SystemExit(23)
""")
    monkeypatch.setenv("TFS_RIPAST_EXECUTABLE", str(executable))
    monkeypatch.setenv("RECORD", str(record))

    code = launch(["apply", "a file.json", "--write"], stdin_data='{"plan":true}')

    captured = capfd.readouterr()
    assert code == 23
    assert captured.out == "child-out\n"
    assert captured.err == "child-err\n"
    assert json.loads(record.read_text(encoding="utf-8")) == {
        "argv": ["apply", "a file.json", "--write"],
        "stdin": '{"plan":true}',
    }


def test_executable_resolution_prefers_override_then_adjacent_then_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    override_dir = tmp_path / "override"
    override_dir.mkdir()
    override = make_fake_executable(override_dir, "")
    package = tmp_path / "package"
    (package / "bin").mkdir(parents=True)
    adjacent = make_fake_executable(package / "bin", "")
    path_dir = tmp_path / "path"
    path_dir.mkdir()
    fallback = make_fake_executable(path_dir, "")
    monkeypatch.setattr(launcher, "__file__", str(package / "launcher.py"))
    monkeypatch.setenv("PATH", str(path_dir))

    monkeypatch.setenv("TFS_RIPAST_EXECUTABLE", str(override))
    assert resolve_executable() == str(override.resolve())
    monkeypatch.delenv("TFS_RIPAST_EXECUTABLE")
    assert resolve_executable() == str(adjacent.resolve())
    adjacent.unlink()
    assert resolve_executable() == str(fallback.resolve())


def test_executable_resolution_skips_the_current_python_console_script(
    tmp_path: Path,
) -> None:
    python_bin = tmp_path / "python-bin"
    node_bin = tmp_path / "node-bin"
    python_bin.mkdir()
    node_bin.mkdir()
    current_wrapper = make_fake_executable(python_bin, "")
    typescript_cli = make_fake_executable(node_bin, "")

    assert resolve_executable(
        {"PATH": os.pathsep.join([str(python_bin), str(node_bin)])},
        excluded_executable=str(current_wrapper),
    ) == str(typescript_cli.resolve())


def test_missing_or_non_executable_override_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "missing"
    monkeypatch.setenv("TFS_RIPAST_EXECUTABLE", str(missing))

    with pytest.raises(ExecutableNotFoundError, match="override"):
        resolve_executable()


def test_spawn_failure_uses_the_launcher_dependency_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "tfs-ripast"
    executable.write_text("#!/definitely/missing/interpreter\n", encoding="utf-8")
    executable.chmod(0o755)
    monkeypatch.setenv("TFS_RIPAST_EXECUTABLE", str(executable))

    with pytest.raises(ExecutableNotFoundError, match="could not start"):
        launch(["--help"])


def test_module_compiles_template_and_sends_concrete_plan_to_typescript_stdin(tmp_path: Path) -> None:
    record = tmp_path / "record.json"
    executable = make_fake_executable(tmp_path, """
import json, os, sys
with open(os.environ["RECORD"], "w", encoding="utf-8") as stream:
    json.dump({"argv": sys.argv[1:], "stdin": json.load(sys.stdin)}, stream)
""")
    template = tmp_path / "migration.json.j2"
    template.write_text(
        '{"version":1,"name":{{ name | tojson }},"root":".","operations":[],"policy":{},"validations":[]}',
        encoding="utf-8",
    )
    data = tmp_path / "data.json"
    data.write_text('{"name":"compiled"}', encoding="utf-8")
    environment = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).parents[1]),
        "TFS_RIPAST_EXECUTABLE": str(executable),
        "RECORD": str(record),
    }

    completed = subprocess.run(
        [sys.executable, "-m", "tfs_ripast", "plan", str(template), "--data", str(data), "--json", "--dry-run"],
        env=environment,
        check=False,
    )

    assert completed.returncode == 0
    assert json.loads(record.read_text(encoding="utf-8")) == {
        "argv": ["plan", "-", "--json", "--dry-run"],
        "stdin": {"version": 1, "name": "compiled", "root": ".", "operations": [], "policy": {}, "validations": []},
    }


def test_module_reports_hostile_template_without_traceback_or_launch(tmp_path: Path) -> None:
    marker = tmp_path / "launched"
    executable = make_fake_executable(
        tmp_path,
        'from pathlib import Path; import os; Path(os.environ["MARKER"]).touch()',
    )
    template = tmp_path / "hostile.json.j2"
    template.write_text("{{ missing_value }}", encoding="utf-8")
    data = tmp_path / "data.json"
    data.write_text("{}", encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, "-m", "tfs_ripast", "plan", str(template), "--data", str(data)],
        env={
            **os.environ,
            "PYTHONPATH": str(Path(__file__).parents[1]),
            "TFS_RIPAST_EXECUTABLE": str(executable),
            "MARKER": str(marker),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "missing_value" in completed.stderr
    assert "Traceback" not in completed.stderr
    assert not marker.exists()


@pytest.mark.parametrize("forwarded_signal", [signal.SIGINT, signal.SIGTERM])
def test_module_forwards_signals_to_only_the_spawned_child(
    tmp_path: Path, forwarded_signal: signal.Signals
) -> None:
    marker = tmp_path / "signal.txt"
    executable = make_fake_executable(tmp_path, """
import os, signal, sys, time
def stop(signum, frame):
    with open(os.environ["MARKER"], "w", encoding="utf-8") as stream:
        stream.write(str(signum))
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
print("ready", flush=True)
while True: time.sleep(0.05)
""")
    environment = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).parents[1]),
        "TFS_RIPAST_EXECUTABLE": str(executable),
        "MARKER": str(marker),
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "tfs_ripast", "inspect", "record.json"],
        env=environment,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline() == "ready\n"

    process.send_signal(forwarded_signal)
    assert process.wait(timeout=5) == -forwarded_signal
    assert marker.read_text(encoding="utf-8") == str(forwarded_signal)


@pytest.mark.skipif(os.name != "posix", reason="foreground process groups are POSIX-only")
def test_foreground_process_group_signal_reaches_child_exactly_once(tmp_path: Path) -> None:
    marker = tmp_path / "signals.bin"
    executable = make_fake_executable(tmp_path, """
import os, signal, sys, time
deadline = None
def interrupt(signum, frame):
    global deadline
    with open(os.environ["MARKER"], "ab", buffering=0) as stream:
        stream.write(b"x")
    if deadline is None:
        deadline = time.monotonic() + 0.5
signal.signal(signal.SIGINT, interrupt)
print("ready", flush=True)
while deadline is None or time.monotonic() < deadline:
    time.sleep(0.01)
raise SystemExit(37 if open(os.environ["MARKER"], "rb").read() == b"x" else 91)
""")
    process = subprocess.Popen(
        [sys.executable, "-m", "tfs_ripast", "inspect", "record.json"],
        env={
            **os.environ,
            "PYTHONPATH": str(Path(__file__).parents[1]),
            "TFS_RIPAST_EXECUTABLE": str(executable),
            "MARKER": str(marker),
        },
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline() == "ready\n"

    os.killpg(process.pid, signal.SIGINT)

    assert process.wait(timeout=5) == 37
    assert marker.read_bytes() == b"x"


@pytest.mark.skipif(os.name != "posix", reason="sequential signal delivery is POSIX-only")
def test_two_sequential_sigints_each_reach_the_child_once(tmp_path: Path) -> None:
    marker = tmp_path / "signals.bin"
    executable = make_fake_executable(tmp_path, """
import os, signal, time
count = 0
deadline = time.monotonic() + 2
def interrupt(signum, frame):
    global count
    count += 1
    with open(os.environ["MARKER"], "ab", buffering=0) as stream:
        stream.write(b"x")
signal.signal(signal.SIGINT, interrupt)
print("ready", flush=True)
while count < 2 and time.monotonic() < deadline:
    time.sleep(0.01)
raise SystemExit(38 if count == 2 else 90)
""")
    process = subprocess.Popen(
        [sys.executable, "-m", "tfs_ripast", "inspect", "record.json"],
        env={
            **os.environ,
            "PYTHONPATH": str(Path(__file__).parents[1]),
            "TFS_RIPAST_EXECUTABLE": str(executable),
            "MARKER": str(marker),
        },
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline() == "ready\n"

    process.send_signal(signal.SIGINT)
    for _ in range(100):
        if marker.exists() and marker.read_bytes() == b"x":
            break
        time.sleep(0.01)
    assert marker.read_bytes() == b"x"
    process.send_signal(signal.SIGINT)

    assert process.wait(timeout=5) == 38
    assert marker.read_bytes() == b"xx"


@pytest.mark.skipif(os.name != "posix", reason="POSIX signal timing probe")
def test_signal_arriving_during_resolution_is_relayed_after_spawn() -> None:
    sleeper = shutil.which("sleep")
    assert sleeper is not None
    helper = "\n".join([
        "import os, signal",
        "from tfs_ripast import launcher",
        "def resolve_while_signalled(environment=None):",
        " os.kill(os.getpid(), signal.SIGTERM)",
        f" return {sleeper!r}",
        "launcher.resolve_executable = resolve_while_signalled",
        "raise SystemExit(launcher.launch(['5']))",
    ])

    completed = subprocess.run(
        [sys.executable, "-c", helper],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
        check=False,
    )

    assert completed.returncode == 256 - signal.SIGTERM
