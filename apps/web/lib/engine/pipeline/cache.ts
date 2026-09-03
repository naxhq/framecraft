/**
 * The one-generation stage cache.
 *
 * One entry per stage id: the latest output, keyed by the stage's input key
 * (`hash.ts`). When a stage re-runs, the previous entry's WASM handles are
 * deleted before the new one is stored, so memory is bounded by construction:
 * never more than one generation of any stage (design ruling 4).
 *
 * Validity is two checks, not one. The key covers the parameters and the
 * upstream keys; the generation check covers the case the key cannot: an
 * upstream stage re-ran (its old handles are gone) but this stage did not,
 * because the job was cancelled in between. If the parameters are then reverted
 * the keys match again while this entry still points at freed handles, so an
 * entry is only valid when every input entry is the exact generation it was
 * computed from.
 */

import { Arena, type Deletable } from "../solid/manifold";
import type { AuditFinding, ResolvedLine } from "../types";
import type { StageId } from "./stage";

let generationCounter = 0;

/** The per-stage output channels the old `BuildContext` accumulated globally. */
export interface StageChannels {
  findings: AuditFinding[];
  resolvedText: ResolvedLine[];
  markBands: Array<[number, number]>;
}

export interface CacheEntry<Out = unknown> {
  readonly id: StageId;
  readonly key: string;
  /**
   * What downstream keys hash in place of this entry's key: a content hash of
   * the output when it is plain data (numbers, findings, a token table), else
   * the key itself. A data stage that re-runs to the same answer (the `sit`
   * offset after a base change, the context numbers after a change to a
   * disabled shadow gap's width) therefore leaves everything under it cached.
   */
  readonly digest: string;
  /** Named digests of parts of the output (`StageDef.digests`), resolved; a null answer resolved to `digest`. */
  readonly partDigests: ReadonlyMap<string, string>;
  readonly gen: number;
  /**
   * The generation of every input whose handles this output REFERENCES. Only
   * those can dangle when the input is replaced; an input read for its numbers
   * or for a part digest is covered by the key alone.
   */
  readonly inputGens: ReadonlyMap<StageId, number>;
  readonly output: Out;
  readonly channels: StageChannels;
  /** The WASM handles this output owns; deleted when the entry is replaced. */
  readonly arena: Arena;
  /** Wall time of the run that produced it, ms. Read by ETA estimates. */
  readonly elapsedMs: number;
}

export class StageCache {
  private readonly entries = new Map<StageId, CacheEntry>();

  get<Out = unknown>(id: StageId): CacheEntry<Out> | undefined {
    return this.entries.get(id) as CacheEntry<Out> | undefined;
  }

  has(id: StageId): boolean {
    return this.entries.has(id);
  }

  /**
   * True when the stored entry can be served for `key`: same key, and every
   * input entry is still the generation this entry was computed from.
   */
  isValid(id: StageId, key: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.key !== key) return false;
    for (const [input, gen] of entry.inputGens) {
      const upstream = this.entries.get(input);
      if (upstream === undefined || upstream.gen !== gen) return false;
    }
    return true;
  }

  /** Store a fresh output, deleting the previous generation's handles first. */
  set<Out>(
    id: StageId,
    key: string,
    inputGens: ReadonlyMap<StageId, number>,
    output: Out,
    channels: StageChannels,
    owned: readonly Deletable[],
    elapsedMs: number,
    digest: string = key,
    partDigests: ReadonlyMap<string, string> = new Map(),
  ): CacheEntry<Out> {
    this.drop(id);
    generationCounter += 1;
    const arena = new Arena();
    for (const handle of owned) arena.keep(handle);
    const entry: CacheEntry<Out> = {
      id,
      key,
      digest,
      partDigests,
      gen: generationCounter,
      inputGens,
      output,
      channels,
      arena,
      elapsedMs,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** Delete one stage's entry and its handles. */
  drop(id: StageId): void {
    const previous = this.entries.get(id);
    if (previous === undefined) return;
    this.entries.delete(id);
    previous.arena.dispose();
  }

  /** Every entry, for diagnostics and the memory test. */
  get size(): number {
    return this.entries.size;
  }

  /** The entry, if any, that owns `handle`. */
  ownerOf(handle: Deletable): CacheEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.arena.has(handle)) return entry;
    }
    return undefined;
  }

  /** How many WASM handles the cache is holding across every entry. */
  handleCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.arena.size;
    return total;
  }

  /** Delete everything. Idempotent. */
  dispose(): void {
    for (const entry of this.entries.values()) entry.arena.dispose();
    this.entries.clear();
  }
}
