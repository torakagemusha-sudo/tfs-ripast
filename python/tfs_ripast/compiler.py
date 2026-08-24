"""Sandboxed Jinja2-to-JSON RewritePlan compilation.

The supported template subset permits control flow over direct JSON data,
scalar-literal/name/item expressions, boolean truthiness, conditional
expressions, and the explicitly registered filters. Comparisons, membership,
slicing, function calls, recursive loops, filtered/computed loop iterables,
concatenation, and arithmetic operators are rejected before evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Any

from jinja2 import StrictUndefined, nodes
from jinja2.exceptions import SecurityError
from jinja2.runtime import LoopContext
from jinja2.sandbox import SandboxedEnvironment

from .schema import validate_rewrite_plan


DEFAULT_MAX_RENDERED_BYTES = 1024 * 1024
DEFAULT_MAX_TEMPLATE_BYTES = 256 * 1024
DEFAULT_MAX_DATA_BYTES = 1024 * 1024
DEFAULT_MAX_ITERATIONS = 100_000
MAX_RENDERED_BYTES = 8 * 1024 * 1024
MAX_TEMPLATE_BYTES = 1024 * 1024
MAX_DATA_BYTES = 8 * 1024 * 1024
MAX_ITERATIONS = 1_000_000
MAX_TEMPLATE_NODES = 4096
MAX_DATA_NODES = 100_000
MAX_DATA_DEPTH = 128
MAX_INTEGER_BITS = 4096
MAX_CASE_MAPPING_BYTES_PER_CODEPOINT = 12


class PlanCompilationError(ValueError):
    """Raised when safe rendering cannot produce a concrete JSON plan."""


@dataclass
class _EvaluationBudget:
    limit: int
    consumed: int = 0

    def consume(self, units: int = 1) -> None:
        self.consumed += units
        if self.consumed > self.limit:
            raise PlanCompilationError(
                f"template execution budget of {self.limit} was exceeded"
            )


class _BudgetString(str):
    def __new__(cls, value: str, budget: _EvaluationBudget) -> "_BudgetString":
        instance = super().__new__(cls, value)
        instance._budget = budget
        instance._byte_size = len(value.encode("utf-8"))
        return instance

    def __iter__(self):  # type: ignore[no-untyped-def]
        for value in super().__iter__():
            self._budget.consume()
            yield value

    def __getitem__(self, key):  # type: ignore[no-untyped-def]
        self._budget.consume(_work_units(key))
        value = super().__getitem__(key)
        return _BudgetString(value, self._budget)


class _BudgetList(list[Any]):
    def __init__(self, values: list[Any], budget: _EvaluationBudget) -> None:
        super().__init__(values)
        self._budget = budget
        self._byte_size = 2 + sum(_value_cost(value) for value in values)

    def __iter__(self):  # type: ignore[no-untyped-def]
        for value in super().__iter__():
            self._budget.consume()
            yield value

    def __getitem__(self, key):  # type: ignore[no-untyped-def]
        self._budget.consume(_work_units(key))
        value = super().__getitem__(key)
        if isinstance(key, slice):
            return _BudgetList(value, self._budget)
        return value


class _BudgetDict(dict[str, Any]):
    def __init__(self, values: dict[str, Any], budget: _EvaluationBudget) -> None:
        super().__init__(values)
        self._budget = budget
        self._byte_size = 2 + sum(
            len(key.encode("utf-8")) + _value_cost(value)
            for key, value in values.items()
        )

    def __iter__(self):  # type: ignore[no-untyped-def]
        for key in super().__iter__():
            self._budget.consume()
            yield key

    def __getitem__(self, key):  # type: ignore[no-untyped-def]
        self._budget.consume(_work_units(key))
        return super().__getitem__(key)

    def items(self):  # type: ignore[no-untyped-def]
        for item in super().items():
            self._budget.consume()
            yield item

    def keys(self):  # type: ignore[no-untyped-def]
        for key in super().keys():
            self._budget.consume()
            yield key

    def values(self):  # type: ignore[no-untyped-def]
        for value in super().values():
            self._budget.consume()
            yield value


class _PlanEnvironment(SandboxedEnvironment):
    _LOOP_ATTRIBUTES = frozenset({
        "changed", "cycle", "depth", "depth0", "first", "index", "index0",
        "last", "length", "nextitem", "previtem", "revindex", "revindex0",
    })

    def is_safe_attribute(self, obj: object, attr: str, value: object) -> bool:
        return isinstance(obj, LoopContext) and attr in self._LOOP_ATTRIBUTES

    def is_safe_callable(self, obj: object) -> bool:
        return False


def _utf8_size(value: object) -> int:
    return len(str(value).encode("utf-8"))


def _value_cost(value: object) -> int:
    stored = getattr(value, "_byte_size", None)
    if isinstance(stored, int):
        return stored
    return _utf8_size(value)


def _work_units(*values: object) -> int:
    return max(1, (sum(_value_cost(value) for value in values) + 63) // 64)


def _environment(
    max_rendered_bytes: int, budget: _EvaluationBudget
) -> _PlanEnvironment:
    environment = _PlanEnvironment(undefined=StrictUndefined, autoescape=False)

    def bounded_case(value: object, *, upper: bool) -> str:
        text = str(value)
        conservative_bytes = len(text) * MAX_CASE_MAPPING_BYTES_PER_CODEPOINT
        name = "upper" if upper else "lower"
        if conservative_bytes > max_rendered_bytes:
            raise PlanCompilationError(
                f"{name} could exceed {max_rendered_bytes} bytes"
            )
        budget.consume(
            _work_units(value) + max(1, conservative_bytes // 64)
        )
        transformed = text.upper() if upper else text.lower()
        if _utf8_size(transformed) > max_rendered_bytes:
            raise PlanCompilationError(
                f"{name} exceeded its conservative {max_rendered_bytes}-byte bound"
            )
        return _BudgetString(transformed, budget)

    def bounded_replace(value: object, old: object, new: object, count: int | None = None) -> str:
        text = str(value)
        needle = str(old)
        replacement = str(new)
        replacement_count = -1 if count is None else count
        if not isinstance(replacement_count, int) or isinstance(replacement_count, bool):
            raise PlanCompilationError("replace count must be an integer")
        if replacement_count == 0:
            occurrences = 0
        elif needle == "":
            available = len(text) + 1
            occurrences = (
                available
                if replacement_count < 0
                else min(available, replacement_count)
            )
        else:
            available = text.count(needle)
            occurrences = (
                available
                if replacement_count < 0
                else min(available, replacement_count)
            )
        predicted = _utf8_size(text) + occurrences * (
            _utf8_size(replacement) - _utf8_size(needle)
        )
        budget.consume(_work_units(value, old, new) + max(1, predicted // 64))
        if predicted > max_rendered_bytes:
            raise PlanCompilationError(
                f"replace would exceed {max_rendered_bytes} bytes"
            )
        return _BudgetString(
            text.replace(needle, replacement, replacement_count), budget
        )

    def bounded_join(value: object, delimiter: object = "") -> str:
        if not isinstance(value, (list, tuple, dict, str)):
            raise PlanCompilationError("join accepts only a bounded JSON collection")
        separator = str(delimiter)
        items = [str(item) for item in value]
        predicted = sum(_utf8_size(item) for item in items)
        if items:
            predicted += (len(items) - 1) * _utf8_size(separator)
        if predicted > max_rendered_bytes:
            raise PlanCompilationError(f"join would exceed {max_rendered_bytes} bytes")
        budget.consume(_work_units(value, delimiter) + max(1, predicted // 64))
        return _BudgetString(separator.join(items), budget)

    def bounded_tojson(value: object) -> str:
        budget.consume(_work_units(value))
        encoder = json.JSONEncoder(
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
        )
        chunks: list[str] = []
        rendered_bytes = 0
        for chunk in encoder.iterencode(value):
            rendered_bytes += len(chunk.encode("utf-8"))
            if rendered_bytes > max_rendered_bytes:
                raise PlanCompilationError(
                    f"tojson would exceed {max_rendered_bytes} bytes"
                )
            chunks.append(chunk)
        return _BudgetString("".join(chunks), budget)

    def bounded_length(value: object) -> int:
        budget.consume()
        if not isinstance(value, (str, list, dict)):
            raise PlanCompilationError("length accepts only bounded JSON values")
        return len(value)

    def bounded_sort(
        value: object,
        reverse: bool = False,
        case_sensitive: bool = False,
        attribute: object | None = None,
    ) -> list[object]:
        if attribute is not None:
            raise PlanCompilationError("sort attributes are not supported")
        if not isinstance(value, (list, tuple)):
            raise PlanCompilationError("sort accepts only a bounded JSON array")
        items = list(value)
        budget.consume(max(1, len(items) * max(1, len(items).bit_length())))
        key = (
            None
            if case_sensitive
            else lambda item: item.lower() if isinstance(item, str) else item
        )
        return _BudgetList(
            sorted(items, key=key, reverse=bool(reverse)), budget
        )

    def bounded_dictsort(
        value: object,
        case_sensitive: bool = False,
        by: str = "key",
        reverse: bool = False,
    ) -> list[tuple[object, object]]:
        if not isinstance(value, dict) or by not in ("key", "value"):
            raise PlanCompilationError(
                "dictsort requires a JSON object and key/value ordering"
            )
        items = list(value.items())
        budget.consume(max(1, len(items) * max(1, len(items).bit_length())))
        index = 0 if by == "key" else 1
        key = (
            (lambda item: item[index])
            if case_sensitive
            else (
                lambda item: item[index].lower()
                if isinstance(item[index], str)
                else item[index]
            )
        )
        return _BudgetList(
            sorted(items, key=key, reverse=bool(reverse)), budget
        )

    environment.globals.clear()
    environment.tests.clear()
    environment.filters.clear()
    environment.filters["tojson"] = bounded_tojson
    environment.filters["lower"] = lambda value: bounded_case(value, upper=False)
    environment.filters["upper"] = lambda value: bounded_case(value, upper=True)
    environment.filters["length"] = bounded_length
    environment.filters["sort"] = bounded_sort
    environment.filters["dictsort"] = bounded_dictsort
    environment.filters["replace"] = bounded_replace
    environment.filters["join"] = bounded_join
    return environment


def _bounded_setting(name: str, value: int, hard_limit: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    if value > hard_limit:
        raise ValueError(f"{name} cannot exceed the hard limit of {hard_limit}")
    return value


def _preflight_json_data(data: object, maximum: int) -> None:
    if type(data) is not dict:
        if type(data) is list:
            raise PlanCompilationError("template data must be a JSON object")
        if isinstance(data, (dict, list)):
            raise SecurityError("template data must use only plain JSON values")
        raise PlanCompilationError("template data must be a JSON object")

    stack: list[tuple[object, int]] = [(data, 0)]
    nodes_seen = 0
    bytes_seen = 0
    while stack:
        value, depth = stack.pop()
        nodes_seen += 1
        if nodes_seen > MAX_DATA_NODES:
            raise PlanCompilationError(
                f"template data exceeds the node budget of {MAX_DATA_NODES}"
            )
        if depth > MAX_DATA_DEPTH:
            raise PlanCompilationError(
                f"template data nesting exceeds {MAX_DATA_DEPTH}"
            )

        value_type = type(value)
        if value_type is str:
            if len(value) > maximum:
                raise PlanCompilationError(f"template data exceeds {maximum} bytes")
            bytes_seen += len(value.encode("utf-8"))
        elif value is None or value_type is bool:
            bytes_seen += 5
        elif value_type is int:
            if value.bit_length() > MAX_INTEGER_BITS:
                raise PlanCompilationError(
                    f"template integer exceeds {MAX_INTEGER_BITS} bits"
                )
            bytes_seen += len(str(value))
        elif value_type is float:
            if not math.isfinite(value):
                raise SecurityError("template data must contain only finite JSON values")
            bytes_seen += 24
        elif value_type is list:
            bytes_seen += len(value) + 2
            stack.extend((item, depth + 1) for item in value)
        elif value_type is dict:
            bytes_seen += len(value) + 2
            for key, item in value.items():
                if type(key) is not str:
                    raise SecurityError("template data must use only plain JSON values")
                if len(key) > maximum:
                    raise PlanCompilationError(f"template data exceeds {maximum} bytes")
                bytes_seen += len(key.encode("utf-8"))
                stack.append((item, depth + 1))
        else:
            raise SecurityError("template data must use only plain JSON values")

        if bytes_seen > maximum:
            raise PlanCompilationError(f"template data exceeds {maximum} bytes")


def _bounded_json_data(data: object, maximum: int) -> Any:
    _preflight_json_data(data, maximum)
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False)
    chunks: list[str] = []
    encoded_bytes = 0
    try:
        for chunk in encoder.iterencode(data):
            encoded_bytes += len(chunk.encode("utf-8"))
            if encoded_bytes > maximum:
                raise PlanCompilationError(f"template data exceeds {maximum} bytes")
            chunks.append(chunk)
        normalized = json.loads("".join(chunks))
    except PlanCompilationError:
        raise
    except (TypeError, ValueError) as error:
        raise SecurityError("template data must contain only finite JSON values") from error
    if not isinstance(normalized, dict):
        raise PlanCompilationError("template data must be a JSON object")
    return normalized


def _budget_value(value: Any, budget: _EvaluationBudget) -> Any:
    if isinstance(value, str):
        return _BudgetString(value, budget)
    if isinstance(value, list):
        return _BudgetList([_budget_value(item, budget) for item in value], budget)
    if isinstance(value, dict):
        return _BudgetDict(
            {key: _budget_value(item, budget) for key, item in value.items()},
            budget,
        )
    return value


def _loop_root_name(value: nodes.Expr) -> str | None:
    while isinstance(value, nodes.Getitem):
        value = value.node
    if isinstance(value, nodes.Name) and value.ctx == "load":
        return value.name
    return None


def _validate_template_subset(
    parsed: nodes.Template, data_names: set[str]
) -> None:
    parsed_nodes = list(parsed.find_all(nodes.Node))
    if len(parsed_nodes) > MAX_TEMPLATE_NODES:
        raise PlanCompilationError(
            f"template exceeds the AST budget of {MAX_TEMPLATE_NODES} nodes"
        )
    stored_names = {
        node.name
        for node in parsed_nodes
        if isinstance(node, nodes.Name) and node.ctx == "store"
    }
    arithmetic = (
        nodes.Add,
        nodes.Sub,
        nodes.Mul,
        nodes.Div,
        nodes.FloorDiv,
        nodes.Pow,
        nodes.Mod,
    )
    for node in parsed_nodes:
        if isinstance(node, nodes.Compare):
            raise PlanCompilationError(
                "template comparison and membership operators are not supported"
            )
        if isinstance(node, nodes.Slice):
            raise PlanCompilationError("template slicing is not supported")
        if isinstance(node, (nodes.Assign, nodes.AssignBlock)):
            raise PlanCompilationError("template assignments are not supported")
        if isinstance(node, nodes.Mul):
            raise PlanCompilationError(
                "template multiplication operator is not supported"
            )
        if isinstance(node, arithmetic):
            raise PlanCompilationError("template arithmetic operators are not supported")
        if isinstance(node, nodes.Concat):
            raise PlanCompilationError("template concatenation is not supported")
        if isinstance(node, nodes.Call):
            raise PlanCompilationError("template function calls are not supported")
        if isinstance(node, nodes.For):
            if node.recursive:
                raise PlanCompilationError("recursive template loops are not supported")
            root_name = _loop_root_name(node.iter)
            if (
                root_name is None
                or root_name not in data_names
                or root_name in stored_names
            ):
                raise PlanCompilationError(
                    "loop iterables must directly reference JSON data"
                )
    supported_nodes = (
        nodes.Output,
        nodes.TemplateData,
        nodes.Const,
        nodes.Name,
        nodes.Getitem,
        nodes.Getattr,
        nodes.Filter,
        nodes.Keyword,
        nodes.For,
        nodes.If,
        nodes.Not,
        nodes.And,
        nodes.Or,
        nodes.CondExpr,
    )
    for node in parsed_nodes:
        if not isinstance(node, supported_nodes):
            raise PlanCompilationError(
                f"unsupported template syntax: {type(node).__name__}"
            )


def compile_plan(
    template: str,
    data: object,
    *,
    max_rendered_bytes: int = DEFAULT_MAX_RENDERED_BYTES,
    max_template_bytes: int = DEFAULT_MAX_TEMPLATE_BYTES,
    max_data_bytes: int = DEFAULT_MAX_DATA_BYTES,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
) -> dict[str, object]:
    """Render one bounded in-memory template and validate a RewritePlan."""

    if not isinstance(template, str):
        raise TypeError("template must be a string")
    max_rendered_bytes = _bounded_setting(
        "max_rendered_bytes", max_rendered_bytes, MAX_RENDERED_BYTES
    )
    max_template_bytes = _bounded_setting(
        "max_template_bytes", max_template_bytes, MAX_TEMPLATE_BYTES
    )
    max_data_bytes = _bounded_setting("max_data_bytes", max_data_bytes, MAX_DATA_BYTES)
    max_iterations = _bounded_setting(
        "max_iterations", max_iterations, MAX_ITERATIONS
    )
    if len(template.encode("utf-8")) > max_template_bytes:
        raise PlanCompilationError(f"template exceeds {max_template_bytes} bytes")

    normalized = _bounded_json_data(data, max_data_bytes)
    budget = _EvaluationBudget(max_iterations)
    environment = _environment(max_rendered_bytes, budget)
    parsed = environment.parse(template)
    _validate_template_subset(parsed, set(normalized))
    compiled = environment.from_string(template)
    context = _budget_value(normalized, budget)

    chunks: list[str] = []
    rendered_bytes = 0
    for chunk in compiled.generate(**context):
        rendered_bytes += len(chunk.encode("utf-8"))
        if rendered_bytes > max_rendered_bytes:
            raise PlanCompilationError(
                f"rendered plan exceeds {max_rendered_bytes} bytes"
            )
        chunks.append(chunk)
    rendered = "".join(chunks)
    try:
        value = json.loads(
            rendered,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON constant {constant}")
            ),
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise PlanCompilationError(f"rendered plan is not valid JSON: {error}") from error
    return validate_rewrite_plan(value)
