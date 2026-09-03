/**
 * Search across every control in the settings panel, by label and by help.
 *
 * The panel is ninety-odd controls in twelve sections, most of them collapsed.
 * Without a search the only way to find "how deep are the roads cut" is to open
 * every section and read, so this indexes the CATALOG
 * (`lib/controlCatalog.ts`) rather than the rendered DOM: the catalog already
 * holds the label a user reads and the help string that says what the control
 * does in physical terms, which is exactly the text worth matching, and it is
 * the same string the control itself renders.
 *
 * What is matched, in order of weight: the control's label, its section's
 * heading, and its help. Every token of the query must land somewhere, so
 * "rail width" finds the rail ribbon slider and "rail colour" finds the
 * filament row instead.
 *
 * The `output` group is deliberately not indexed. Its three rows are Reset all
 * (always on screen in the panel header), the results fold and the export
 * format select, which lives in the action bar: a hit that cannot be scrolled
 * to inside the panel is a dead result.
 */

import { CONTROLS, SECTIONS, type ControlSpec, type SectionSpec } from "./controlCatalog";
import { GROUPS, type GroupId } from "./groups";

export type SearchHitKind = "control" | "section";

export interface SearchHit {
  /** The catalog id: a control id, or a labelled block's section id. */
  id: string;
  kind: SearchHitKind;
  group: GroupId;
  label: string;
  help: string;
  /**
   * The `data-testid` the panel can focus. A control keyed by a `*` form
   * (`engraving_*_text`) has no single element to focus, so it is null and the
   * hit only expands its section.
   */
  focusTestId: string | null;
  /** Higher is a better match; the panel sorts on it. */
  score: number;
}

const GROUP_TITLES: ReadonlyMap<GroupId, string> = new Map(
  GROUPS.map((group) => [group.id, group.title]),
);

/** Sections whose hits cannot be shown inside the scrolling panel body. */
const UNSEARCHABLE_GROUPS: ReadonlySet<GroupId> = new Set<GroupId>(["output"]);

/** The query, lower-cased and split into the tokens that must all match. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

interface Indexed {
  id: string;
  kind: SearchHitKind;
  group: GroupId;
  label: string;
  help: string;
  focusTestId: string | null;
  groupTitle: string;
}

function indexControl(spec: ControlSpec): Indexed {
  return {
    id: spec.id,
    kind: "control",
    group: spec.group,
    label: spec.label,
    help: spec.help,
    // A `*` row is rendered once per item, so there is no one element to focus.
    focusTestId: spec.testId.includes("*") ? null : spec.testId,
    groupTitle: GROUP_TITLES.get(spec.group) ?? "",
  };
}

function indexSection(spec: SectionSpec): Indexed {
  return {
    id: spec.id,
    kind: "section",
    group: spec.group,
    label: spec.label,
    help: spec.help,
    focusTestId: null,
    groupTitle: GROUP_TITLES.get(spec.group) ?? "",
  };
}

const INDEX: readonly Indexed[] = [
  ...CONTROLS.filter((spec) => !UNSEARCHABLE_GROUPS.has(spec.group)).map(indexControl),
  ...SECTIONS.filter((spec) => !UNSEARCHABLE_GROUPS.has(spec.group)).map(indexSection),
];

/** Everything the search can ever return, for the tests and the empty state. */
export function searchableCount(): number {
  return INDEX.filter((entry) => entry.kind === "control").length;
}

/**
 * How well one token matches one entry, or 0 for no match.
 *
 * A word boundary beats a substring, and the label beats the help: "size"
 * should surface Plate size before every help string that mentions a size.
 */
function scoreToken(entry: Indexed, token: string): number {
  const label = entry.label.toLowerCase();
  const help = entry.help.toLowerCase();
  const groupTitle = entry.groupTitle.toLowerCase();
  if (label === token) return 100;
  if (label.startsWith(token)) return 60;
  if (new RegExp(`\\b${escapeRegExp(token)}`).test(label)) return 40;
  if (label.includes(token)) return 24;
  if (groupTitle.includes(token)) return 16;
  if (new RegExp(`\\b${escapeRegExp(token)}`).test(help)) return 8;
  if (help.includes(token)) return 4;
  return 0;
}

/**
 * The matching controls, best first.
 *
 * An empty (or whitespace) query returns nothing rather than everything: the
 * panel shows its sections when nothing is being searched for.
 */
export function searchSettings(query: string): SearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of INDEX) {
    let score = 0;
    let matchedEvery = true;
    for (const token of tokens) {
      const tokenScore = scoreToken(entry, token);
      if (tokenScore === 0) {
        matchedEvery = false;
        break;
      }
      score += tokenScore;
    }
    if (!matchedEvery) continue;
    // A labelled block is a route to its controls, never better than one.
    hits.push({
      id: entry.id,
      kind: entry.kind,
      group: entry.group,
      label: entry.label,
      help: entry.help,
      focusTestId: entry.focusTestId,
      score: entry.kind === "section" ? score - 1 : score,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** The sections that hold at least one hit, so the panel can open exactly those. */
export function groupsWithHits(hits: readonly SearchHit[]): ReadonlySet<GroupId> {
  return new Set(hits.map((hit) => hit.group));
}

/** The hits of one section, in the order `searchSettings` ranked them. */
export function hitsInGroup(hits: readonly SearchHit[], group: GroupId): SearchHit[] {
  return hits.filter((hit) => hit.group === group);
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export interface Segment {
  text: string;
  /** True for the part of the text a query token matched. */
  hit: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` split into matched and unmatched runs, so the panel can mark the
 * matched ones without ever building HTML from a string.
 *
 * Overlapping tokens are merged ("rail" and "ail" mark one run, not two
 * nested ones), and the original casing is preserved: the segments are slices
 * of `text` itself.
 */
export function highlight(text: string, query: string): Segment[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || text === "") return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let from = lower.indexOf(token);
    while (from !== -1) {
      ranges.push([from, from + token.length]);
      from = lower.indexOf(token, from + 1);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) out.push({ text: text.slice(cursor, from), hit: false });
    out.push({ text: text.slice(from, to), hit: true });
    cursor = to;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
