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

from tfs_ripast import __main__ as cli_main
from tfs_ripast import launcher
from tfs_ripast.__main__ import _read_bounded_utf8
from tfs_ripast.compiler import PlanCompilationError
from tfs_ripast.launcher import ExecutableNotFoundError, launch, resolve_executable


def make_fake_executable(
    tmp_path: Path, body: str, name: str = "tfs-ripast"
) -> Path:
    executable = tmp_path / name
    executable.write_text(f"#!/usr/bin/env python3\n{body}\n", encoding="utf-8")
    executable.chmod(0o755)
    return executable


def simulate_windows_executable_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    class WindowsApi:
        @staticmethod
        def NeedCurrentDirectoryForExePath(_command: str) -> bool:
            return True

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shutil, "_winapi", WindowsApi())
    monkeypatch.setattr(launcher, "_WINDOWS", True, raising=False)


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


def test_missing_or_non_executable_override_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "missing"
    monkeypatch.setenv("TFS_RIPAST_EXECUTABLE", str(missing))

    with pytest.raises(ExecutableNotFoundError, match="override"):
        resolve_executable()


def test_explicit_environment_without_path_does_not_use_ambient_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_dir = tmp_path / "ambient-path"
    path_dir.mkdir()
    make_fake_executable(path_dir, "")
    monkeypatch.setenv("PATH", str(path_dir))

    with pytest.raises(ExecutableNotFoundError, match="was not found"):
        resolve_executable({})


def test_windows_path_only_uses_current_directory_when_explicit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "package"
    current = tmp_path / "current"
    searched = tmp_path / "searched"
    current.mkdir()
    searched.mkdir()
    executable = make_fake_executable(current, "", "tfs-ripast.EXE")
    monkeypatch.setattr(launcher, "__file__", str(package / "launcher.py"))
    monkeypatch.chdir(current)
    monkeypatch.setenv("PATHEXT", ".EXE")
    simulate_windows_executable_lookup(monkeypatch)

    with pytest.raises(ExecutableNotFoundError, match="was not found"):
        resolve_executable({"PATH": str(searched), "PATHEXT": ".EXE"})

    assert resolve_executable({"PATH": ".", "PATHEXT": ".EXE"}) == str(
        executable.resolve()
    )
    assert resolve_executable(
        {"PATH": f";{searched}", "PATHEXT": ".EXE"}
    ) == str(executable.resolve())


def test_windows_path_uses_supplied_pathext_instead_of_ambient(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "package"
    searched = tmp_path / "searched"
    searched.mkdir()
    make_fake_executable(searched, "", "tfs-ripast.WRAPPER")
    native = make_fake_executable(searched, "", "tfs-ripast.EXE")
    monkeypatch.setattr(launcher, "__file__", str(package / "launcher.py"))
    monkeypatch.setenv("PATHEXT", ".WRAPPER")
    simulate_windows_executable_lookup(monkeypatch)

    assert resolve_executable(
        {"PATH": str(searched), "PATHEXT": ".EXE"}
    ) == str(native.resolve())


@pytest.mark.parametrize("suffix", [".bat", ".CMD"])
def test_windows_resolution_rejects_batch_file_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    executable = make_fake_executable(tmp_path, "", f"tfs-ripast{suffix}")
    simulate_windows_executable_lookup(monkeypatch)

    with pytest.raises(ExecutableNotFoundError, match="batch"):
        resolve_executable({"TFS_RIPAST_EXECUTABLE": str(executable)})


def test_windows_resolution_rejects_adjacent_symlink_to_batch_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "package"
    binary_directory = package / "bin"
    binary_directory.mkdir(parents=True)
    batch = make_fake_executable(binary_directory, "", "tfs-ripast.CMD")
    adjacent = binary_directory / "tfs-ripast"
    try:
        adjacent.symlink_to(batch.name)
    except OSError as error:
        pytest.skip(f"symlink creation is unavailable: {error}")
    monkeypatch.setattr(launcher, "__file__", str(package / "launcher.py"))
    simulate_windows_executable_lookup(monkeypatch)

    with pytest.raises(ExecutableNotFoundError, match="batch"):
        resolve_executable({"PATH": "", "PATHEXT": ".EXE"})


def test_console_entrypoint_preserves_child_signal_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[int] = []
    monkeypatch.setattr(cli_main, "main", lambda: -signal.SIGTERM)
    monkeypatch.setattr(cli_main, "_exit_with_child_status", recorded.append)

    cli_main.entrypoint()

    assert recorded == [-signal.SIGTERM]


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
