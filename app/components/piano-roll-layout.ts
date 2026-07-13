import { isNoteEvent } from "#app/midi/note-assembler.ts";

import type { TrackEvent } from "#app/midi/types.ts";

export const KEY_COUNT = 128;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** "C4", "F#2", ... (MIDI 60 = C4) */
export function noteName(key: number): string {
  return `${NOTE_NAMES[key % 12] ?? "?"}${Math.floor(key / 12) - 1}`;
}

const ALL_KEYS_DESCENDING: readonly number[] = Array.from(
  { length: KEY_COUNT },
  (_, i) => KEY_COUNT - 1 - i,
);

export interface KeyLayout {
  /** visible keys, top row first (descending pitch) */
  keys: readonly number[];
  /** key → row index; keys absent from the layout are hidden (folded) */
  rowOf: ReadonlyMap<number, number>;
  folded: boolean;
}

function layoutFor(keys: readonly number[], folded: boolean): KeyLayout {
  const rowOf = new Map<number, number>();

  keys.forEach((key, row) => rowOf.set(key, row));

  return { keys, rowOf, folded };
}

const UNFOLDED_LAYOUT = layoutFor(ALL_KEYS_DESCENDING, false);

/**
 * Ableton-style fold: only rows whose pitch is used by the edited
 * track's notes are shown. An empty track falls back to the full
 * keyboard (there'd be nothing to show — or edit — otherwise).
 */
export function keyLayout(events: readonly TrackEvent[] | undefined, folded: boolean): KeyLayout {
  if (!folded) return UNFOLDED_LAYOUT;

  const used = new Set<number>();

  for (const event of events ?? []) {
    if (isNoteEvent(event)) used.add(event.noteNumber);
  }

  if (used.size === 0) return UNFOLDED_LAYOUT;

  return layoutFor(
    Array.from(used).sort((a, b) => b - a),
    true,
  );
}
