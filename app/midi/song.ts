import { cached, tracked } from "@glimmer/tracking";

import { read, write } from "midifile-ts";

import { measuresFromTimeSignatures } from "./measure.ts";
import { assembleNotes, deassembleNote, isNoteEvent } from "./note-assembler.ts";
import { tickToMillisec } from "./tick.ts";

import type { Measure } from "./measure.ts";
import type {
  IEventSource,
  PlayerEvent,
  RawTrackEvent,
  SendableEvent,
  TickedEvent,
  TrackEvent,
  TrackEventBody,
} from "./types.ts";
import type { AnyEvent, SetTempoEvent, TimeSignatureEvent } from "midifile-ts";

/** extra beats of runway after the last event before playback stops */
const END_MARGIN_BEATS = 4;

function addTick(events: readonly AnyEvent[]): RawTrackEvent[] {
  let tick = 0;

  return events.map((event) => {
    tick += event.deltaTime;

    const rest: RawTrackEvent = { ...event, tick };

    delete (rest as Partial<AnyEvent>).deltaTime;

    return rest;
  });
}

function isChannelEvent(e: TrackEventBody): e is TrackEventBody & { channel: number } {
  return e.type === "channel";
}

function isSetTempo(e: TrackEventBody): e is TickedEvent<SetTempoEvent> {
  return e.type === "meta" && e.subtype === "setTempo";
}

function isTimeSignature(e: TrackEventBody): e is TickedEvent<TimeSignatureEvent> {
  return e.type === "meta" && e.subtype === "timeSignature";
}

function byTick(a: { tick: number }, b: { tick: number }): number {
  return a.tick - b.tick;
}

/**
 * A track with editable, tick-sorted events. Every stored event gets a
 * per-track unique id so the editor (selection, undo, updates) can
 * refer to it.
 */
export class Track {
  @tracked private _events: TrackEvent[];

  private nextEventId = 0;

  constructor(
    readonly id: number,
    /** undefined ⇒ conductor track */
    readonly channel: number | undefined,
    events: readonly TrackEventBody[] = [],
  ) {
    this._events = events.map((event) => ({ ...event, id: this.nextEventId++ }));
    this._events.sort(byTick);
  }

  get events(): readonly TrackEvent[] {
    return this._events;
  }

  // -- mutation ------------------------------------------------------

  addEvent(body: TrackEventBody): TrackEvent {
    const event: TrackEvent = { ...body, id: this.nextEventId++ };

    this._events = this._events.concat(event).sort(byTick);

    return event;
  }

  addEvents(bodies: readonly TrackEventBody[]): TrackEvent[] {
    const events = bodies.map((body) => ({ ...body, id: this.nextEventId++ }));

    this._events = this._events.concat(events).sort(byTick);

    return events;
  }

  removeEvents(ids: Iterable<number>): void {
    const gone = new Set(ids);

    this._events = this._events.filter((event) => !gone.has(event.id));
  }

  /** patch an event by id; returns the updated event (re-sorts on tick change) */
  updateEvent(id: number, patch: Partial<TrackEventBody>): TrackEvent | undefined {
    const index = this._events.findIndex((event) => event.id === id);

    if (index < 0) return undefined;

    const updated = { ...this._events[index], ...patch } as TrackEvent;
    const next = this._events.slice();

    next[index] = updated;
    next.sort(byTick);
    this._events = next;

    return updated;
  }

  setName(text: string): void {
    const existing = this._events.find(
      (event) => event.type === "meta" && event.subtype === "trackName",
    );

    if (existing) {
      this.updateEvent(existing.id, { text });
    } else {
      this.addEvent({ type: "meta", subtype: "trackName", text, tick: 0 });
    }
  }

  // -- derived -------------------------------------------------------

  get isConductor(): boolean {
    return this.channel === undefined;
  }

  get isRhythmTrack(): boolean {
    return this.channel === 9;
  }

  get name(): string | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];

      if (event?.type === "meta" && event.subtype === "trackName") {
        return event.text;
      }
    }

    return undefined;
  }

  get programNumber(): number | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];

      if (event?.type === "channel" && event.subtype === "programChange") {
        return event.value;
      }
    }

    return undefined;
  }

  get noteCount(): number {
    return this._events.filter(isNoteEvent).length;
  }

  get endOfTrack(): number {
    let end = 0;

    for (const event of this._events) {
      end = Math.max(end, isNoteEvent(event) ? event.tick + event.duration : event.tick);
    }

    return end;
  }

  /** the last controller value ≤ tick for a controllerType (e.g. volume/pan) */
  controllerValueAt(controllerType: number, tick: number): number | undefined {
    let value: number | undefined;

    for (const event of this._events) {
      if (event.tick > tick) break;

      if (
        event.type === "channel" &&
        event.subtype === "controller" &&
        event.controllerType === controllerType
      ) {
        value = event.value;
      }
    }

    return value;
  }

  /**
   * The synth state (program, controllers, pitch bend) that should be
   * in effect at `tick` — used to restore state after a seek.
   */
  getStatusEvents(tick: number): SendableEvent[] {
    if (this.channel === undefined) return [];

    const controllers = new Map<number, SendableEvent>();
    let programChange: SendableEvent | undefined;
    let pitchBend: SendableEvent | undefined;

    for (const event of this._events) {
      if (event.tick > tick) break;
      if (event.type !== "channel") continue;

      switch (event.subtype) {
        case "controller":
          controllers.set(event.controllerType, { ...event, channel: this.channel });

          break;
        case "programChange":
          programChange = { ...event, channel: this.channel };

          break;
        case "pitchBend":
          pitchBend = { ...event, channel: this.channel };

          break;
        default:
          break;
      }
    }

    const result = Array.from(controllers.values());

    if (programChange) result.push(programChange);
    if (pitchBend) result.push(pitchBend);

    return result;
  }
}

interface TempoKeyframe {
  tick: number;
  bpm: number;
  timeMs: number;
}

export class Song implements IEventSource {
  @tracked name: string;
  @tracked private _tracks: Track[];

  private nextTrackId: number;

  constructor(
    name: string,
    readonly timebase: number,
    tracks: readonly Track[],
  ) {
    this.name = name;
    this._tracks = tracks.slice();
    this.nextTrackId = Math.max(0, ...tracks.map((track) => track.id + 1));
  }

  get tracks(): readonly Track[] {
    return this._tracks;
  }

  // -- track management ---------------------------------------------

  createTrack(channel: number, bodies: readonly TrackEventBody[] = []): Track {
    const track = new Track(this.nextTrackId++, channel, bodies);

    this._tracks = this._tracks.concat(track);

    return track;
  }

  removeTrack(id: number): void {
    const track = this._tracks.find((candidate) => candidate.id === id);

    if (!track || track.isConductor) return;

    this._tracks = this._tracks.filter((candidate) => candidate.id !== id);
  }

  // -- derived -------------------------------------------------------

  get conductorTrack(): Track | undefined {
    return this._tracks.find((track) => track.isConductor);
  }

  get playableTracks(): Track[] {
    return this._tracks.filter((track) => !track.isConductor);
  }

  get lastEventTick(): number {
    return Math.max(0, ...this._tracks.map((track) => track.endOfTrack));
  }

  get endOfSong(): number {
    return this.lastEventTick + this.timebase * END_MARGIN_BEATS;
  }

  @cached
  get timeSignatures(): (TickedEvent<TimeSignatureEvent> & { id: number })[] {
    return (this.conductorTrack?.events ?? [])
      .filter((e): e is TickedEvent<TimeSignatureEvent> & { id: number } => isTimeSignature(e))
      .sort(byTick);
  }

  @cached
  get measures(): Measure[] {
    return measuresFromTimeSignatures(this.timeSignatures, this.timebase);
  }

  @cached
  private get tempoKeyframes(): TempoKeyframe[] {
    const keyframes: TempoKeyframe[] = [{ tick: 0, bpm: 120, timeMs: 0 }];
    let last = keyframes[0] as TempoKeyframe;

    for (const event of this.conductorTrack?.events ?? []) {
      if (!isSetTempo(event)) continue;

      const timeMs = last.timeMs + tickToMillisec(event.tick - last.tick, last.bpm, this.timebase);

      last = { tick: event.tick, bpm: 60_000_000 / event.microsecondsPerBeat, timeMs };
      keyframes.push(last);
    }

    return keyframes;
  }

  /**
   * Wall-clock seconds at `tick`, walking the tempo map (the keyframe
   * algorithm from signal's toSynthEvents).
   */
  secondsAt(tick: number): number {
    let keyframe = this.tempoKeyframes[0] as TempoKeyframe;

    for (const candidate of this.tempoKeyframes) {
      if (candidate.tick > tick) break;
      keyframe = candidate;
    }

    return (
      (keyframe.timeMs + tickToMillisec(tick - keyframe.tick, keyframe.bpm, this.timebase)) / 1000
    );
  }

  /** bpm in effect at `tick` (from the conductor track's setTempo events) */
  bpmAt(tick: number): number {
    let microsecondsPerBeat = 500_000;

    for (const event of this.conductorTrack?.events ?? []) {
      if (event.tick > tick) break;
      if (isSetTempo(event)) microsecondsPerBeat = event.microsecondsPerBeat;
    }

    return 60_000_000 / microsecondsPerBeat;
  }

  /**
   * Every track's events flattened for playback: notes split back into
   * noteOn/noteOff, tagged with channel + trackId, sorted by tick.
   * Auto-invalidates when any track's events change.
   */
  @cached
  get allEvents(): PlayerEvent[] {
    return this._tracks
      .flatMap((track) =>
        track.events.flatMap((event): PlayerEvent[] => {
          if (isNoteEvent(event)) {
            return deassembleNote(event, track.channel ?? 0).map((raw) => ({
              ...raw,
              trackId: track.id,
            }));
          }

          const raw =
            isChannelEvent(event) && track.channel !== undefined
              ? { ...event, channel: track.channel }
              : event;

          return [{ ...raw, trackId: track.id }];
        }),
      )
      .sort(byTick);
  }

  getEvents(startTick: number, endTick: number): PlayerEvent[] {
    return this.allEvents.filter((e) => e.tick >= startTick && e.tick < endTick);
  }

  getCurrentStateEvents(tick: number): SendableEvent[] {
    return this._tracks.flatMap((track) => track.getStatusEvents(tick));
  }
}

function hasChannelEvents(events: readonly RawTrackEvent[]): boolean {
  return events.some((e) => e.type === "channel");
}

function channelOf(events: readonly RawTrackEvent[]): number | undefined {
  for (const event of events) {
    if (event.type === "channel") return event.channel;
  }

  return undefined;
}

function isConductorContent(e: RawTrackEvent): boolean {
  return e.type === "meta" && (e.subtype === "setTempo" || e.subtype === "timeSignature");
}

function dropEndOfTrack(events: RawTrackEvent[]): RawTrackEvent[] {
  return events.filter((e) => !(e.type === "meta" && e.subtype === "endOfTrack"));
}

/**
 * Parse a Standard MIDI File into a Song.
 * (ported from signal's midiConversion.ts)
 */
export function songFromMidi(data: ArrayBuffer | Uint8Array): Song {
  const midi = read(data);
  const timebase = midi.header.ticksPerBeat;
  const rawTracks = midi.tracks.map((events) => dropEndOfTrack(addTick(events)));

  let tickedTracks: { channel: number | undefined; events: RawTrackEvent[] }[];

  switch (midi.header.formatType) {
    case 0: {
      // single track: split by channel, channel-less events become the conductor
      const source = rawTracks[0] ?? [];
      const conductor = source.filter((e) => e.type !== "channel");
      const byChannel = new Map<number, RawTrackEvent[]>();

      for (const event of source) {
        if (event.type !== "channel") continue;

        const events = byChannel.get(event.channel) ?? [];

        events.push(event);
        byChannel.set(event.channel, events);
      }

      tickedTracks = [{ channel: undefined, events: conductor }];

      for (const [channel, events] of Array.from(byChannel.entries()).sort(([a], [b]) => a - b)) {
        tickedTracks.push({ channel, events });
      }

      break;
    }

    case 1: {
      // conductor track = a track with no channel events; move all
      // setTempo/timeSignature events from normal tracks into it
      const conductorEvents: RawTrackEvent[] = [];
      const normal: RawTrackEvent[][] = [];

      for (const events of rawTracks) {
        if (hasChannelEvents(events)) {
          conductorEvents.push(...events.filter(isConductorContent));
          normal.push(events.filter((e) => !isConductorContent(e)));
        } else {
          conductorEvents.push(...events);
        }
      }

      conductorEvents.sort(byTick);

      tickedTracks = [{ channel: undefined, events: conductorEvents }];

      for (const events of normal) {
        tickedTracks.push({ channel: channelOf(events), events });
      }

      break;
    }

    default:
      throw new Error(`Unsupported MIDI format: ${midi.header.formatType}`);
  }

  const tracks = tickedTracks.map(
    ({ channel, events }, index) => new Track(index, channel, assembleNotes(events)),
  );

  const name = tracks[0]?.name ?? "";

  return new Song(name, timebase, tracks);
}

/**
 * Serialize a Song back to a Standard MIDI File (format 1) — used for
 * export, undo snapshots, and autosave.
 */
export function songToMidi(song: Song): Uint8Array {
  const tracks = song.tracks.map((track) => {
    const absolute: RawTrackEvent[] = track.events
      .flatMap((event): RawTrackEvent[] => {
        if (isNoteEvent(event)) {
          return deassembleNote(event, track.channel ?? 0);
        }

        const body = { ...event } as RawTrackEvent & { id?: number };

        delete body.id;

        return [
          isChannelEvent(body) && track.channel !== undefined
            ? { ...body, channel: track.channel }
            : body,
        ];
      })
      .sort(byTick);

    const result: AnyEvent[] = [];
    let previous = 0;

    for (const { tick, ...body } of absolute) {
      result.push({ ...body, deltaTime: tick - previous });
      previous = tick;
    }

    result.push({ type: "meta", subtype: "endOfTrack", deltaTime: 0 });

    return result;
  });

  return write(tracks, song.timebase);
}

/**
 * An empty song, matching signal's factory defaults: a conductor track
 * (4/4, 120bpm) plus one channel-0 track preloaded with reset
 * controllers.
 */
export function emptySong(): Song {
  const conductor = new Track(0, undefined, [
    { type: "meta", subtype: "trackName", text: "", tick: 0 },
    {
      type: "meta",
      subtype: "timeSignature",
      numerator: 4,
      denominator: 4,
      metronome: 24,
      thirtyseconds: 8,
      tick: 0,
    },
    { type: "meta", subtype: "setTempo", microsecondsPerBeat: 500_000, tick: 0 },
  ]);

  const channel = 0;
  const cc = (controllerType: number, value: number): TrackEventBody => ({
    type: "channel",
    subtype: "controller",
    channel,
    controllerType,
    value,
    tick: 0,
  });

  const track = new Track(1, channel, [
    { type: "meta", subtype: "trackName", text: "Track 1", tick: 0 },
    cc(7, 100), // volume
    cc(10, 64), // pan
    cc(11, 127), // expression
    { type: "channel", subtype: "programChange", channel, value: 0, tick: 0 },
  ]);

  return new Song("", 480, [conductor, track]);
}
