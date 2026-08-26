"""Module entry point for the Python compiler/launcher."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
from collections.abc import Sequence

from jinja2.exceptions import TemplateError

from .compiler import (
    DEFAULT_MAX_DATA_BYTES,
    DEFAULT_MAX_TEMPLATE_BYTES,
    PlanCompilationError,
    compile_plan,
)
from .launcher import ExecutableNotFoundError, assert_supported_platform, launch
from .schema import RewritePlanValidationError


def _read_bounded_utf8(path: Path, maximum: int, label: str) -> str:
    try:
        with path.open("rb") as stream:
            content = stream.read(maximum + 1)
    except OSError as error:
        raise PlanCompilationError(f"cannot read {label} input: {error}") from error
    if len(content) > maximum:
        raise PlanCompilationError(f"{label} input exceeds {maximum} bytes")
    try:
        return content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise PlanCompilationError(f"{label} input is not valid UTF-8: {error}") from error


def _compiled_invocation(argv: list[str]) -> tuple[list[str], str | None]:
    if not argv or argv[0] != "plan" or "--data" not in argv:
        return argv, None
    if len(argv) < 4:
        raise PlanCompilationError("plan templates require TEMPLATE --data DATA")
    data_indices = [index for index, argument in enumerate(argv) if argument == "--data"]
    if len(data_indices) != 1:
        raise PlanCompilationError("plan templates require exactly one --data option")
    data_index = data_indices[0]
    if data_index + 1 >= len(argv):
        raise PlanCompilationError("--data requires a JSON data path")
    template_path = Path(argv[1])
    if argv[1].startswith("-"):
        raise PlanCompilationError("plan templates require a template path after plan")
    data_path = Path(argv[data_index + 1])
    try:
        template = _read_bounded_utf8(
            template_path, DEFAULT_MAX_TEMPLATE_BYTES, "template"
        )
        data = json.loads(
            _read_bounded_utf8(data_path, DEFAULT_MAX_DATA_BYTES, "template data")
        )
    except json.JSONDecodeError as error:
        raise PlanCompilationError(f"cannot read plan template inputs: {error}") from error
    concrete = compile_plan(template, data)
    forwarded = ["plan", "-", *argv[2:data_index], *argv[data_index + 2:]]
    return forwarded, json.dumps(concrete, ensure_ascii=False, separators=(",", ":"))


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        assert_supported_platform()
        forwarded, stdin_data = _compiled_invocation(arguments)
        return launch(forwarded, stdin_data=stdin_data)
    except ExecutableNotFoundError as error:
        print(f"tfs-ripast: {error}", file=sys.stderr)
        return 2
    except (PlanCompilationError, RewritePlanValidationError, TemplateError) as error:
        print(f"tfs-ripast: {error}", file=sys.stderr)
        return 1


def _exit_with_child_status(status: int) -> None:
    if status >= 0:
        raise SystemExit(status)
    signum = -status
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
    raise SystemExit(128 + signum)


def entrypoint() -> None:
    """Exit the console script with the TypeScript child's exact status."""

    _exit_with_child_status(main())


if __name__ == "__main__":
    entrypoint()
