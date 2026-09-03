"use client";

import {
  RAIL_PX,
  type MaximizedRegion,
  type SideRegion,
} from "@/lib/layout";
import { useLayoutStore } from "@/store/layout";

/**
 * The controls that change the shape of the shell, and the strip that brings a
 * hidden column back.
 *
 * All four live in the header, together, and never move. That is the point:
 * the alternative -- a control docked inside each pane -- puts the button that
 * hides a column INSIDE the column it hides, costs the viewport a title bar it
 * does not need, and collides with the badges the preview already docks in its
 * own corners. A fixed cluster is also the only arrangement in which the
 * button that restores a hidden column is somewhere a user can look for it
 * before they know it exists.
 *
 * The second half of the module is that restoring affordance's other half: a
 * narrow rail standing exactly where the hidden column was, so the way back is
 * visible in the place the thing disappeared from as well as in the header.
 *
 * Everything here is `lg` and up. Below that the shell stacks the map over the
 * preview and the settings are a bottom sheet, where "which of three columns
 * is wider" is not a question the layout can answer.
 */

const BUTTON =
  "rounded-milled border px-2 py-1 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const IDLE = "border-control bg-plate-raised text-ink-muted hover:border-ink-faint hover:text-ink";
const ACTIVE = "border-accent bg-accent text-accent-ink";

interface ToggleProps {
  testId: string;
  /** What the button says. */
  label: string;
  /**
   * Its accessible name: the label, spelled out.
   *
   * It always BEGINS with the visible text, so the name a screen reader
   * announces and the words a speech-control user says out loud are the same
   * words (WCAG 2.5.3, Label in Name). The reason a disabled toggle is
   * disabled goes in the title instead, where it does not rewrite the name of
   * the control.
   */
  name: string;
  title: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function LayoutToggle({ testId, label, name, title, pressed, disabled, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      aria-label={name}
      title={title}
      disabled={disabled ?? false}
      onClick={onClick}
      className={`${BUTTON} ${pressed ? ACTIVE : IDLE}`}
    >
      {label}
    </button>
  );
}

/**
 * The header cluster: hide either side column, or give the map or the preview
 * the whole window.
 *
 * The visible text says what the click will DO, and flips with the state, so
 * the control reads correctly without having to be inspected: "Hide map"
 * becomes "Show map", and either wide button becomes "Restore" while it is the
 * one holding the window. `aria-pressed` carries the state itself, which is
 * what a screen reader announces, and the accessible name is the full sentence
 * rather than the two-word label.
 *
 * The two hide toggles are disabled while a region is maximized. Hiding a
 * column that is already off screen is not a thing to ask for, and the honest
 * way to say so is a disabled control with a reason in its title rather than a
 * live button that quietly changes a state nobody can see.
 */
export function LayoutControls() {
  const collapsed = useLayoutStore((state) => state.collapsed);
  const maximized = useLayoutStore((state) => state.maximized);
  const toggleCollapsed = useLayoutStore((state) => state.toggleCollapsed);
  const toggleMaximized = useLayoutStore((state) => state.toggleMaximized);

  const whileMaximized = maximized !== null;

  return (
    <div
      data-testid="layout-controls"
      role="group"
      aria-label="Window layout"
      className="hidden shrink-0 items-center gap-1.5 lg:flex"
    >
      <LayoutToggle
        testId="layout-collapse-map"
        label={collapsed.map ? "Show map" : "Hide map"}
        name={collapsed.map ? "Show map column" : "Hide map column"}
        title={
          whileMaximized
            ? "Restore the columns before hiding one"
            : collapsed.map
              ? "Show map column"
              : "Hide map column"
        }
        pressed={collapsed.map}
        disabled={whileMaximized}
        onClick={() => toggleCollapsed("map")}
      />
      <LayoutToggle
        testId="layout-maximize-map"
        label={maximized === "map" ? "Restore" : "Wide map"}
        name={
          maximized === "map"
            ? "Restore the three columns"
            : "Wide map: give the map the whole window"
        }
        title={
          maximized === "map"
            ? "Restore the three columns"
            : "Give the map the whole window"
        }
        pressed={maximized === "map"}
        onClick={() => toggleMaximized("map")}
      />
      <LayoutToggle
        testId="layout-maximize-viewport"
        label={maximized === "viewport" ? "Restore" : "Wide preview"}
        name={
          maximized === "viewport"
            ? "Restore the three columns"
            : "Wide preview: give the 3D preview the whole window"
        }
        title={
          maximized === "viewport"
            ? "Restore the three columns"
            : "Give the 3D preview the whole window"
        }
        pressed={maximized === "viewport"}
        onClick={() => toggleMaximized("viewport")}
      />
      <LayoutToggle
        testId="layout-collapse-settings"
        label={collapsed.settings ? "Show settings" : "Hide settings"}
        name={collapsed.settings ? "Show settings column" : "Hide settings column"}
        title={
          whileMaximized
            ? "Restore the columns before hiding one"
            : collapsed.settings
              ? "Show settings column"
              : "Hide settings column"
        }
        pressed={collapsed.settings}
        disabled={whileMaximized}
        onClick={() => toggleCollapsed("settings")}
      />
    </div>
  );
}

const RAIL_LABEL: Readonly<Record<SideRegion, string>> = {
  map: "Map",
  settings: "Settings",
};

/**
 * The strip left behind by a hidden column, and the way back from it.
 *
 * Whole-rail button rather than an icon inside a strip: the target is the full
 * height of the column that used to be there, which is both the easiest thing
 * to hit and the clearest statement of what will come back. The label is set
 * sideways so the name of the missing column is readable in 28 px, and the
 * accessible name is the full sentence.
 */
export function CollapsedRail({ region }: { region: SideRegion }) {
  const setCollapsed = useLayoutStore((state) => state.setCollapsed);
  const side = region === "map" ? "border-r" : "border-l";
  return (
    <button
      type="button"
      data-testid={`layout-rail-${region}`}
      aria-label={`Show the ${region === "map" ? "map" : "settings"} column`}
      title={`Show the ${region === "map" ? "map" : "settings"} column`}
      onClick={() => setCollapsed(region, false)}
      style={{ width: RAIL_PX }}
      className={`hidden shrink-0 grow-0 items-center justify-center border-line bg-plate text-2xs uppercase tracking-[0.16em] text-ink-faint transition-colors hover:bg-plate-raised hover:text-ink lg:flex ${side}`}
    >
      <span style={{ writingMode: "vertical-rl" }} className="rotate-180">
        {RAIL_LABEL[region]}
      </span>
    </button>
  );
}

/** Which rails are on screen: a hidden side column has one, unless a region has taken the whole window. */
export function collapsedRails(
  collapsed: Readonly<Record<SideRegion, boolean>>,
  maximized: MaximizedRegion,
): readonly SideRegion[] {
  if (maximized !== null) return [];
  const rails: SideRegion[] = [];
  if (collapsed.map) rails.push("map");
  if (collapsed.settings) rails.push("settings");
  return rails;
}
