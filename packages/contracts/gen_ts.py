#!/usr/bin/env python3
"""Generate apps/web/lib/contracts.ts (TS interfaces + types) from the JSON
Schema files in packages/contracts/schema/.

Usage:
    python packages/contracts/gen_ts.py [output_path]

Deterministic and idempotent: running it twice with unchanged schemas
produces byte-identical output. No third-party dependencies (stdlib only).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = Path(__file__).resolve().parent / "schema"
DEFAULT_OUT = REPO_ROOT / "apps" / "web" / "lib" / "contracts.ts"

SCHEMA_FILES = [
    "scene_request.json",
    "scene_graph.json",
    "print_params.json",
    "bake_result.json",
]

HEADER = """// GENERATED FROM packages/contracts/schema — DO NOT EDIT.
//
// Regenerate with `make contracts` (runs packages/contracts/gen_py.py and
// packages/contracts/gen_ts.py). Hand edits here will be overwritten.

"""

TS_SCALAR = {"string": "string", "number": "number", "integer": "number", "boolean": "boolean"}

# TS interface property keys that are not valid bare identifiers and must be
# quoted (e.g. `"3mf": string;`).
NEEDS_QUOTING = {"3mf"}


def load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def prop_key(name: str) -> str:
    return f'"{name}"' if name in NEEDS_QUOTING else name


class Emitter:
    def __init__(self, schema: dict):
        self.schema = schema
        self.defs: dict = schema.get("$defs", {})
        self.alias_names: dict[str, str] = {}
        self.emitted: set[str] = set()
        self.blocks: list[str] = []

    def ref_name(self, ref: str) -> str:
        assert ref.startswith("#/$defs/"), f"only local $defs refs are supported, got {ref}"
        return ref.split("/")[-1]

    def resolve_def(self, name: str) -> str:
        if name in self.alias_names:
            return self.alias_names[name]
        if name in self.emitted:
            return name
        def_schema = self.defs[name]
        if def_schema.get("type") == "object":
            self.emitted.add(name)
            self.emit_interface(name, def_schema)
            return name
        ts_type = self.ts_type(def_schema)
        self.alias_names[name] = name
        self.blocks.append(f"export type {name} = {ts_type};\n")
        return name

    def ts_type(self, prop: dict) -> str:
        if "$ref" in prop:
            return self.resolve_def(self.ref_name(prop["$ref"]))

        if "anyOf" in prop:
            branches = prop["anyOf"]
            null = any(b.get("type") == "null" for b in branches)
            rest = [b for b in branches if b.get("type") != "null"]
            assert len(rest) == 1, "only anyOf[X, null] is supported"
            inner = self.ts_type(rest[0])
            return f"{inner} | null" if null else inner

        t = prop.get("type")
        if isinstance(t, list):
            null = "null" in t
            rest = [x for x in t if x != "null"]
            assert len(rest) == 1
            inner = TS_SCALAR.get(rest[0], "unknown")
            return f"{inner} | null" if null else inner

        if "enum" in prop:
            return " | ".join(json.dumps(v) for v in prop["enum"])

        if t == "object":
            raise ValueError("inline (un-named) object schemas are not supported; add a $defs entry")

        if t == "array":
            items = prop["items"]
            min_items = prop.get("minItems")
            max_items = prop.get("maxItems")
            item_type = self.ts_type(items)
            if min_items is not None and min_items == max_items and "$ref" not in items and items.get("type") in TS_SCALAR:
                return "[" + ", ".join([item_type] * min_items) + "]"
            return f"{item_type}[]"

        if t in TS_SCALAR:
            return TS_SCALAR[t]

        raise ValueError(f"unhandled schema fragment: {prop}")

    def emit_interface(self, name: str, obj_schema: dict) -> None:
        required = set(obj_schema.get("required", []))
        props: dict = obj_schema.get("properties", {})
        lines = [f"export interface {name} {{"]
        for prop_name, prop_schema in props.items():
            ts_t = self.ts_type(prop_schema)
            optional = "?" if prop_name not in required else ""
            lines.append(f"  {prop_key(prop_name)}{optional}: {ts_t};")
        lines.append("}")
        self.blocks.append("\n".join(lines) + "\n")

    def emit_root(self) -> str:
        title = self.schema["title"]
        self.emit_interface(title, self.schema)
        return title


def numeric_range_entries(print_params_schema: dict) -> list[tuple[str, dict]]:
    out = []
    for name, prop in print_params_schema["properties"].items():
        if "minimum" in prop and "maximum" in prop:
            out.append((name, prop))
    return out


def ts_literal(value) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return json.dumps(value)


def generate() -> str:
    out = [HEADER]
    print_params_schema = None

    for fname in SCHEMA_FILES:
        schema = load_schema(fname)
        if fname == "print_params.json":
            print_params_schema = schema
        emitter = Emitter(schema)
        emitter.emit_root()
        out.append(f"// ---- from {fname} " + "-" * max(0, 40 - len(fname)) + "\n\n")
        out.append("\n".join(emitter.blocks))
        out.append("\n")

    assert print_params_schema is not None

    # DEFAULT_PRINT_PARAMS: every PrintParams field has a schema default.
    out.append("// ---- derived constants " + "-" * 20 + "\n\n")
    default_lines = ["export const DEFAULT_PRINT_PARAMS: PrintParams = {"]
    for name, prop in print_params_schema["properties"].items():
        default_lines.append(f"  {name}: {ts_literal(prop['default'])},")
    default_lines.append("};\n")
    out.append("\n".join(default_lines))
    out.append("\n")

    # PARAM_RANGES: every numeric PrintParams field with a min/max.
    range_lines = ["export const PARAM_RANGES = {"]
    for name, prop in numeric_range_entries(print_params_schema):
        range_lines.append(
            f"  {name}: {{ min: {ts_literal(prop['minimum'])}, "
            f"max: {ts_literal(prop['maximum'])}, "
            f"default: {ts_literal(prop['default'])} }},"
        )
    range_lines.append("} as const;\n")
    out.append("\n".join(range_lines))
    out.append("\n")

    return "".join(out).rstrip() + "\n"


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(generate(), encoding="utf-8", newline="\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
