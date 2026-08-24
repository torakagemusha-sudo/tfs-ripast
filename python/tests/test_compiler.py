from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

import pytest
from jinja2.exceptions import SecurityError, TemplateAssertionError, UndefinedError

from tfs_ripast.compiler import PlanCompilationError, compile_plan
from tfs_ripast.schema import RewritePlanValidationError, validate_rewrite_plan


def valid_plan(**changes: object) -> dict[str, object]:
    plan: dict[str, object] = {
        "version": 1,
        "name": "migration",
        "root": ".",
        "operations": [],
        "policy": {},
        "validations": [],
    }
    plan.update(changes)
    return plan


def test_packaged_schema_is_byte_identical_to_the_typescript_protocol() -> None:
    packaged = files("tfs_ripast").joinpath("_schemas/rewrite-plan.schema.json").read_bytes()
    canonical = (Path(__file__).parents[2] / "schemas" / "rewrite-plan.schema.json").read_bytes()

    assert packaged == canonical


def test_compiles_a_loop_expanded_json_plan_with_allowlisted_filters() -> None:
    template = """{
      "version": 1,
      "name": {{ name | upper | tojson }},
      "root": ".",
      "operations": [
      {% for item in operations %}
        {"id": {{ item["id"] | lower | tojson }}, "paths": {{ item["paths"] | sort | tojson }},
         "search": {{ item["search"] | tojson }}, "replace": {{ item["replace"] | replace("OLD", "new") | tojson }},
         "lexical": {"type": "literal"}}{% if not loop.last %},{% endif %}
      {% endfor %}],
      "policy": {}, "validations": []
    }"""

    result = compile_plan(template, {
        "name": "rename",
        "operations": [{"id": "FIRST", "paths": ["z.ts", "a.ts"], "search": "old", "replace": "OLD"}],
    })

    assert result == valid_plan(
        name="RENAME",
        operations=[{
            "id": "first",
            "paths": ["a.ts", "z.ts"],
            "search": "old",
            "replace": "new",
            "lexical": {"type": "literal"},
        }],
    )


@pytest.mark.parametrize(
    ("template", "error_type"),
    [
        ('{{ missing_value }}', UndefinedError),
        ('{{ payload.__class__.__mro__ }}', (SecurityError, UndefinedError)),
        ('{{ __import__("os").getcwd() }}', (PlanCompilationError, SecurityError, UndefinedError)),
        ('{{ environ["HOME"] }}', UndefinedError),
    ],
)
def test_rejects_undefined_names_attribute_traversal_imports_and_environment(
    template: str,
    error_type: type[Exception] | tuple[type[Exception], ...],
) -> None:
    with pytest.raises(error_type):
        compile_plan(template, {"payload": {"safe": "value"}})


@pytest.mark.parametrize(
    "template",
    [
        '{{ values | map("upper") | list }}',
        '{{ "value" is string }}',
    ],
)
def test_default_filters_and_tests_are_not_exposed(template: str) -> None:
    with pytest.raises((PlanCompilationError, TemplateAssertionError)):
        compile_plan(template, {"values": ["a"]})


def test_rejects_callable_data_without_invoking_it() -> None:
    called = False

    def target_reader() -> str:
        nonlocal called
        called = True
        return "source contents"

    with pytest.raises((PlanCompilationError, SecurityError)):
        compile_plan('{{ reader() }}', {"reader": target_reader})

    assert called is False


def test_rejects_non_object_json_template_data_with_a_compilation_error() -> None:
    with pytest.raises(PlanCompilationError, match="JSON object"):
        compile_plan(json.dumps(valid_plan()), ["not", "an", "object"])


def test_rejects_invalid_json_after_rendering() -> None:
    with pytest.raises(PlanCompilationError, match="valid JSON"):
        compile_plan("not-json", {})


def test_rejects_structurally_invalid_rewrite_plan() -> None:
    with pytest.raises(RewritePlanValidationError, match="version"):
        compile_plan(json.dumps(valid_plan(version=2)), {})


def test_bounds_rendered_output_by_utf8_bytes() -> None:
    template = json.dumps(valid_plan(name="{{ name }}"))

    with pytest.raises(PlanCompilationError, match="rendered plan exceeds 32 bytes"):
        compile_plan(template, {"name": "é" * 30}, max_rendered_bytes=32)


def test_rejects_string_multiplication_before_amplified_value_is_built() -> None:
    with pytest.raises(PlanCompilationError, match="multiplication operator is not supported"):
        compile_plan("{{ 'x' * 12000000 }}", {}, max_rendered_bytes=32)


def test_bounds_template_and_json_data_before_jinja_evaluation() -> None:
    with pytest.raises(PlanCompilationError, match="template exceeds 32 bytes"):
        compile_plan(" " * 33, {}, max_template_bytes=32)

    with pytest.raises(PlanCompilationError, match="template data exceeds 32 bytes"):
        compile_plan(
            json.dumps(valid_plan()),
            {"unused": "x" * 100},
            max_data_bytes=32,
        )


def test_rejects_non_plain_json_containers_without_iterating_them() -> None:
    iterated = False

    class HostileList(list[object]):
        def __iter__(self):  # type: ignore[no-untyped-def]
            nonlocal iterated
            iterated = True
            return super().__iter__()

    with pytest.raises(SecurityError, match="plain JSON values"):
        compile_plan(json.dumps(valid_plan()), {"values": HostileList([1, 2, 3])})

    assert iterated is False


def test_rejects_excessively_nested_json_data_before_serialization() -> None:
    nested: object = None
    for _ in range(130):
        nested = [nested]

    with pytest.raises(PlanCompilationError, match="nesting exceeds 128"):
        compile_plan(json.dumps(valid_plan()), {"nested": nested})


@pytest.mark.parametrize(
    ("template", "data", "filter_name"),
    [
        ('{{ "x" | replace("x", replacement) }}', {"replacement": "y" * 100}, "replace"),
        ('{{ values | join(separator) }}', {"values": ["x"] * 40, "separator": "--"}, "join"),
    ],
)
def test_amplifying_filters_preflight_their_result(
    template: str, data: dict[str, object], filter_name: str
) -> None:
    with pytest.raises(PlanCompilationError, match=rf"{filter_name} would exceed 32 bytes"):
        compile_plan(template, data, max_rendered_bytes=32)


def test_outputless_nested_loops_consume_a_deterministic_iteration_budget() -> None:
    template = """{% for outer in values %}{% for inner in values %}{% if false %}unused{% endif %}{% endfor %}{% endfor %}
    {"version":1,"name":"bounded","root":".","operations":[],"policy":{},"validations":[]}"""

    with pytest.raises(PlanCompilationError, match="execution budget of 100"):
        compile_plan(template, {"values": list(range(20))}, max_iterations=100)


def test_sliced_json_collections_cannot_bypass_the_execution_budget() -> None:
    template = """{% for outer in values[:] %}{% for inner in values[:] %}{% if false %}unused{% endif %}{% endfor %}{% endfor %}
    {"version":1,"name":"bounded","root":".","operations":[],"policy":{},"validations":[]}"""

    with pytest.raises(PlanCompilationError, match="slicing is not supported"):
        compile_plan(template, {"values": list(range(20))}, max_iterations=100)


def test_loop_iterables_cannot_be_rebound_to_unmetered_template_values() -> None:
    template = """{% set copied = values | sort %}{% for outer in copied %}{% for inner in copied %}{% if false %}unused{% endif %}{% endfor %}{% endfor %}
    {"version":1,"name":"bounded","root":".","operations":[],"policy":{},"validations":[]}"""

    with pytest.raises(PlanCompilationError, match="assignments are not supported"):
        compile_plan(template, {"values": list(range(20))}, max_iterations=200)


def test_repeated_filters_consume_the_same_deterministic_execution_budget() -> None:
    template = '{{ value | upper | lower | upper | lower }}'

    with pytest.raises(PlanCompilationError, match="execution budget of 2"):
        compile_plan(template, {"value": "bounded"}, max_iterations=2)


def test_rejects_function_calls_and_filtered_loop_iterables_outside_the_supported_subset() -> None:
    with pytest.raises(PlanCompilationError, match="function calls are not supported"):
        compile_plan("{{ range(1000000000) }}", {})

    with pytest.raises(PlanCompilationError, match="loop iterables must directly reference JSON data"):
        compile_plan(
            "{% for value in values | sort %}{{ value }}{% endfor %}",
            {"values": [2, 1]},
        )


@pytest.mark.parametrize(
    "expression",
    [
        "needle in values",
        "left == right",
        "left != right",
        "left < right",
    ],
)
def test_rejects_unmetered_membership_and_deep_collection_comparisons(
    expression: str,
) -> None:
    template = """{% for item in values %}{% if EXPRESSION %}{% if false %}unused{% endif %}{% endif %}{% endfor %}
    {"version":1,"name":"bounded","root":".","operations":[],"policy":{},"validations":[]}""".replace(
        "EXPRESSION", expression
    )
    data = {
        "needle": ["not-present"],
        "values": [[str(index)] for index in range(100)],
        "left": [[str(index)] for index in range(100)],
        "right": [[str(index)] for index in range(100)],
    }

    with pytest.raises(PlanCompilationError, match="comparison and membership operators are not supported"):
        compile_plan(template, data, max_iterations=1000)


def test_rejects_slicing_instead_of_relying_on_container_specific_metering() -> None:
    with pytest.raises(PlanCompilationError, match="slicing is not supported"):
        compile_plan("{{ values[:] | tojson }}", {"values": list(range(100))})


def test_repeated_mapping_lookups_consume_the_execution_budget() -> None:
    key = "k" * 1024
    template = """{% for item in values %}{% if mapping[key] %}{% if false %}unused{% endif %}{% endif %}{% endfor %}
    {"version":1,"name":"bounded","root":".","operations":[],"policy":{},"validations":[]}"""

    with pytest.raises(PlanCompilationError, match="execution budget of 100"):
        compile_plan(
            template,
            {"values": list(range(20)), "mapping": {key: True}, "key": key},
            max_iterations=100,
        )


def test_lower_preserves_python_whole_string_final_sigma_semantics() -> None:
    template = '{"version":1,"name":{{ word | lower | tojson }},"root":".","operations":[],"policy":{},"validations":[]}'

    result = compile_plan(template, {"word": "ΟΣ"}, max_rendered_bytes=256)

    assert result["name"] == "ος"


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"operations": [
            {"id": "duplicate", "paths": ["a.ts"], "search": "a", "replace": "b", "lexical": {"type": "literal"}},
            {"id": "duplicate", "paths": ["b.ts"], "search": "a", "replace": "b", "lexical": {"type": "literal"}},
        ]}, "operation IDs must be unique"),
        ({"operations": [
            {"id": "range", "paths": ["a.ts"], "search": "a", "replace": "b", "lexical": {"type": "literal"},
             "expectedCount": {"min": 3, "max": 2}},
        ]}, "expectedCount min must not exceed max"),
    ],
)
def test_mirrors_named_typescript_semantic_contract(changes: dict[str, object], message: str) -> None:
    with pytest.raises(RewritePlanValidationError, match=message):
        validate_rewrite_plan(valid_plan(**changes))
