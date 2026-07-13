import { tracked } from "@glimmer/tracking";

import { beatsInRange } from "./measure.ts";

import type { Song } from "./song.ts";
import type { IEventSource, PlayerEvent, SendableEvent } from "./types.ts";

/** signal's sentinel trackId for metronome clicks */
export const METRONOME_TRACK_ID = 99_999;

const CLICK_MEASURE = { noteNumber: 76, velocity: 100 };
const CLICK_BEAT = { noteNumber: 77, velocity: 70 };

/**
 * Wraps a Song as the Player's event source, injecting metronome
 * clicks (one-shot ch-9 noteOns, like signal's EventSource) when
 * enabled.
 */
export class PlayerEventSource implements IEventSource {
  @tracked enableMetronome = false;

  constructor(readonly song: Song) {}

  get timebase(): number {
    return this.song.timebase;
  }

  get endOfSong(): number {
    return this.song.endOfSong;
  }

  getEvents(startTick: number, endTick: number): PlayerEvent[] {
    const events = this.song.getEvents(startTick, endTick);

    if (!this.enableMetronome) {
      return events;
    }

    const clicks = beatsInRange(this.song.measures, this.song.timebase, startTick, endTick).map(
      (beat): PlayerEvent => {
        const click = beat.isMeasureStart ? CLICK_MEASURE : CLICK_BEAT;

        return {
          type: "channel",
          subtype: "noteOn",
          channel: 9,
          tick: beat.tick,
          trackId: METRONOME_TRACK_ID,
          ...click,
        };
      },
    );

    return events.concat(clicks);
  }

  getCurrentStateEvents(tick: number): SendableEvent[] {
    return this.song.getCurrentStateEvents(tick);
  }

  bpmAt(tick: number): number {
    return this.song.bpmAt(tick);
  }
}
