"""Exact argument-vector and signal forwarding to the TypeScript CLI."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import subprocess
from collections.abc import Mapping, Sequence


EXECUTABLE_OVERRIDE = "TFS_RIPAST_EXECUTABLE"
_WINDOWS = os.name == "nt"
_WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE"
_WINDOWS_NATIVE_SUFFIXES = frozenset({".com", ".exe"})
_WINDOWS_BATCH_SUFFIXES = frozenset({".bat", ".cmd"})


class ExecutableNotFoundError(FileNotFoundError):
    """Raised when no trusted TypeScript CLI executable can be resolved."""


def _checked_executable(candidate: str, source: str) -> str:
    path = Path(candidate).expanduser()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ExecutableNotFoundError(f"{source} is not an executable file: {candidate}")
    resolved = path.resolve(strict=True)
    if _WINDOWS and resolved.suffix.casefold() in _WINDOWS_BATCH_SUFFIXES:
        raise ExecutableNotFoundError(
            f"{source} is a Windows batch file and cannot be launched safely: "
            f"{candidate}"
        )
    return str(resolved)


def _windows_which(name: str, environment: Mapping[str, str]) -> str | None:
    path_value = environment.get("PATH", "")
    if not path_value:
        return None

    suffixes = [
        suffix
        for suffix in environment.get("PATHEXT", _WINDOWS_DEFAULT_PATHEXT).split(";")
        if suffix.casefold() in _WINDOWS_NATIVE_SUFFIXES
    ]
    for directory in path_value.split(";"):
        for suffix in suffixes:
            candidate = Path(directory or os.curdir) / f"{name}{suffix}"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def resolve_executable(environment: Mapping[str, str] | None = None) -> str:
    """Resolve override, adjacent packaged binary, then PATH, in that order."""

    env = os.environ if environment is None else environment
    override = env.get(EXECUTABLE_OVERRIDE)
    if override is not None:
        return _checked_executable(override, f"{EXECUTABLE_OVERRIDE} override")

    adjacent = Path(__file__).resolve().parent / "bin" / "tfs-ripast"
    if adjacent.is_file() and os.access(adjacent, os.X_OK):
        return _checked_executable(str(adjacent), "adjacent packaged executable")

    discovered = (
        _windows_which("tfs-ripast", env)
        if _WINDOWS
        else shutil.which("tfs-ripast", path=env.get("PATH", ""))
    )
    if discovered is None:
        raise ExecutableNotFoundError(
            f"tfs-ripast was not found; set {EXECUTABLE_OVERRIDE} to the TypeScript executable"
        )
    return _checked_executable(discovered, "PATH entry")


def launch(
    argv: Sequence[str],
    *,
    stdin_data: str | None = None,
    environment: Mapping[str, str] | None = None,
) -> int:
    """Run the TypeScript CLI without a shell and preserve its process result."""

    arguments = list(argv)
    if not all(isinstance(argument, str) for argument in arguments):
        raise TypeError("all launcher arguments must be strings")
    env = os.environ.copy() if environment is None else dict(environment)
    forwarded = (signal.SIGINT, signal.SIGTERM)
    previous: dict[signal.Signals, signal.Handlers] = {}
    child: subprocess.Popen[bytes] | None = None
    pending: list[int] = []

    def forward(signum: int, _frame: object) -> None:
        if child is None:
            pending.append(signum)
            return
        if child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    try:
        for signum in forwarded:
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, forward)
        executable = resolve_executable(env)
        try:
            child = subprocess.Popen(
                [executable, *arguments],
                shell=False,
                stdin=subprocess.PIPE if stdin_data is not None else None,
                env=env,
                start_new_session=os.name == "posix",
                creationflags=(
                    subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
                ),
            )
        except OSError as error:
            raise ExecutableNotFoundError(
                f"TypeScript CLI could not start: {error}"
            ) from error
        for signum in pending:
            if child.poll() is None:
                try:
                    child.send_signal(signum)
                except ProcessLookupError:
                    pass
        if stdin_data is None:
            return child.wait()
        child.communicate(input=stdin_data.encode("utf-8"))
        return child.returncode
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
