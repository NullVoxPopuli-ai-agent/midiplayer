import type { AnyChannelEvent, AnyEvent, AnySysExEvent } from "midifile-ts";

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A midifile-ts event whose relative deltaTime has been resolved
 * to an absolute tick position within its track.
 */
export type TickedEvent<T> = DistributiveOmit<T, "deltaTime"> & { tick: number };

export type RawTrackEvent = TickedEvent<AnyEvent>;

/**
 * A noteOn/noteOff pair, assembled into a single event.
 * (ported from signal's noteAssembler)
 */
export interface NoteEvent {
  type: "channel";
  subtype: "note";
  tick: number;
  noteNumber: number;
  velocity: number;
  duration: number;
}

/** an event as constructed, before a Track assigns it an id */
export type TrackEventBody = NoteEvent | RawTrackEvent;

/** an event stored in a Track: body + per-track unique id (for editing) */
export type TrackEvent = TrackEventBody & { id: number };

/**
 * An event as flattened for playback: absolute tick + owning track.
 */
export type PlayerEvent = RawTrackEvent & { trackId: number };

/**
 * Events a synth can consume (channel + sysex; meta events are
 * interpreted by the Player itself).
 */
export type SendableEvent = DistributiveOmit<AnyChannelEvent | AnySysExEvent, "deltaTime">;

export interface SynthOutput {
  /** resume the underlying AudioContext (must happen in a user gesture) */
  activate(): void;
  /** delayTime is in seconds, relative to "now" */
  sendEvent(event: SendableEvent, delayTimeSeconds: number, trackId?: number): void;
}

export interface IEventSource {
  timebase: number;
  endOfSong: number;
  getEvents(startTick: number, endTick: number): PlayerEvent[];
  getCurrentStateEvents(tick: number): SendableEvent[];
}
