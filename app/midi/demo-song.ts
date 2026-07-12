import { write } from "midifile-ts";

import { songFromMidi } from "./song.ts";

import type { Song } from "./song.ts";
import type { DistributiveOmit } from "./types.ts";
import type { AnyEvent } from "midifile-ts";

const TIMEBASE = 480;
const BAR = TIMEBASE * 4;

interface AbsoluteEvent {
  tick: number;
  event: DistributiveOmit<AnyEvent, "deltaTime">;
}

function toDeltaTrack(events: AbsoluteEvent[], endTick: number): AnyEvent[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const result: AnyEvent[] = [];
  let previous = 0;

  for (const { tick, event } of sorted) {
    result.push({ ...event, deltaTime: tick - previous });
    previous = tick;
  }

  result.push({
    type: "meta",
    subtype: "endOfTrack",
    deltaTime: Math.max(0, endTick - previous),
  });

  return result;
}

function note(
  out: AbsoluteEvent[],
  channel: number,
  tick: number,
  noteNumber: number,
  duration: number,
  velocity = 100,
): void {
  out.push({
    tick,
    event: { type: "channel", subtype: "noteOn", channel, noteNumber, velocity },
  });
  out.push({
    tick: tick + duration,
    event: { type: "channel", subtype: "noteOff", channel, noteNumber, velocity: 0 },
  });
}

/**
 * Generate a small 8-bar demo song (C – Am – F – G, two bars each) as a
 * real Standard MIDI File and parse it back — exercising the same code
 * path as loading a .mid from disk.
 */
export function createDemoSong(): Song {
  // chord tones as [melody triad, bass root]
  const progression: [number[], number][] = [
    [[60, 64, 67], 36], // C
    [[57, 60, 64], 45], // Am
    [[53, 57, 60], 41], // F
    [[55, 59, 62], 43], // G
  ];

  const conductor: AbsoluteEvent[] = [
    { tick: 0, event: { type: "meta", subtype: "trackName", text: "Demo Song" } },
    {
      tick: 0,
      event: { type: "meta", subtype: "setTempo", microsecondsPerBeat: 500_000 },
    },
    {
      tick: 0,
      event: {
        type: "meta",
        subtype: "timeSignature",
        numerator: 4,
        denominator: 4,
        metronome: 24,
        thirtyseconds: 8,
      },
    },
  ];

  const melody: AbsoluteEvent[] = [
    { tick: 0, event: { type: "meta", subtype: "trackName", text: "Piano" } },
    { tick: 0, event: { type: "channel", subtype: "programChange", channel: 0, value: 0 } },
  ];
  const bass: AbsoluteEvent[] = [
    { tick: 0, event: { type: "meta", subtype: "trackName", text: "Bass" } },
    { tick: 0, event: { type: "channel", subtype: "programChange", channel: 1, value: 33 } },
  ];
  const drums: AbsoluteEvent[] = [
    { tick: 0, event: { type: "meta", subtype: "trackName", text: "Drums" } },
  ];

  const eighth = TIMEBASE / 2;

  progression.forEach(([triad, root], chordIndex) => {
    const chordStart = chordIndex * 2 * BAR;

    for (let bar = 0; bar < 2; bar++) {
      const barStart = chordStart + bar * BAR;

      // melody: eighth-note arpeggio up and back down
      const pattern = [0, 1, 2, 1, 0, 1, 2, 1];

      pattern.forEach((degree, i) => {
        const octave = i >= 4 ? 12 : 0;

        note(melody, 0, barStart + i * eighth, (triad[degree] ?? 60) + octave, eighth - 20, 90);
      });

      // bass: root half notes
      note(bass, 1, barStart, root, TIMEBASE * 2 - 20, 100);
      note(bass, 1, barStart + TIMEBASE * 2, root, TIMEBASE * 2 - 20, 85);

      // drums (channel 9): kick 1 & 3, snare 2 & 4, closed hat eighths
      note(drums, 9, barStart, 36, eighth, 110);
      note(drums, 9, barStart + TIMEBASE * 2, 36, eighth, 100);
      note(drums, 9, barStart + TIMEBASE, 38, eighth, 95);
      note(drums, 9, barStart + TIMEBASE * 3, 38, eighth, 95);

      for (let i = 0; i < 8; i++) {
        note(drums, 9, barStart + i * eighth, 42, eighth / 2, i % 2 === 0 ? 70 : 50);
      }
    }
  });

  const endTick = 8 * BAR;
  const file = write(
    [conductor, melody, bass, drums].map((events) => toDeltaTrack(events, endTick)),
    TIMEBASE,
  );

  return songFromMidi(file);
}
