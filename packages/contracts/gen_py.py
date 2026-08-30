#!/usr/bin/env python3
"""Generate services/bake/app/contracts.py (Pydantic v2 models) from the JSON
Schema files in packages/contracts/schema/.

Usage:
    python packages/contracts/gen_py.py [output_path]

Deterministic and idempotent: running it twice with unchanged schemas
produces byte-identical output. No third-party dependencies (stdlib only),
so it runs under any Python 3.10+, not just the services/bake venv.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = Path(__file__).resolve().parent / "schema"
DEFAULT_OUT = REPO_ROOT / "services" / "bake" / "app" / "contracts.py"

SCHEMA_FILES = [
    "scene_request.json",
    "scene_graph.json",
    "print_params.json",
    "bake_result.json",
]

HEADER = '''"""GENERATED FROM packages/contracts/schema — DO NOT EDIT.

Regenerate with `make contracts` (runs packages/contracts/gen_py.py and
packages/contracts/gen_ts.py). Hand edits here will be overwritten.
"""
from __future__ import annotations

from typing import Annotated, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

'''

# Python keywords / non-identifier property names that need a field alias.
FIELD_ALIASES = {
    "3mf": "file_3mf",
    "class": "class_",
}

PY_SCALAR = {"string": "str", "number": "float", "integer": "int", "boolean": "bool"}

# JSON Schema numeric keyword -> pydantic Field keyword. Order is fixed so the
# generated output stays byte-identical across runs.
NUMERIC_CONSTRAINTS = (
    ("minimum", "ge"),
    ("maximum", "le"),
    ("exclusiveMinimum", "gt"),
    ("exclusiveMaximum", "lt"),
)


def numeric_constraints(prop: dict) -> list[str]:
    """Field(...) kwargs for the numeric bounds on a scalar schema fragment."""
    return [
        f"{kw}={json.dumps(prop[key])}"
        for key, kw in NUMERIC_CONSTRAINTS
        if key in prop
    ]


def length_constraints(prop: dict) -> list[str]:
    """Field(...) kwargs for the item-count bounds on an array schema fragment."""
    args = []
    if "minItems" in prop:
        args.append(f"min_length={prop['minItems']}")
    if "maxItems" in prop:
        args.append(f"max_length={prop['maxItems']}")
    return args


def annotate(base: str, args: list[str]) -> str:
    """Wrap a type expression in Annotated[..., Field(...)] when constrained."""
    if not args:
        return base
    return f"Annotated[{base}, Field({', '.join(args)})]"


def load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


class Emitter:
    """Emits one Pydantic module for one schema file's $defs + root schema."""

    def __init__(self, schema: dict):
        self.schema = schema
        self.defs: dict = schema.get("$defs", {})
        self.alias_names: dict[str, str] = {}  # def name -> python type expression (for non-object defs)
        self.class_blocks: list[str] = []  # emitted "class Foo(BaseModel): ..." blocks, in dependency order
        self.emitted_classes: set[str] = set()

    def ref_name(self, ref: str) -> str:
        assert ref.startswith("#/$defs/"), f"only local $defs refs are supported, got {ref}"
        return ref.split("/")[-1]

    def resolve_def(self, name: str) -> str:
        """Return the Python type expression for a $defs entry, emitting a
        class or a type alias the first time it is referenced."""
        if name in self.alias_names:
            return self.alias_names[name]
        if name in self.emitted_classes:
            return name
        def_schema = self.defs[name]
        if def_schema.get("type") == "object":
            # Placeholder so recursive self-reference (none in this contract
            # set, but keep it safe) does not infinite-loop.
            self.emitted_classes.add(name)
            self.emit_class(name, def_schema)
            return name
        # Structural alias (Point, Ring, ...): resolve its Python type and
        # emit `Name = <type>` at module level.
        py_type = self.py_type(def_schema)
        self.alias_names[name] = name
        self.class_blocks.append(f"{name} = {py_type}\n")
        return name

    def py_type(self, prop: dict) -> str:
        if "$ref" in prop:
            name = self.ref_name(prop["$ref"])
            return self.resolve_def(name)

        if "anyOf" in prop:
            branches = prop["anyOf"]
            null = any(b.get("type") == "null" for b in branches)
            rest = [b for b in branches if b.get("type") != "null"]
            assert len(rest) == 1, "only anyOf[X, null] is supported"
            inner = self.py_type(rest[0])
            return f"Optional[{inner}]" if null else inner

        t = prop.get("type")
        if isinstance(t, list):
            null = "null" in t
            rest = [x for x in t if x != "null"]
            assert len(rest) == 1
            inner = PY_SCALAR[rest[0]] if rest[0] in PY_SCALAR else "object"
            inner = annotate(inner, numeric_constraints(prop))
            return f"Optional[{inner}]" if null else inner

        if "enum" in prop:
            values = ", ".join(json.dumps(v) for v in prop["enum"])
            return f"Literal[{values}]"

        if t == "object":
            raise ValueError("inline (un-named) object schemas are not supported; add a $defs entry")

        if t == "array":
            items = prop["items"]
            min_items = prop.get("minItems")
            max_items = prop.get("maxItems")
            item_type = self.py_type(items)
            if min_items is not None and min_items == max_items and "$ref" not in items and items.get("type") in PY_SCALAR:
                # Fixed-length tuple already encodes both bounds in the type.
                return "Tuple[" + ", ".join([item_type] * min_items) + "]"
            return annotate(f"List[{item_type}]", length_constraints(prop))

        if t in PY_SCALAR:
            return annotate(PY_SCALAR[t], numeric_constraints(prop))

        raise ValueError(f"unhandled schema fragment: {prop}")

    def py_default(self, prop: dict) -> str | None:
        """Return a Python literal source string for a JSON Schema `default`,
        or None if the schema has no default."""
        if "default" not in prop:
            return None
        value = prop["default"]
        if value is None:
            return "None"
        if value == []:
            return "Field(default_factory=list)"
        if isinstance(value, bool):
            return "True" if value else "False"
        if isinstance(value, (int, float, str)):
            return json.dumps(value)
        raise ValueError(f"unhandled default value: {value!r}")

    def emit_class(self, name: str, obj_schema: dict) -> None:
        required = set(obj_schema.get("required", []))
        props: dict = obj_schema.get("properties", {})
        lines = [f"class {name}(BaseModel):"]
        lines.append(
            "    model_config = ConfigDict("
            'extra="forbid", populate_by_name=True, serialize_by_alias=True)'
        )
        if not props:
            lines.append("    pass")
        for prop_name, prop_schema in props.items():
            py_t = self.py_type(prop_schema)
            default_src = self.py_default(prop_schema)
            field_name = FIELD_ALIASES.get(prop_name, prop_name)
            needs_alias = field_name != prop_name

            if default_src is None and prop_name not in required:
                # Not required, no explicit default in schema: make it
                # optional so partial construction never breaks.
                py_t = f"Optional[{py_t}]" if not py_t.startswith("Optional[") else py_t
                default_src = "None"

            if needs_alias:
                field_args = []
                if default_src is not None:
                    if default_src.startswith("Field("):
                        # default_factory=list case combined with alias
                        field_args.append("default_factory=list")
                    else:
                        field_args.append(f"default={default_src}")
                field_args.append(f'alias="{prop_name}"')
                lines.append(f"    {field_name}: {py_t} = Field({', '.join(field_args)})")
            elif default_src is not None:
                lines.append(f"    {field_name}: {py_t} = {default_src}")
            else:
                lines.append(f"    {field_name}: {py_t}")
        self.class_blocks.append("\n".join(lines) + "\n")

    def emit_root(self) -> str:
        title = self.schema["title"]
        # Emit $defs referenced anywhere in properties first (resolve_def
        # appends to class_blocks as a side effect, in first-use order,
        # which is already dependency-correct for this contract set).
        self.emit_class(title, self.schema)
        return title


def generate() -> str:
    out = [HEADER]
    for fname in SCHEMA_FILES:
        schema = load_schema(fname)
        emitter = Emitter(schema)
        emitter.emit_root()
        out.append(f"\n# ---- from {fname} " + "-" * max(0, 40 - len(fname)) + "\n")
        out.append("\n\n".join(emitter.class_blocks))
        out.append("\n")
    return "".join(out).rstrip() + "\n"


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(generate(), encoding="utf-8", newline="\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
