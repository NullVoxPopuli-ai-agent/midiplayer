import type { TrackMute } from "./track-mute.ts";
import type { SendableEvent, SynthOutput } from "./types.ts";

/**
 * Applies mute/solo at send time, per event, keyed by trackId — the
 * scheduler always reads every event (like signal's GroupOutput).
 * Events with trackId -1 (all-sounds-off, state restoration) always
 * pass through.
 */
export class MutingOutput implements SynthOutput {
  constructor(
    private readonly inner: SynthOutput,
    private readonly trackMute: TrackMute,
  ) {}

  activate(): void {
    this.inner.activate();
  }

  sendEvent(event: SendableEvent, delayTimeSeconds: number, trackId = -1): void {
    if (trackId >= 0 && !this.trackMute.shouldPlayTrack(trackId)) {
      return;
    }

    this.inner.sendEvent(event, delayTimeSeconds, trackId);
  }
}
