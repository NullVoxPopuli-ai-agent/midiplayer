import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";

import { isNoteEvent } from "#app/midi/note-assembler.ts";

import type { Track } from "#app/midi/song.ts";
import type { NoteEvent, TrackEvent } from "#app/midi/types.ts";
import type HistoryService from "#services/history.ts";
import type PlayerService from "#services/player.ts";

export type PianoRollTool = "pencil" | "selection";

interface ClipboardNote {
  relativeTick: number;
  noteNumber: number;
  velocity: number;
  duration: number;
}

/**
 * Editing state + note operations on the selected track (signal's
 * PianoRollStore / selection actions, condensed).
 */
export default class EditorService extends Service {
  @service declare player: PlayerService;
  @service declare history: HistoryService;

  @tracked tool: PianoRollTool = "pencil";
  /** snap denominator: 4 = quarter note, 8 = eighth, ... */
  @tracked quantize = 8;
  @tracked private _selectedTrackId: number | null = null;
  @tracked selection: ReadonlySet<number> = new Set();

  private clipboard: ClipboardNote[] = [];

  get selectedTrack(): Track | null {
    const tracks = this.player.song?.playableTracks ?? [];

    return tracks.find((track) => track.id === this._selectedTrackId) ?? tracks[0] ?? null;
  }

  selectTrack(id: number): void {
    this._selectedTrackId = id;
    this.clearSelection();
  }

  get snapTicks(): number {
    const timebase = this.player.song?.timebase ?? 480;

    return (timebase * 4) / this.quantize;
  }

  snap(tick: number): number {
    return Math.max(0, Math.round(tick / this.snapTicks) * this.snapTicks);
  }

  snapFloor(tick: number): number {
    return Math.max(0, Math.floor(tick / this.snapTicks) * this.snapTicks);
  }

  // -- selection -----------------------------------------------------

  setSelection(ids: Iterable<number>): void {
    this.selection = new Set(ids);
  }

  clearSelection(): void {
    if (this.selection.size > 0) this.selection = new Set();
  }

  selectAll(): void {
    const track = this.selectedTrack;

    if (!track) return;

    this.selection = new Set(track.events.filter(isNoteEvent).map((event) => event.id));
  }

  get selectedNotes(): (NoteEvent & { id: number })[] {
    const track = this.selectedTrack;

    if (!track) return [];

    return track.events.filter(
      (event): event is NoteEvent & { id: number } =>
        isNoteEvent(event) && this.selection.has(event.id),
    );
  }

  // -- note operations (history.push() happens at gesture start) -----

  createNote(tick: number, noteNumber: number): number | null {
    const track = this.selectedTrack;

    if (!track || noteNumber < 0 || noteNumber > 127) return null;

    this.history.push();

    const event = track.addEvent({
      type: "channel",
      subtype: "note",
      tick: this.snapFloor(tick),
      noteNumber,
      velocity: 100,
      duration: this.snapTicks,
    });

    this.selection = new Set([event.id]);
    this.previewNote(noteNumber);

    return event.id;
  }

  /** live-move during a drag (no history push — the gesture pushed once) */
  moveNotes(
    origin: readonly (NoteEvent & { id: number })[],
    deltaTick: number,
    deltaKey: number,
  ): void {
    const track = this.selectedTrack;

    if (!track) return;

    for (const note of origin) {
      track.updateEvent(note.id, {
        tick: Math.max(0, this.snap(note.tick + deltaTick)),
        noteNumber: Math.min(127, Math.max(0, note.noteNumber + deltaKey)),
      });
    }
  }

  resizeNote(origin: NoteEvent & { id: number }, deltaTick: number): void {
    const track = this.selectedTrack;

    if (!track) return;

    const snapped = this.snap(origin.tick + origin.duration + deltaTick) - origin.tick;

    track.updateEvent(origin.id, {
      duration: Math.max(this.snapTicks / 4, snapped),
    });
  }

  setVelocity(id: number, velocity: number): void {
    this.selectedTrack?.updateEvent(id, {
      velocity: Math.min(127, Math.max(1, Math.round(velocity))),
    });
  }

  deleteNote(id: number): void {
    const track = this.selectedTrack;

    if (!track) return;

    this.history.push();
    track.removeEvents([id]);
    this.selection = new Set(Array.from(this.selection).filter((selected) => selected !== id));
  }

  deleteSelection(): void {
    const track = this.selectedTrack;

    if (!track || this.selection.size === 0) return;

    this.history.push();
    track.removeEvents(this.selection);
    this.clearSelection();
  }

  // -- clipboard -----------------------------------------------------

  copySelection(): void {
    const notes = this.selectedNotes;

    if (notes.length === 0) return;

    const base = Math.min(...notes.map((note) => note.tick));

    this.clipboard = notes.map((note) => ({
      relativeTick: note.tick - base,
      noteNumber: note.noteNumber,
      velocity: note.velocity,
      duration: note.duration,
    }));
  }

  cutSelection(): void {
    this.copySelection();
    this.deleteSelection();
  }

  /** paste at the playhead into the selected track */
  paste(): void {
    const track = this.selectedTrack;
    const position = this.player.player?.position ?? 0;

    if (!track || this.clipboard.length === 0) return;

    this.history.push();

    const added = track.addEvents(
      this.clipboard.map((note) => ({
        type: "channel",
        subtype: "note",
        tick: position + note.relativeTick,
        noteNumber: note.noteNumber,
        velocity: note.velocity,
        duration: note.duration,
      })),
    );

    this.selection = new Set(added.map((event) => event.id));
  }

  /** audition a note when drawing (short synth blip) */
  previewNote(noteNumber: number): void {
    const track = this.selectedTrack;

    if (!track || track.channel === undefined) return;

    this.player.previewNote(track.channel, noteNumber);
  }

  // -- MIDI input recording ---------------------------------------------

  @tracked isRecording = false;
  @tracked recordingStatus: string | null = null;

  private recordingStops: (() => void)[] = [];
  private liveNotes = new Map<string, { velocity: number; startTick: number }>();

  /**
   * Arm recording: incoming Web MIDI events are echoed to the output
   * and written onto the selected track at the playhead (signal's
   * MIDIRecorder, reduced).
   */
  async toggleRecording(): Promise<void> {
    if (this.isRecording) {
      this.stopRecording();

      return;
    }

    this.recordingStatus = "Waiting for MIDI access…";
    await this.player.refreshMidiOutputs();

    const inputs = this.player.midiInputs;

    if (inputs.length === 0) {
      this.recordingStatus = "No MIDI input devices found";

      return;
    }

    this.history.push();
    this.liveNotes.clear();

    const onMessage = (event: Event) => {
      this.handleMidiMessage((event as MIDIMessageEvent).data);
    };

    for (const input of inputs) {
      input.addEventListener("midimessage", onMessage);
    }

    this.recordingStops = inputs.map(
      (input) => () => input.removeEventListener("midimessage", onMessage),
    );
    this.isRecording = true;
    this.recordingStatus = `Recording from ${inputs.map((input) => input.name).join(", ")}`;
    this.player.player?.play();
  }

  stopRecording(): void {
    // close any held notes at the current position
    const track = this.selectedTrack;
    const position = Math.round(this.player.player?.position ?? 0);

    if (track) {
      for (const [key, live] of this.liveNotes) {
        const noteNumber = Number(key);

        track.addEvent({
          type: "channel",
          subtype: "note",
          tick: live.startTick,
          noteNumber,
          velocity: live.velocity,
          duration: Math.max(1, position - live.startTick),
        });
      }
    }

    this.liveNotes.clear();

    for (const stop of this.recordingStops) stop();

    this.recordingStops = [];
    this.isRecording = false;
    this.recordingStatus = null;
  }

  private handleMidiMessage(data: Uint8Array | null): void {
    const track = this.selectedTrack;

    if (!data || data.length === 0 || !track || track.channel === undefined) return;

    const channel = track.channel;
    const status = data[0] ?? 0;
    const kind = status & 0xf0;
    const position = Math.round(this.player.player?.position ?? 0);
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;

    switch (kind) {
      case 0x90:
        if (d2 > 0) {
          this.liveNotes.set(String(d1), { velocity: d2, startTick: position });
          this.player.sendLiveEvent({
            type: "channel",
            subtype: "noteOn",
            channel,
            noteNumber: d1,
            velocity: d2,
          });

          break;
        }

      // falls through: vel-0 noteOn is a noteOff
      case 0x80: {
        const live = this.liveNotes.get(String(d1));

        if (live) {
          this.liveNotes.delete(String(d1));
          track.addEvent({
            type: "channel",
            subtype: "note",
            tick: live.startTick,
            noteNumber: d1,
            velocity: live.velocity,
            duration: Math.max(1, position - live.startTick),
          });
        }

        this.player.sendLiveEvent({
          type: "channel",
          subtype: "noteOff",
          channel,
          noteNumber: d1,
          velocity: 0,
        });

        break;
      }

      case 0xb0:
        track.addEvent({
          type: "channel",
          subtype: "controller",
          channel,
          controllerType: d1,
          value: d2,
          tick: position,
        });
        this.player.sendLiveEvent({
          type: "channel",
          subtype: "controller",
          channel,
          controllerType: d1,
          value: d2,
        });

        break;

      case 0xe0: {
        const value = d1 | (d2 << 7);

        track.addEvent({ type: "channel", subtype: "pitchBend", channel, value, tick: position });
        this.player.sendLiveEvent({ type: "channel", subtype: "pitchBend", channel, value });

        break;
      }

      default:
        break;
    }
  }

  // -- track management ------------------------------------------------

  addTrack(): Track | null {
    const song = this.player.song;

    if (!song) return null;

    const used = new Set(song.playableTracks.map((track) => track.channel));
    let channel = 0;

    while (used.has(channel) && channel < 15) {
      channel++;
      if (channel === 9) channel++; // leave drums to an explicit choice
    }

    this.history.push();

    const track = song.createTrack(channel, [
      { type: "meta", subtype: "trackName", text: `Track ${song.tracks.length}`, tick: 0 },
      { type: "channel", subtype: "controller", channel, controllerType: 7, value: 100, tick: 0 },
      { type: "channel", subtype: "controller", channel, controllerType: 10, value: 64, tick: 0 },
      { type: "channel", subtype: "programChange", channel, value: 0, tick: 0 },
    ]);

    this.selectTrack(track.id);

    return track;
  }

  removeTrack(id: number): void {
    const song = this.player.song;

    if (!song || song.playableTracks.length <= 1) return;

    this.history.push();
    song.removeTrack(id);

    if (this._selectedTrackId === id) {
      this._selectedTrackId = null;
      this.clearSelection();
    }
  }

  renameTrack(id: number, name: string): void {
    const track = this.player.song?.playableTracks.find((candidate) => candidate.id === id);

    if (!track) return;

    this.history.push();
    track.setName(name);
  }

  setProgram(id: number, program: number): void {
    const track = this.player.song?.playableTracks.find((candidate) => candidate.id === id);

    if (!track || track.channel === undefined) return;

    this.history.push();

    const existing = track.events.find(
      (event) => event.type === "channel" && event.subtype === "programChange",
    );

    if (existing) {
      track.updateEvent(existing.id, { value: program });
    } else {
      track.addEvent({
        type: "channel",
        subtype: "programChange",
        channel: track.channel,
        value: program,
        tick: 0,
      });
    }

    // audible immediately, not just after a seek
    this.player.sendLiveEvent({
      type: "channel",
      subtype: "programChange",
      channel: track.channel,
      value: program,
    });
  }

  /** set a track's tick-0 controller (volume CC7 / pan CC10) and send it live */
  setTrackController(id: number, controllerType: number, value: number): void {
    const track = this.player.song?.playableTracks.find((candidate) => candidate.id === id);

    if (!track || track.channel === undefined) return;

    const existing = track.events.find(
      (event) =>
        event.type === "channel" &&
        event.subtype === "controller" &&
        event.controllerType === controllerType &&
        event.tick === 0,
    );

    if (existing) {
      track.updateEvent(existing.id, { value });
    } else {
      track.addEvent({
        type: "channel",
        subtype: "controller",
        channel: track.channel,
        controllerType,
        value,
        tick: 0,
      });
    }

    this.player.sendLiveEvent({
      type: "channel",
      subtype: "controller",
      channel: track.channel,
      controllerType,
      value,
    });
  }

  // -- lane editing (CC / pitch bend / tempo curves) ------------------

  /**
   * Draw a lane point at a snapped tick: updates the event of the same
   * kind at that tick, or inserts one. Pushing history is the
   * gesture's job (once per drag).
   */
  drawLanePoint(lane: LaneKind, tick: number, value: number): void {
    const snapped = this.snapFloor(tick);

    if (lane.kind === "tempo") {
      const conductor = this.player.song?.conductorTrack;

      if (!conductor) return;

      const bpm = Math.min(400, Math.max(20, value));
      const microsecondsPerBeat = Math.round(60_000_000 / bpm);
      const existing = conductor.events.find(
        (event) => event.type === "meta" && event.subtype === "setTempo" && event.tick === snapped,
      );

      if (existing) {
        conductor.updateEvent(existing.id, { microsecondsPerBeat });
      } else {
        conductor.addEvent({
          type: "meta",
          subtype: "setTempo",
          microsecondsPerBeat,
          tick: snapped,
        });
      }

      return;
    }

    const track = this.selectedTrack;

    if (!track || track.channel === undefined) return;

    const channel = track.channel;

    if (lane.kind === "pitchBend") {
      const bend = Math.min(16_383, Math.max(0, Math.round(value)));
      const existing = track.events.find(
        (event) =>
          event.type === "channel" && event.subtype === "pitchBend" && event.tick === snapped,
      );

      if (existing) {
        track.updateEvent(existing.id, { value: bend });
      } else {
        track.addEvent({
          type: "channel",
          subtype: "pitchBend",
          channel,
          value: bend,
          tick: snapped,
        });
      }

      return;
    }

    if (lane.kind !== "controller") return;

    const cc = Math.min(127, Math.max(0, Math.round(value)));
    const existing = track.events.find(
      (event) =>
        event.type === "channel" &&
        event.subtype === "controller" &&
        event.controllerType === lane.controllerType &&
        event.tick === snapped,
    );

    if (existing) {
      track.updateEvent(existing.id, { value: cc });
    } else {
      track.addEvent({
        type: "channel",
        subtype: "controller",
        channel,
        controllerType: lane.controllerType,
        value: cc,
        tick: snapped,
      });
    }
  }

  /** erase the lane event nearest to `tick` within `tolerance` ticks */
  removeLanePointNear(lane: LaneKind, tick: number, tolerance: number): void {
    const track = lane.kind === "tempo" ? this.player.song?.conductorTrack : this.selectedTrack;

    if (!track) return;

    let best: { id: number; distance: number } | null = null;

    for (const event of track.events) {
      if (!matchesLane(event, lane)) continue;

      const distance = Math.abs(event.tick - tick);

      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { id: event.id, distance };
      }
    }

    if (best) {
      this.history.push();
      track.removeEvents([best.id]);
    }
  }
}

export type LaneKind =
  | { kind: "velocity" }
  | { kind: "controller"; controllerType: number }
  | { kind: "pitchBend" }
  | { kind: "tempo" };

function matchesLane(event: TrackEvent, lane: LaneKind): boolean {
  switch (lane.kind) {
    case "tempo":
      return event.type === "meta" && event.subtype === "setTempo";
    case "pitchBend":
      return event.type === "channel" && event.subtype === "pitchBend";
    case "controller":
      return (
        event.type === "channel" &&
        event.subtype === "controller" &&
        event.controllerType === lane.controllerType
      );
    case "velocity":
      return false;
  }
}

declare module "@ember/service" {
  interface Registry {
    editor: EditorService;
  }
}
