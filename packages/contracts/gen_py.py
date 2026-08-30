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


def string_constraints(prop: dict) -> list[str]:
    """Field(...) kwargs for the length/pattern bounds on a string fragment."""
    args = []
    if "minLength" in prop:
        args.append(f"min_length={prop['minLength']}")
    if "maxLength" in prop:
        args.append(f"max_length={prop['maxLength']}")
    if "pattern" in prop:
        # json.dumps escapes exactly what a Python double-quoted literal needs.
        args.append(f"pattern={json.dumps(prop['pattern'])}")
    return args


def scalar_constraints(prop: dict) -> list[str]:
    """Every Field(...) bound that applies to a scalar fragment."""
    return numeric_constraints(prop) + string_constraints(prop)


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
            inner = annotate(inner, scalar_constraints(prop))
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
            return annotate(PY_SCALAR[t], scalar_constraints(prop))

        raise ValueError(f"unhandled schema fragment: {prop}")

    def py_literal(self, value) -> str:
        """A Python source literal for a scalar JSON value."""
        if value is None:
            return "None"
        if isinstance(value, bool):
            return "True" if value else "False"
        if isinstance(value, (int, float, str)):
            return json.dumps(value)
        raise ValueError(f"unhandled literal value: {value!r}")

    def py_default(self, prop: dict, py_type: str) -> tuple[str, str] | None:
        """Return ``(kind, source)`` for a JSON Schema ``default``, or None when
        the schema has no default.

        ``kind`` is ``"value"`` for an immutable literal that can sit straight
        after the ``=``, or ``"factory"`` for a callable expression that must go
        through ``Field(default_factory=...)`` because the value is mutable (a
        list, or a nested model instance).  Both shapes are alias-safe, so an
        aliased field with a mutable default cannot silently lose it.
        """
        if "default" not in prop:
            return None
        value = prop["default"]
        if isinstance(value, list):
            if value:
                raise ValueError(f"only an empty list default is supported, got {value!r}")
            return ("factory", "list")
        if isinstance(value, dict):
            # Nested object default: construct the generated model, keyword by
            # keyword, in the referenced $defs' own property order so the output
            # is stable no matter how the JSON was keyed.
            target = self.defs.get(py_type, {})
            order = list(target.get("properties", {}))
            keys = [k for k in order if k in value] + [k for k in value if k not in order]
            missing = [k for k in target.get("required", []) if k not in value]
            if missing:
                # The nested model is required-complete (see emit_class), so an
                # object default that omits a required key would generate a
                # default_factory that raises on first construction.  Fail here,
                # at generation time, where the schema author can see it.
                raise ValueError(
                    f"default for {py_type} omits required key(s) {missing}; "
                    "an object default must name every required property"
                )
            kwargs = ", ".join(f"{k}={self.py_literal(value[k])}" for k in keys)
            return ("factory", f"lambda: {py_type}({kwargs})")
        return ("value", self.py_literal(value))

    def emit_class(self, name: str, obj_schema: dict, *, root: bool = False) -> None:
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
            default = self.py_default(prop_schema, py_t)
            field_name = FIELD_ALIASES.get(prop_name, prop_name)
            needs_alias = field_name != prop_name

            if prop_name in required and not root:
                # jsonschema treats a property listed in `required` as required
                # whatever `default` it also carries, and so must the model.
                # Without this a partial PartColors - `{"base": "#fff"}` - would
                # be silently back-filled with six defaults here while the schema
                # and the generated TS type both reject it, and POST /bake would
                # answer a half palette with a wrong-coloured print instead of a
                # 422.  The nested object's own defaults still reach the caller
                # through the OUTER optional property's default_factory, which
                # py_default emits with every key spelled out.
                default = None

            if default is None and prop_name not in required:
                # Not required, no explicit default in schema: make it
                # optional so partial construction never breaks.
                py_t = f"Optional[{py_t}]" if not py_t.startswith("Optional[") else py_t
                default = ("value", "None")

            if needs_alias:
                field_args = []
                if default is not None:
                    kind, source = default
                    field_args.append(
                        f"default_factory={source}" if kind == "factory" else f"default={source}"
                    )
                field_args.append(f'alias="{prop_name}"')
                lines.append(f"    {field_name}: {py_t} = Field({', '.join(field_args)})")
            elif default is not None:
                kind, source = default
                rhs = f"Field(default_factory={source})" if kind == "factory" else source
                lines.append(f"    {field_name}: {py_t} = {rhs}")
            else:
                lines.append(f"    {field_name}: {py_t}")
        self.class_blocks.append("\n".join(lines) + "\n")

    def emit_root(self) -> str:
        title = self.schema["title"]
        # Emit $defs referenced anywhere in properties first (resolve_def
        # appends to class_blocks as a side effect, in first-use order,
        # which is already dependency-correct for this contract set).
        #
        # root=True: a ROOT model is an API envelope, and this generator keeps
        # the schema default on its required properties on purpose, so
        # `PrintParams()` is the documented "no parameters supplied" object and
        # a v1 payload that omits a key still loads (DECISIONS [V2-P2-fix]).
        # Nested $defs objects are VALUES, where a missing key is a wrong value
        # rather than an under-specified request, so they get the strict
        # required-means-required treatment in emit_class.
        self.emit_class(title, self.schema, root=True)
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
