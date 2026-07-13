import { METRONOME_TRACK_ID } from "./event-source.ts";

import type { TrackMute } from "./track-mute.ts";
import type { SendableEvent, SynthOutput } from "./types.ts";

/**
 * Routes events to the active outputs, applying mute/solo at send time
 * per event, keyed by trackId (signal's GroupOutput):
 *
 * - metronome clicks go only to the metronome synth (when set)
 * - events with trackId -1 (all-sounds-off, state restoration) always
 *   pass through
 * - everything else is dropped for muted tracks, otherwise fanned out
 */
export class GroupOutput implements SynthOutput {
  /** the selected main output(s): built-in synth and/or a Web MIDI port */
  outputs: SynthOutput[] = [];
  metronomeOutput: SynthOutput | null = null;

  constructor(private readonly trackMute: TrackMute) {}

  activate(): void {
    for (const output of this.outputs) output.activate();
    this.metronomeOutput?.activate();
  }

  sendEvent(event: SendableEvent, delayTimeSeconds: number, trackId = -1): void {
    if (trackId === METRONOME_TRACK_ID) {
      this.metronomeOutput?.sendEvent(event, delayTimeSeconds, trackId);

      return;
    }

    if (trackId >= 0 && !this.trackMute.shouldPlayTrack(trackId)) {
      return;
    }

    for (const output of this.outputs) {
      output.sendEvent(event, delayTimeSeconds, trackId);
    }
  }
}
