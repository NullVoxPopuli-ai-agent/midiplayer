import type { NoteEvent, RawTrackEvent, TrackEvent } from "./types.ts";

type TickedNoteOn = RawTrackEvent & { type: "channel"; subtype: "noteOn" };

function isNoteOn(e: RawTrackEvent): e is TickedNoteOn {
  return e.type === "channel" && e.subtype === "noteOn";
}

function isNoteOff(e: RawTrackEvent): e is RawTrackEvent & { type: "channel"; subtype: "noteOff" } {
  return e.type === "channel" && e.subtype === "noteOff";
}

/**
 * Pair noteOn/noteOff events into single "note" events with a duration.
 *
 * Pairing is FIFO per noteNumber; unmatched noteOns and noteOffs are
 * dropped. (midifile-ts already normalizes vel-0 noteOns to noteOffs
 * at parse time.)
 */
export function assembleNotes(events: readonly RawTrackEvent[]): TrackEvent[] {
  const pending: TickedNoteOn[] = [];
  const result: TrackEvent[] = [];

  for (const event of events) {
    if (isNoteOn(event)) {
      pending.push(event);
      continue;
    }

    if (isNoteOff(event)) {
      const index = pending.findIndex((on) => on.noteNumber === event.noteNumber);

      if (index >= 0) {
        const on = pending[index] as TickedNoteOn;

        pending.splice(index, 1);
        result.push({
          type: "channel",
          subtype: "note",
          tick: on.tick,
          noteNumber: on.noteNumber,
          velocity: on.velocity,
          duration: event.tick - on.tick,
        });
      }

      continue;
    }

    result.push(event);
  }

  return result;
}

export function isNoteEvent(e: TrackEvent): e is NoteEvent {
  return e.type === "channel" && e.subtype === "note";
}

/**
 * Split assembled note events back into noteOn/noteOff pairs for playback.
 */
export function deassembleNote(event: NoteEvent, channel: number): RawTrackEvent[] {
  return [
    {
      type: "channel",
      subtype: "noteOn",
      channel,
      tick: event.tick,
      noteNumber: event.noteNumber,
      velocity: event.velocity,
    },
    {
      type: "channel",
      subtype: "noteOff",
      channel,
      tick: event.tick + event.duration,
      noteNumber: event.noteNumber,
      velocity: 0,
    },
  ];
}
