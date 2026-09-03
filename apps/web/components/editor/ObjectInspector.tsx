"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_PRINT_PARAMS, PARAM_RANGES, type ObjectOverride } from "@/lib/contracts";
import type { ObjectInfo } from "@/lib/objectInfo";
import {
  OVERRIDE_MAX_ITEMS,
  OVERRIDE_MAX_REGIONS,
  actionsForLayer,
  describeOverride,
  findOverride,
  isOverrideInactive,
  jumpsForRegion,
  regionHeading,
  withOverride,
  withoutOverride,
  type OverrideAction,
  type OverrideLayer,
} from "@/lib/objectOverrides";
import { labelCapMessage } from "@/lib/labelAnchor";
import { useEditorStore } from "@/store/editor";
import { Slider } from "./Controls";

/**
 * The right-click inspector: what this object is, and what you may decide about
 * it (v3.1 Task 11).
 *
 * The hover popover answers "what is this?" and can answer nothing else,
 * because nothing drawn in the viewport may read a `PrintParams` field. This
 * component is the other half and lives OUTSIDE `components/scene/` for exactly
 * that reason: it reads the parameters, writes them, and is rendered as a
 * sibling of the canvas rather than inside it.
 *
 * ## Why it is a menu and not a panel
 *
 * Every action here is a write to one `object_overrides` row, and a row is a
 * handful of independent choices. A menu is the shape that lets a keyboard
 * reach all of them in one gesture: `role="menu"` with `menuitem`,
 * `menuitemradio` and `menuitemcheckbox` children gives arrow-key roving, Home
 * and End, and one accessible name per action for free. The three continuous
 * values - a building's height, a road's width, a polygon's raise - cannot be a
 * menu item, so each opens a second view in the same popup with one real
 * control in it, and Escape steps back out of that view before it closes the
 * popup.
 *
 * ## Precision
 *
 * The menu says nothing about the object it was opened on that
 * `lib/objectInfo.ts` did not resolve, and that module is exact for buildings
 * and nearest-entity for roads and areas ([V3.1-P10-3]). So the heading is the
 * popover's own heading and the actions are keyed by the BASE OSM id the same
 * resolver returned. An object with no OSM id - a merged block, a dissolved
 * polygon the ingest could not attribute - can carry no override at all, and
 * the menu says so rather than offering controls that would write a row nothing
 * would ever match.
 */

/** What the menu was opened on. */
export type InspectorTarget =
  | {
      kind: "object";
      info: ObjectInfo;
      /** The base OSM id an override is keyed by, null when the object has none. */
      osmId: string | null;
      layer: OverrideLayer;
    }
  | { kind: "region"; region: string | null };

interface InspectorProps {
  target: InspectorTarget | null;
  /** Viewport-relative pixel position to open at. */
  at: { x: number; y: number };
  onClose: () => void;
}

/** Gap between the click point and the menu's near corner, pixels. */
const POINTER_OFFSET_PX = 6;

type View = "menu" | OverrideAction;

interface MenuRow {
  key: string;
  label: string;
  /** `menuitem` runs `onSelect`; the other two also render a checked state. */
  role: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  checked?: boolean;
  onSelect: () => void;
  /** A radio set's rows are wrapped in a labelled group. */
  groupLabel?: string;
}

export function ObjectInspector({ target, at, onClose }: InspectorProps) {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const graph = useEditorStore((state) => state.scene.graph);
  const addLabel = useEditorStore((state) => state.addLabel);
  const labelCapHit = useEditorStore((state) => state.labelCapHit);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<View>("menu");
  const [capped, setCapped] = useState(false);
  const [cursor, setCursor] = useState(0);

  const osmId = target?.kind === "object" ? target.osmId : null;
  const layer = target?.kind === "object" ? target.layer : null;
  const row = osmId === null || layer === null ? null : findOverride(params, osmId, layer);
  const inactive =
    osmId !== null && layer !== null && row !== null && isOverrideInactive(graph, params, osmId, layer);

  /** Write one member of this object's row, refusing politely at the cap. */
  const write = useCallback(
    (patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>) => {
      if (osmId === null || layer === null) return;
      const result = withOverride(params, osmId, layer, patch);
      if (result.capped) {
        setCapped(true);
        return;
      }
      setCapped(false);
      setParam("object_overrides", result.overrides);
    },
    [layer, osmId, params, setParam],
  );

  const reset = useCallback(() => {
    if (osmId === null || layer === null) return;
    setCapped(false);
    setParam("object_overrides", withoutOverride(params, osmId, layer));
  }, [layer, osmId, params, setParam]);

  // Focus is captured on open and given back on close, whichever way it closes:
  // a menu that dropped focus on the body would leave a keyboard user at the
  // top of the document, several dozen Tab presses from where they were.
  const open = target !== null;
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setView("menu");
    setCursor(0);
    setCapped(false);
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener !== null && document.body.contains(opener)) opener.focus();
    };
  }, [open, osmId, layer]);

  // A press anywhere outside closes it, which is what a context menu does. On
  // the CAPTURE phase, so a click meant to dismiss the menu does not also land
  // on whatever is underneath.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      const card = cardRef.current;
      if (card === null) return;
      if (event.target instanceof Node && card.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose]);

  /**
   * "Label ..." (v3.1 Task 12): a surface label on this object, at its centre,
   * selected so the gizmo and the labels card pick it up. Refused at the cap
   * with the same kind of notice the override cap gets; the menu stays open so
   * the notice can be read.
   */
  const placeLabel = useCallback(() => {
    if (osmId === null || layer === null) return;
    const index = addLabel({ osmId, layer });
    if (index !== null) onClose();
  }, [addLabel, layer, onClose, osmId]);

  const rows = useMemo<MenuRow[]>(
    () => (target === null ? [] : buildRows(target, row, write, reset, setView, placeLabel)),
    [target, row, write, reset, placeLabel],
  );

  // Roving focus: the menu is one Tab stop and the arrows walk it.
  useEffect(() => {
    if (!open || view !== "menu") return;
    const card = cardRef.current;
    if (card === null) return;
    const items = card.querySelectorAll<HTMLElement>("[data-menu-item]");
    items[Math.min(cursor, items.length - 1)]?.focus();
  }, [open, view, cursor, rows.length]);

  // The edit view opens with its control focused, so a value action reached by
  // keyboard is immediately adjustable.
  useEffect(() => {
    if (!open || view === "menu") return;
    cardRef.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, [open, view]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      // The menu owns the keyboard while it is open: every key is handled or
      // swallowed here, so a stray letter cannot reach the editor's global
      // shortcuts and export the model from behind an open menu.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        if (view !== "menu") {
          setView("menu");
          return;
        }
        onClose();
        return;
      }
      if (view !== "menu") return;
      const last = rows.length - 1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((current) => (current >= last ? 0 : current + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((current) => (current <= 0 ? last : current - 1));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setCursor(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setCursor(Math.max(0, last));
      }
    },
    [onClose, rows.length, view],
  );

  if (target === null) return null;

  const heading =
    target.kind === "object" ? target.info.title : regionHeading(target.region);
  const subheading =
    target.kind === "object"
      ? target.info.named
        ? target.info.typeLabel
        : "No OpenStreetMap name"
      : "Not an OpenStreetMap object";

  return (
    <div
      ref={cardRef}
      data-testid="object-inspector"
      data-inspector-view={view}
      data-inspector-layer={target.kind === "object" ? target.layer : ""}
      data-inspector-region={target.kind === "region" ? (target.region ?? "none") : ""}
      className="absolute z-20 w-56 rounded-milled border border-line-strong bg-plate p-2 shadow-raised"
      style={{ left: clamp(at.x + POINTER_OFFSET_PX, 224), top: clamp(at.y + POINTER_OFFSET_PX, 320) }}
      onKeyDown={onKeyDown}
    >
      <p className="truncate font-display text-2xs font-semibold text-ink" title={heading}>
        {heading}
      </p>
      <p className="truncate text-2xs text-ink-faint">{subheading}</p>
      {row !== null ? (
        <p data-testid="object-inspector-summary" className="mt-1 truncate text-2xs text-ink-muted">
          {describeOverride(row)}
          {inactive ? " (inactive here)" : ""}
        </p>
      ) : null}
      {inactive ? (
        <p data-testid="object-inspector-inactive" className="mt-1 text-2xs text-ink-faint">
          This map area does not reach the object these changes were made on. They are kept and come
          back when it does.
        </p>
      ) : null}
      {target.kind === "object" && target.osmId === null ? (
        <p data-testid="object-inspector-no-id" className="mt-1 text-2xs text-ink-faint">
          There is no single OpenStreetMap element behind this one, so it cannot carry a change of its
          own.
        </p>
      ) : null}
      {capped ? (
        <p data-testid="object-inspector-capped" role="alert" className="mt-1 text-2xs text-ink-muted">
          {OVERRIDE_MAX_ITEMS} objects already carry a change of their own, which is the most a
          project may hold. Reset one to make room.
        </p>
      ) : null}
      {labelCapHit && target.kind === "object" && target.osmId !== null ? (
        <p data-testid="object-inspector-label-capped" role="alert" className="mt-1 text-2xs text-ink-muted">
          {labelCapMessage()}
        </p>
      ) : null}

      {view === "menu" ? (
        <Menu rows={rows} label={`Actions for ${heading}`} />
      ) : (
        <EditView view={view} row={row} onWrite={write} onBack={() => setView("menu")} />
      )}
    </div>
  );
}

/** Keep the menu inside the viewport it is drawn over. */
function clamp(value: number, size: number): number {
  return Math.max(4, Math.min(value, Math.max(4, window.innerWidth - size)));
}

function Menu({ rows, label }: { rows: readonly MenuRow[]; label: string }) {
  const out: React.ReactNode[] = [];
  let index = 0;
  while (index < rows.length) {
    const groupLabel = rows[index].groupLabel;
    if (groupLabel === undefined) {
      out.push(<MenuItem key={rows[index].key} row={rows[index]} />);
      index += 1;
      continue;
    }
    const members: MenuRow[] = [];
    while (index < rows.length && rows[index].groupLabel === groupLabel) {
      members.push(rows[index]);
      index += 1;
    }
    out.push(
      <div key={groupLabel} role="group" aria-label={groupLabel} className="border-t border-line pt-1">
        {/*
          The heading is drawn, not announced: the group already carries the
          same words as its `aria-label`, and a bare `<p>` owned by a `menu` is
          a child role that role does not allow. So it is hidden from the
          accessibility tree and the group's own name carries it.
        */}
        <p aria-hidden="true" className="px-1 pb-0.5 text-2xs text-ink-faint">
          {groupLabel}
        </p>
        {members.map((member) => (
          <MenuItem key={member.key} row={member} />
        ))}
      </div>,
    );
  }
  return (
    <div role="menu" aria-label={label} className="mt-1.5 flex flex-col gap-0.5">
      {out}
    </div>
  );
}

function MenuItem({ row }: { row: MenuRow }) {
  return (
    <button
      type="button"
      role={row.role}
      data-menu-item=""
      data-testid={`inspector-${row.key}`}
      tabIndex={-1}
      {...(row.role === "menuitem" ? {} : { "aria-checked": row.checked === true })}
      onClick={row.onSelect}
      /*
        The roving focus is marked on `:focus`, not on `:focus-visible`. The
        global rule (`app/globals.css`) is the right one for a Tab stop, but
        these are not Tab stops: focus is MOVED here by script, and a
        script-moved focus after a right-click does not match `:focus-visible`
        in any browser -- so the one item the arrow keys are about to act on
        would carry no mark at all until the second press. The ring is drawn
        inside the item's own box so it cannot be clipped by the card's edge.
      */
      className={`w-full rounded-[2px] px-1.5 py-1 text-left text-2xs transition-colors focus:outline-2 focus:-outline-offset-2 focus:outline-focus ${
        row.checked === true ? "bg-primary text-primary-ink" : "text-ink hover:bg-plate-raised"
      }`}
    >
      {row.label}
    </button>
  );
}

/**
 * The rows for one target.
 *
 * Only what the object's kind can act on: a road has no height, a park has no
 * hero mark, and a control that would write a member the engine ignores on that
 * layer is not rendered at all. A control that exists changes the preview and
 * the exported file, or it is not here.
 */
function buildRows(
  target: InspectorTarget,
  row: ObjectOverride | null,
  write: (patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>) => void,
  reset: () => void,
  setView: (view: View) => void,
  placeLabel: () => void,
): MenuRow[] {
  if (target.kind === "region") {
    return jumpsForRegion(target.region).map((jump) => ({
      key: `jump-${jump.groupId}`,
      label: jump.label,
      role: "menuitem" as const,
      onSelect: () => revealSettingsGroup(jump.groupId),
    }));
  }
  if (target.osmId === null) {
    return jumpsForRegion(null).map((jump) => ({
      key: `jump-${jump.groupId}`,
      label: jump.label,
      role: "menuitem" as const,
      onSelect: () => revealSettingsGroup(jump.groupId),
    }));
  }

  const rows: MenuRow[] = [];
  const hidden = row?.hidden === true;
  // The one row that is not an override: a surface label on this object
  // (v3.1 Task 12), placed at its centre and dragged from there.
  rows.push({
    key: "label",
    label: LABEL_ROW_LABELS[target.layer],
    role: "menuitem",
    onSelect: placeLabel,
  });
  for (const action of actionsForLayer(target.layer)) {
    if (action === "hero") {
      const hero = row?.hero ?? "inherit";
      for (const [value, label] of [
        ["inherit", "Hero: as the settings say"],
        ["on", "Hero: always"],
        ["off", "Hero: never"],
      ] as const) {
        rows.push({
          key: `hero-${value}`,
          label,
          role: "menuitemradio",
          checked: hero === value,
          groupLabel: "Hero building",
          onSelect: () => write({ hero: value }),
        });
      }
      continue;
    }
    if (action === "road_mode") {
      const mode = row?.road_mode ?? "inherit";
      for (const [value, label] of [
        ["inherit", "As the settings say"],
        ["engrave", "Engrave this road"],
        ["emboss", "Emboss this road"],
        ["off", "Leave this road out"],
      ] as const) {
        rows.push({
          key: `road-mode-${value}`,
          label,
          role: "menuitemradio",
          checked: mode === value,
          groupLabel: "This road prints",
          onSelect: () => write({ road_mode: value }),
        });
      }
      continue;
    }
    if (action === "hide") {
      rows.push({
        key: "hide",
        label: hidden ? "Put it back in the model" : "Leave it out of the model",
        role: "menuitemcheckbox",
        checked: hidden,
        onSelect: () => write({ hidden: !hidden }),
      });
      continue;
    }
    if (action === "reset") {
      rows.push({
        key: "reset",
        label: "Reset this object",
        role: "menuitem",
        onSelect: reset,
      });
      continue;
    }
    rows.push({
      key: action,
      label: EDIT_LABELS[action],
      role: "menuitem",
      onSelect: () => setView(action),
    });
  }
  return rows;
}

/** The "Label ..." row's wording, by the surface the label will print on. */
const LABEL_ROW_LABELS: Record<OverrideLayer, string> = {
  building: "Label its roof",
  road: "Label this street",
  water: "Label the water",
  green: "Label this green",
};

const EDIT_LABELS: Record<OverrideAction, string> = {
  hide: "Leave it out of the model",
  height_scale: "Height...",
  hero: "Hero building",
  tint: "Its own shade...",
  colour: "Its own filament...",
  road_mode: "This road prints",
  width_scale: "Width...",
  raise_mm: "Raise or sink...",
  reset: "Reset this object",
};

/**
 * The second view: one continuous value, with the control the settings panel
 * would use for it.
 *
 * `Slider` commits on release and on key-up, so a drag is one history entry
 * rather than one per pixel, which is the same gate every other slider in the
 * app goes through.
 */
function EditView({
  view,
  row,
  onWrite,
  onBack,
}: {
  view: Exclude<View, "menu">;
  row: ObjectOverride | null;
  onWrite: (patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>) => void;
  onBack: () => void;
}) {
  return (
    <div role="group" aria-label={EDIT_LABELS[view]} className="mt-1.5 space-y-2">
      {view === "height_scale" ? (
        <Slider
          id="override-height-scale"
          label="Height"
          value={row?.height_scale ?? 1}
          min={PARAM_RANGES.object_overrides.height_scale.min}
          max={PARAM_RANGES.object_overrides.height_scale.max}
          step={0.05}
          display={`${Math.round((row?.height_scale ?? 1) * 100) / 100}x`}
          onChange={(value) => onWrite({ height_scale: value })}
          hint="Multiplies this building's OpenStreetMap height before every other height rule."
        />
      ) : null}
      {view === "width_scale" ? (
        <Slider
          id="override-width-scale"
          label="Width"
          value={row?.width_scale ?? 1}
          min={PARAM_RANGES.object_overrides.width_scale.min}
          max={PARAM_RANGES.object_overrides.width_scale.max}
          step={0.05}
          display={`${Math.round((row?.width_scale ?? 1) * 100) / 100}x`}
          onChange={(value) => onWrite({ width_scale: value })}
          hint="Multiplies this road's ground width. A road below the minimum wall still prints at one."
        />
      ) : null}
      {view === "raise_mm" ? (
        <Slider
          id="override-raise-mm"
          label="Raise or sink"
          value={row?.raise_mm ?? 0}
          min={PARAM_RANGES.object_overrides.raise_mm.min}
          max={PARAM_RANGES.object_overrides.raise_mm.max}
          step={0.05}
          display={`${(row?.raise_mm ?? 0).toFixed(2)} mm`}
          onChange={(value) => onWrite({ raise_mm: value })}
          hint="Moves this polygon's top face relative to the rest of its layer."
        />
      ) : null}
      {view === "colour" ? (
        <FilamentEditor row={row} onWrite={onWrite} />
      ) : null}
      {view === "tint" ? (
        <ShadeEditor row={row} onWrite={onWrite} />
      ) : null}
      <button
        type="button"
        data-testid="inspector-back"
        onClick={onBack}
        className="w-full rounded-[2px] px-1.5 py-1 text-left text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink focus:outline-2 focus:-outline-offset-2 focus:outline-focus"
      >
        Back
      </button>
    </div>
  );
}

const SLOT_MAX = PARAM_RANGES.object_overrides.slot.max;

/**
 * What a colour picker opens on before the user has chosen anything.
 *
 * Read off the CONTRACT's own defaults, not written out: a hex literal in a
 * component is what `lib/design-tokens.test.ts` forbids, and the reason it
 * forbids it is that a colour written twice drifts. The hero colour is the seed
 * for "give this object its own filament" and the buildings colour is the seed
 * for "give this building its own shade", which are the two things each picker
 * is nearest to.
 */
const SEED_FILAMENT = DEFAULT_PRINT_PARAMS.colour?.region_colors?.hero_building ?? "";
const SEED_SHADE = DEFAULT_PRINT_PARAMS.colour?.region_colors?.buildings ?? "";

function FilamentEditor({
  row,
  onWrite,
}: {
  row: ObjectOverride | null;
  onWrite: (patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>) => void;
}) {
  const slot = row?.slot ?? 0;
  const color = row?.color ?? "";
  return (
    <>
      <label htmlFor="override-slot" className="block text-2xs font-medium text-ink">
        Filament slot
      </label>
      <select
        id="override-slot"
        data-testid="override-slot"
        value={String(slot)}
        onChange={(event) => onWrite({ slot: Number(event.target.value) })}
        className="w-full rounded-milled border border-line bg-plate-raised px-2 py-1 text-2xs text-ink"
      >
        <option value="0">Its layer&apos;s slot</option>
        {Array.from({ length: SLOT_MAX }, (_, index) => (
          <option key={index + 1} value={String(index + 1)}>
            Slot {index + 1}
          </option>
        ))}
      </select>
      <label htmlFor="override-color" className="block text-2xs font-medium text-ink">
        Filament colour
      </label>
      <div className="flex items-center gap-2">
        <input
          id="override-color"
          data-testid="override-color"
          type="color"
          value={color === "" ? SEED_FILAMENT : color.slice(0, 7)}
          onChange={(event) => onWrite({ color: event.target.value.toUpperCase() })}
          className="h-7 w-10 rounded-milled border border-line bg-plate-raised"
        />
        <button
          type="button"
          data-testid="override-color-clear"
          onClick={() => onWrite({ color: "" })}
          className="rounded-[2px] px-1.5 py-1 text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink"
        >
          Use the layer&apos;s colour
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        At most {OVERRIDE_MAX_REGIONS} objects may print in a filament of their own; objects given the
        same colour share one.
      </p>
    </>
  );
}

function ShadeEditor({
  row,
  onWrite,
}: {
  row: ObjectOverride | null;
  onWrite: (patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>) => void;
}) {
  const tint = row?.tint ?? "";
  return (
    <>
      <label htmlFor="override-tint" className="block text-2xs font-medium text-ink">
        Shade
      </label>
      <div className="flex items-center gap-2">
        <input
          id="override-tint"
          data-testid="override-tint"
          type="color"
          value={tint === "" ? SEED_SHADE : tint.slice(0, 7)}
          onChange={(event) => onWrite({ tint: event.target.value.toUpperCase() })}
          className="h-7 w-10 rounded-milled border border-line bg-plate-raised"
        />
        <button
          type="button"
          data-testid="override-tint-clear"
          onClick={() => onWrite({ tint: "" })}
          className="rounded-[2px] px-1.5 py-1 text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink"
        >
          No shade
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        A shade is a preview and OBJ colour, not a filament: a printer lays down whatever is in the
        slot.
      </p>
    </>
  );
}

/**
 * Open a settings group and put the caret in it.
 *
 * Through the panel's own DOM contract (`group-<id>-toggle` and
 * `data-collapsed`, both asserted by `CollapsibleGroup`'s tests) rather than
 * through a new store field: clicking the real toggle goes through the real
 * handler, so the group's collapsed state is persisted exactly as it would be
 * if the user had clicked it, and this file adds nothing to the panel's own
 * state that could fall out of step with it.
 */
export function revealSettingsGroup(groupId: string): void {
  const toggle = document.querySelector<HTMLElement>(`[data-testid="group-${groupId}-toggle"]`);
  if (toggle === null) return;
  const section = toggle.closest("[data-collapsed]");
  if (section?.getAttribute("data-collapsed") === "true") toggle.click();
  toggle.scrollIntoView({ block: "center" });
  toggle.focus();
}

export default ObjectInspector;
