"""Validation of concrete RewritePlan documents against the shared protocol."""

from __future__ import annotations

from functools import lru_cache
from importlib.resources import files
import json
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError


SEMANTIC_VALIDATION_CONTRACT = (
    "https://torafirma.dev/schemas/tfs-ripast/semantic-validation/v1"
)


class RewritePlanValidationError(ValueError):
    """Raised when a rendered document is not a valid version-one RewritePlan."""


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    schema_resource = files("tfs_ripast").joinpath("_schemas/rewrite-plan.schema.json")
    try:
        schema = json.loads(schema_resource.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RewritePlanValidationError(
            f"cannot load the packaged RewritePlan schema: {error}"
        ) from error
    if schema.get("x-tfs-ripast-semantic-validation") != SEMANTIC_VALIDATION_CONTRACT:
        raise RewritePlanValidationError(
            "RewritePlan schema declares an unknown semantic contract"
        )
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as error:
        raise RewritePlanValidationError(
            f"committed RewritePlan schema is invalid: {error.message}"
        ) from error
    return Draft202012Validator(schema)


def _require_unique(values: list[str], label: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise RewritePlanValidationError(f"{label} must be unique: {value}")
        seen.add(value)


def _validate_semantics(plan: dict[str, Any]) -> None:
    operations = plan["operations"]
    _require_unique([operation["id"] for operation in operations], "operation IDs")
    for operation in operations:
        expected = operation.get("expectedCount")
        if expected is None:
            continue
        if not expected:
            raise RewritePlanValidationError("expectedCount must not be empty")
        minimum = expected.get("min")
        maximum = expected.get("max")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise RewritePlanValidationError("expectedCount min must not exceed max")


def validate_rewrite_plan(value: object) -> dict[str, object]:
    """Validate JSON Schema structure and then the named semantic contract."""

    errors = sorted(
        _validator().iter_errors(value),
        key=lambda error: tuple(
            f"{type(part).__name__}:{part}" for part in error.absolute_path
        ),
    )
    if errors:
        error: ValidationError = errors[0]
        location = ".".join(str(part) for part in error.absolute_path) or "document"
        raise RewritePlanValidationError(f"{location}: {error.message}")
    if not isinstance(value, dict):
        raise RewritePlanValidationError("document must be a JSON object")
    _validate_semantics(value)
    return value
