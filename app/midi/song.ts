import { read } from "midifile-ts";

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

function isChannelEvent(e: TrackEvent): e is TrackEvent & { channel: number } {
  return e.type === "channel";
}

function isSetTempo(e: TrackEvent): e is TickedEvent<SetTempoEvent> {
  return e.type === "meta" && e.subtype === "setTempo";
}

function isTimeSignature(e: TrackEvent): e is TickedEvent<TimeSignatureEvent> {
  return e.type === "meta" && e.subtype === "timeSignature";
}

export class Track {
  constructor(
    readonly id: number,
    /** undefined ⇒ conductor track */
    readonly channel: number | undefined,
    readonly events: readonly TrackEvent[],
  ) {}

  get isConductor(): boolean {
    return this.channel === undefined;
  }

  get isRhythmTrack(): boolean {
    return this.channel === 9;
  }

  get name(): string | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];

      if (event?.type === "meta" && event.subtype === "trackName") {
        return event.text;
      }
    }

    return undefined;
  }

  get programNumber(): number | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];

      if (event?.type === "channel" && event.subtype === "programChange") {
        return event.value;
      }
    }

    return undefined;
  }

  get noteCount(): number {
    return this.events.filter(isNoteEvent).length;
  }

  get endOfTrack(): number {
    let end = 0;

    for (const event of this.events) {
      end = Math.max(end, isNoteEvent(event) ? event.tick + event.duration : event.tick);
    }

    return end;
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

    for (const event of this.events) {
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

    return [
      ...controllers.values(),
      ...(programChange ? [programChange] : []),
      ...(pitchBend ? [pitchBend] : []),
    ];
  }
}

interface TempoKeyframe {
  tick: number;
  bpm: number;
  timeMs: number;
}

export class Song implements IEventSource {
  #allEvents: PlayerEvent[] | undefined;
  #measures: Measure[] | undefined;
  #tempoKeyframes: TempoKeyframe[] | undefined;

  constructor(
    readonly name: string,
    readonly timebase: number,
    readonly tracks: readonly Track[],
  ) {}

  get conductorTrack(): Track | undefined {
    return this.tracks.find((track) => track.isConductor);
  }

  get playableTracks(): Track[] {
    return this.tracks.filter((track) => !track.isConductor);
  }

  get lastEventTick(): number {
    return Math.max(0, ...this.tracks.map((track) => track.endOfTrack));
  }

  get endOfSong(): number {
    return this.lastEventTick + this.timebase * END_MARGIN_BEATS;
  }

  get timeSignatures(): TickedEvent<TimeSignatureEvent>[] {
    return (this.conductorTrack?.events ?? [])
      .filter(isTimeSignature)
      .sort((a, b) => a.tick - b.tick);
  }

  get measures(): Measure[] {
    this.#measures ??= measuresFromTimeSignatures(this.timeSignatures, this.timebase);

    return this.#measures;
  }

  /**
   * Wall-clock seconds at `tick`, walking the tempo map (the keyframe
   * algorithm from signal's toSynthEvents).
   */
  secondsAt(tick: number): number {
    this.#tempoKeyframes ??= (() => {
      const keyframes: TempoKeyframe[] = [{ tick: 0, bpm: 120, timeMs: 0 }];
      let last = keyframes[0] as TempoKeyframe;

      for (const event of this.conductorTrack?.events ?? []) {
        if (!isSetTempo(event)) continue;

        const timeMs =
          last.timeMs + tickToMillisec(event.tick - last.tick, last.bpm, this.timebase);

        last = { tick: event.tick, bpm: 60_000_000 / event.microsecondsPerBeat, timeMs };
        keyframes.push(last);
      }

      return keyframes;
    })();

    let keyframe = this.#tempoKeyframes[0] as TempoKeyframe;

    for (const candidate of this.#tempoKeyframes) {
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
   */
  get allEvents(): PlayerEvent[] {
    this.#allEvents ??= this.tracks
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
      .sort((a, b) => a.tick - b.tick);

    return this.#allEvents;
  }

  getEvents(startTick: number, endTick: number): PlayerEvent[] {
    return this.allEvents.filter((e) => e.tick >= startTick && e.tick < endTick);
  }

  getCurrentStateEvents(tick: number): SendableEvent[] {
    return this.tracks.flatMap((track) => track.getStatusEvents(tick));
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

function byTick(a: { tick: number }, b: { tick: number }): number {
  return a.tick - b.tick;
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

      tickedTracks = [
        { channel: undefined, events: conductor },
        ...[...byChannel.entries()]
          .sort(([a], [b]) => a - b)
          .map(([channel, events]) => ({ channel, events })),
      ];

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

      tickedTracks = [
        { channel: undefined, events: conductorEvents },
        ...normal.map((events) => ({ channel: channelOf(events), events })),
      ];

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
