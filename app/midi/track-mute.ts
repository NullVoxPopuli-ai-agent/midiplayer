import { tracked } from "@glimmer/tracking";

/**
 * Mute/solo state, applied per event at send time (like signal's
 * TrackMute + GroupOutput): when any track is soloed, only soloed
 * tracks play; otherwise every non-muted track plays.
 */
export class TrackMute {
  @tracked private mutes: ReadonlySet<number> = new Set();
  @tracked private solos: ReadonlySet<number> = new Set();

  // arrow properties: these get invoked as template helpers, receiver-less
  isMuted = (trackId: number): boolean => {
    return this.mutes.has(trackId);
  };

  isSolo = (trackId: number): boolean => {
    return this.solos.has(trackId);
  };

  toggleMute = (trackId: number): void => {
    const next = new Set(this.mutes);

    if (!next.delete(trackId)) next.add(trackId);

    this.mutes = next;
  };

  toggleSolo = (trackId: number): void => {
    const next = new Set(this.solos);

    if (!next.delete(trackId)) next.add(trackId);

    this.solos = next;
  };

  reset = (): void => {
    this.mutes = new Set();
    this.solos = new Set();
  };

  shouldPlayTrack = (trackId: number): boolean => {
    if (this.solos.size > 0) {
      return this.solos.has(trackId);
    }

    return !this.mutes.has(trackId);
  };
}
