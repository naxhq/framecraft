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

# Emitted verbatim above DEFAULT_PRINT_PARAMS.  The constant is a module-level
# singleton, so without this its nested objects (part_colors, engravings,
# north_arrow, scale_bar, underside_mark, hero_building_ids) are shared
# instances that a SHALLOW copy - `{ ...DEFAULT_PRINT_PARAMS }` - aliases rather
# than copies; editing one in place would edit the default itself and every
# later reset would "reset" to the corruption.  This is the guard the Python
# half already has as `Field(default_factory=...)`.
FREEZE_HELPER = """/**
 * Freeze `value` and everything reachable from it, then return it.
 *
 * Makes DEFAULT_PRINT_PARAMS immutable all the way down, so a caller that takes
 * a shallow copy and then writes to a nested object gets a TypeError (ES modules
 * are strict mode) instead of silently corrupting the shared default. Call
 * `defaultPrintParams()` for a copy that may be edited.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

"""

# Emitted verbatim below DEFAULT_PRINT_PARAMS.
FACTORY = """/**
 * A fresh, fully mutable deep copy of DEFAULT_PRINT_PARAMS.
 *
 * Use this - never `{ ...DEFAULT_PRINT_PARAMS }` - wherever the copy will be
 * edited, so no two pieces of state share a nested object with each other or
 * with the frozen constant. Mirrors `PrintParams()` in Python, whose nested
 * defaults are per-instance for the same reason.
 */
export function defaultPrintParams(): PrintParams {
  return structuredClone(DEFAULT_PRINT_PARAMS);
}

"""

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


def ref_target(prop: dict) -> str | None:
    """The $defs name a property points at, directly or through its items."""
    ref = prop.get("$ref")
    if ref is None and prop.get("type") == "array":
        ref = prop.get("items", {}).get("$ref")
    if ref is None:
        return None
    return ref.split("/")[-1]


def numeric_range_entries(
    props: dict,
    defs: dict,
    seen: frozenset[str] = frozenset(),
) -> list[tuple[str, dict | list]]:
    """PARAM_RANGES rows for one object's own properties, in schema order.

    A bounded scalar becomes a leaf ``(name, prop)``.  A property that points
    at a ``$defs`` object (directly, or as an array's item type) recurses into
    THAT object's own properties by the same rule, so a nested slider several
    levels deep (``PARAM_RANGES.regions.rail.width_m``,
    ``PARAM_RANGES.frame_style.shadow_gap.width_mm``) reads its range without
    the UI ever re-typing a bound. A branch with no bounded scalar at any
    depth contributes nothing. ``seen`` guards against a ``$defs`` cycle (none
    exists in this contract set, but a recursive walk should not trust that).
    """
    out: list[tuple[str, dict | list]] = []
    for name, prop in props.items():
        if "minimum" in prop and "maximum" in prop:
            out.append((name, prop))
            continue
        target = ref_target(prop)
        if target is None or target in seen:
            continue
        group = numeric_range_entries(
            defs.get(target, {}).get("properties", {}), defs, seen | {target}
        )
        if group:
            out.append((name, group))
    return out


def render_range_lines(entries: list[tuple[str, dict | list]], indent: int) -> list[str]:
    """Recursively render PARAM_RANGES rows at the given indent depth."""
    pad = " " * indent
    lines: list[str] = []
    for name, entry in entries:
        if isinstance(entry, list):
            lines.append(f"{pad}{name}: {{")
            lines.extend(render_range_lines(entry, indent + 2))
            lines.append(f"{pad}}},")
        else:
            lines.append(f"{pad}{name}: {range_literal(entry)},")
    return lines


# JSON Schema count keyword -> the PARAM_LIMITS key it becomes.  Order is fixed
# so the generated output stays byte-identical across runs.
COUNT_CONSTRAINTS = (
    ("minItems", "min_items"),
    ("maxItems", "max_items"),
    ("minLength", "min_length"),
    ("maxLength", "max_length"),
)


def count_limits(prop: dict) -> list[tuple[str, int]]:
    """The item-count / string-length caps declared on one schema fragment."""
    return [(key, prop[kw]) for kw, key in COUNT_CONSTRAINTS if kw in prop]


# One PARAM_LIMITS tree node: (name, own item-count/length caps, child nodes).
LimitNode = tuple[str, list[tuple[str, int]], list["LimitNode"]]


def limit_entries(
    props: dict,
    defs: dict,
    seen: frozenset[str] = frozenset(),
) -> list[LimitNode]:
    """PARAM_LIMITS rows for one object's own properties, in schema order.

    PARAM_RANGES only carries fragments with both ``minimum`` and ``maximum``,
    so the array caps (``engravings`` 8, ``hero_building_ids`` 12) and the
    string caps (``city_label``, ``Engraving.text``, ``UndersideMark.template``
    at 64, ``Colour.palette`` at 32) reached TS as types and runtime validation
    but not as constants, and a UI enforcing them would have to re-type the
    numbers. Each property contributes its own caps as a leaf
    (``city_label.max_length``) plus, when it points at a ``$defs`` object
    directly or as an array's item type, one child node per capped member,
    recursively - so a cap several levels deep (``colour.gradient.slots.max_items``)
    still surfaces. ``seen`` guards a ``$defs`` cycle, as in ``numeric_range_entries``.
    """
    out: list[LimitNode] = []
    for name, prop in props.items():
        own = count_limits(prop)
        children: list[LimitNode] = []
        target = ref_target(prop)
        if target is not None and target not in seen:
            children = limit_entries(
                defs.get(target, {}).get("properties", {}), defs, seen | {target}
            )
        if own or children:
            out.append((name, own, children))
    return out


def render_limit_node(name: str, own: list[tuple[str, int]], children: list[LimitNode], indent: int) -> list[str]:
    """Recursively render one PARAM_LIMITS row at the given indent depth."""
    pad = " " * indent
    if not children:
        body = ", ".join(f"{key}: {value}" for key, value in own)
        return [f"{pad}{name}: {{ {body} }},"]
    lines = [f"{pad}{name}: {{"]
    for key, value in own:
        lines.append(f"{pad}  {key}: {value},")
    for child_name, child_own, child_children in children:
        lines.extend(render_limit_node(child_name, child_own, child_children, indent + 2))
    lines.append(f"{pad}}},")
    return lines


def ts_literal(value, defs: dict | None = None, def_name: str | None = None, indent: int = 0) -> str:
    """A TS source literal for a JSON value.

    Object values are emitted one key per line (nested defaults are seven
    colours wide) in the referenced ``$defs`` property order, so the output is
    readable and stable regardless of how the schema's default was keyed.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, list):
        if not value:
            return "[]"
        return "[" + ", ".join(ts_literal(v, defs, None, indent) for v in value) + "]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        order = list((defs or {}).get(def_name or "", {}).get("properties", {}))
        keys = [k for k in order if k in value] + [k for k in value if k not in order]
        pad = " " * (indent + 2)
        body = "\n".join(f"{pad}{k}: {ts_literal(value[k], defs, None, indent + 2)}," for k in keys)
        return "{\n" + body + "\n" + " " * indent + "}"
    return json.dumps(value)


def range_literal(prop: dict) -> str:
    return (
        f"{{ min: {ts_literal(prop['minimum'])}, "
        f"max: {ts_literal(prop['maximum'])}, "
        f"default: {ts_literal(prop['default'])} }}"
    )


def leaf_paths(schema: dict) -> list[str]:
    """Every leaf of a PrintParams-shaped schema as a dotted path, in schema order.

    The pipeline's stage registry (``apps/web/lib/engine/pipeline``) declares
    which of these each stage reads, and its graph test compares the claims
    against this list, so a schema addition without a stage claim fails CI
    (DECISIONS [V3.1-P1-4]). Rules: a property that points at a ``$defs``
    object recurses into it (``frame_style.shadow_gap.width_mm``); an array
    whose items are a ``$defs`` object expands to ``name[].leaf``
    (``engravings[].text``); an array of scalars is one leaf
    (``hero_building_ids``, ``colour.gradient.slots``); everything else is a
    leaf. Shared verbatim with ``gen_py.py``.
    """
    defs = schema.get("$defs", {})

    def walk(props: dict, prefix: str, out: list[str]) -> None:
        for name, prop in props.items():
            path = f"{prefix}.{name}" if prefix else name
            ref = prop.get("$ref")
            if ref is not None:
                target = defs[ref.split("/")[-1]]
                if target.get("type") == "object":
                    walk(target.get("properties", {}), path, out)
                    continue
                out.append(path)
                continue
            if prop.get("type") == "array":
                item_ref = prop.get("items", {}).get("$ref")
                if item_ref is not None:
                    target = defs[item_ref.split("/")[-1]]
                    if target.get("type") == "object":
                        walk(target.get("properties", {}), f"{path}[]", out)
                        continue
            out.append(path)

    out: list[str] = []
    walk(schema.get("properties", {}), "", out)
    return out


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
    defs = print_params_schema.get("$defs", {})
    out.append("// ---- derived constants " + "-" * 20 + "\n\n")
    out.append(FREEZE_HELPER)
    default_lines = ["export const DEFAULT_PRINT_PARAMS: PrintParams = deepFreeze<PrintParams>({"]
    for name, prop in print_params_schema["properties"].items():
        literal = ts_literal(prop["default"], defs, ref_target(prop), 2)
        default_lines.append(f"  {name}: {literal},")
    default_lines.append("});\n")
    out.append("\n".join(default_lines))
    out.append("\n")
    out.append(FACTORY)

    # PARAM_RANGES: every numeric PrintParams field with a min/max, plus one
    # nested group per $defs object that has bounded scalars of its own,
    # recursively (see numeric_range_entries).
    range_lines = ["export const PARAM_RANGES = {"]
    range_lines.extend(
        render_range_lines(numeric_range_entries(print_params_schema["properties"], defs), 2)
    )
    range_lines.append("} as const;\n")
    out.append("\n".join(range_lines))
    out.append("\n")

    # PARAM_LIMITS: the array and string caps PARAM_RANGES cannot carry,
    # recursively (see limit_entries).
    limit_lines = [
        "/**",
        " * Every item-count and string-length cap the contract declares, so a UI",
        " * enforcing one never re-types the number at its call site (the drift",
        " * PARAM_RANGES exists to prevent, for the bounds PARAM_RANGES has no room",
        " * for: it carries only fragments with both a minimum and a maximum).",
        " */",
        "export const PARAM_LIMITS = {",
    ]
    for name, own, children in limit_entries(print_params_schema["properties"], defs):
        limit_lines.extend(render_limit_node(name, own, children, 2))
    limit_lines.append("} as const;\n")
    out.append("\n".join(limit_lines))
    out.append("\n")

    # PRINT_PARAM_LEAF_PATHS: every PrintParams leaf as a dotted path, so the
    # pipeline's stage claims can be checked against the contract.
    path_lines = [
        "/**",
        " * Every leaf of PrintParams as a dotted path, in schema order: nested objects",
        " * expanded (`frame_style.shadow_gap.width_mm`), arrays of objects as",
        " * `engravings[].text`, arrays of scalars as one leaf (`hero_building_ids`).",
        " * The pipeline stage registry declares which of these each stage reads and",
        " * `lib/engine/pipeline/graph.test.ts` checks every one is claimed, so a schema",
        " * addition without a stage claim fails CI (DECISIONS [V3.1-P1-4]).",
        " */",
        "export const PRINT_PARAM_LEAF_PATHS = [",
    ]
    for path in leaf_paths(print_params_schema):
        path_lines.append(f"  {json.dumps(path)},")
    path_lines.append("] as const;\n")
    path_lines.append("export type PrintParamPath = (typeof PRINT_PARAM_LEAF_PATHS)[number];\n")
    out.append("\n".join(path_lines))
    out.append("\n")

    return "".join(out).rstrip() + "\n"


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(generate(), encoding="utf-8", newline="\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
