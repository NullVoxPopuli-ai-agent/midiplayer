import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";

import { beatsInRange } from "#app/midi/measure.ts";
import { isNoteEvent } from "#app/midi/note-assembler.ts";

import { trackColor } from "./track-color.ts";

import type { Player } from "#app/midi/player.ts";
import type { Song, Track } from "#app/midi/song.ts";
import type { TrackMute } from "#app/midi/track-mute.ts";
import type { NoteEvent } from "#app/midi/types.ts";
import type EditorService from "#services/editor.ts";
import type { LaneKind } from "#services/editor.ts";
import type HistoryService from "#services/history.ts";

const RULER_HEIGHT = 26;
const KEYS_WIDTH = 44;
const PIXELS_PER_KEY = 8;
const KEY_COUNT = 128;
const CONTENT_HEIGHT = KEY_COUNT * PIXELS_PER_KEY;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

const RESIZE_HANDLE_PX = 6;
const LANE_HEIGHT = 110;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

const QUANTIZE_CHOICES = [1, 2, 4, 8, 16, 32];

const TEMPO_MIN = 20;
const TEMPO_MAX = 300;

interface LaneChoice {
  id: string;
  label: string;
  lane: LaneKind;
  max: number;
}

const VELOCITY_LANE: LaneChoice = {
  id: "velocity",
  label: "Velocity",
  lane: { kind: "velocity" },
  max: 127,
};

const LANE_CHOICES: LaneChoice[] = [
  VELOCITY_LANE,
  { id: "pitchBend", label: "Pitch Bend", lane: { kind: "pitchBend" }, max: 16_383 },
  {
    id: "cc1",
    label: "Modulation (CC1)",
    lane: { kind: "controller", controllerType: 1 },
    max: 127,
  },
  { id: "cc7", label: "Volume (CC7)", lane: { kind: "controller", controllerType: 7 }, max: 127 },
  {
    id: "cc11",
    label: "Expression (CC11)",
    lane: { kind: "controller", controllerType: 11 },
    max: 127,
  },
  {
    id: "cc64",
    label: "Sustain (CC64)",
    lane: { kind: "controller", controllerType: 64 },
    max: 127,
  },
  { id: "tempo", label: "Tempo", lane: { kind: "tempo" }, max: TEMPO_MAX },
];

type IdNote = NoteEvent & { id: number };

interface Theme {
  text: string;
  primary: string;
}

function themeOf(element: HTMLElement): Theme {
  const style = getComputedStyle(element);

  return {
    text: style.getPropertyValue("--color-text").trim() || "#888",
    primary: style.getPropertyValue("--color-primary").trim() || "#09f",
  };
}

interface NoteDrag {
  kind: "move" | "resize";
  originNotes: IdNote[];
  startTick: number;
  startKey: number;
  moved: boolean;
}

interface Rubber {
  startTick: number;
  startKey: number;
  endTick: number;
  endKey: number;
}

export interface PianoRollSignature {
  Args: {
    song: Song;
    player: Player;
    trackMute: TrackMute;
  };
}

/**
 * A scrolling piano roll editor: one viewport-sized canvas kept sticky
 * inside a scroll container (a spacer div provides the scrollable
 * area), so arbitrarily long songs cost only a visible-window redraw —
 * the same virtualization idea as signal's WebGL canvas.
 *
 *   x = tick * pixelsPerTick   (signal's TickTransform)
 *   y = (127 - noteNumber) * pixelsPerKey   (KeyTransform)
 *
 * Ruler: click seeks, drag sets the loop range. Note area edits the
 * selected track: pencil draws (drag = length), moves, and resizes;
 * the selection tool rubber-band selects and drags selections;
 * right-click deletes. Other tracks render as ghosts.
 */
export class PianoRoll extends Component<PianoRollSignature> {
  @service declare editor: EditorService;
  @service declare history: HistoryService;

  /** zoom 1 = 96 px per beat */
  @tracked zoom = 1;

  private viewport: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private spacer: HTMLElement | null = null;
  private followedSong: Song | null = null;
  private rulerDrag: { startTick: number; dragged: boolean } | null = null;
  private noteDrag: NoteDrag | null = null;
  private rubber: Rubber | null = null;
  private laneDrag: LaneChoice | null = null;

  @tracked laneChoiceId = "velocity";

  get laneChoice(): LaneChoice {
    return LANE_CHOICES.find((choice) => choice.id === this.laneChoiceId) ?? VELOCITY_LANE;
  }

  setLane = (event: Event): void => {
    this.laneChoiceId = (event.target as HTMLSelectElement).value;
  };

  get pixelsPerTick(): number {
    return (96 / this.args.song.timebase) * this.zoom;
  }

  // -- toolbar -------------------------------------------------------

  zoomIn = (): void => this.setZoom(this.zoom * ZOOM_STEP);
  zoomOut = (): void => this.setZoom(this.zoom / ZOOM_STEP);

  setTool = (tool: "pencil" | "selection"): void => {
    this.editor.tool = tool;
  };

  setQuantize = (event: Event): void => {
    this.editor.quantize = Number((event.target as HTMLSelectElement).value);
  };

  undo = (): void => this.history.undo();
  redo = (): void => this.history.redo();

  private setZoom(zoom: number, anchorX?: number): void {
    const viewport = this.viewport;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

    if (next === this.zoom) return;

    if (viewport) {
      // keep the tick under the anchor (or viewport center) stable
      const anchor = anchorX ?? viewport.clientWidth / 2;
      const tickAtAnchor = (viewport.scrollLeft + anchor - KEYS_WIDTH) / this.pixelsPerTick;

      this.zoom = next;
      this.syncSpacer();
      viewport.scrollLeft = tickAtAnchor * this.pixelsPerTick - anchor + KEYS_WIDTH;
    } else {
      this.zoom = next;
    }
  }

  onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

    this.setZoom(
      this.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP),
      event.clientX - rect.left,
    );
  };

  onScroll = (): void => {
    this.draw();
  };

  onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  // -- pointer interactions -----------------------------------------

  onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.localPoint(event);

    if (x < KEYS_WIDTH) return;

    if (y < RULER_HEIGHT) {
      this.rulerDrag = { startTick: this.snapToBeat(this.tickAt(x)), dragged: false };
      this.capturePointer(event);

      return;
    }

    if (y >= this.laneTop()) {
      if (event.button === 2) {
        this.editor.removeLanePointNear(
          this.laneChoice.lane,
          this.tickAt(x),
          this.editor.snapTicks,
        );

        return;
      }

      if (event.button !== 0) return;

      this.capturePointer(event);
      this.history.push();
      this.laneDrag = this.laneChoice;
      this.applyLanePoint(x, y);

      return;
    }

    const tick = this.tickAt(x);
    const key = this.keyAt(y);
    const hit = this.hitTestNote(tick, key, x);

    // right-click erases
    if (event.button === 2) {
      if (hit) this.editor.deleteNote(hit.note.id);

      return;
    }

    if (event.button !== 0) return;

    this.capturePointer(event);

    if (hit) {
      // drag an existing note (both tools)
      if (!this.editor.selection.has(hit.note.id)) {
        this.editor.setSelection([hit.note.id]);
      }

      this.history.push();
      this.noteDrag = {
        kind: hit.onEdge ? "resize" : "move",
        originNotes: this.editor.selectedNotes.map((note) => ({ ...note })),
        startTick: tick,
        startKey: key,
        moved: false,
      };

      return;
    }

    if (this.editor.tool === "pencil") {
      const id = this.editor.createNote(tick, key);

      if (id !== null) {
        const created = this.editor.selectedNotes.find((note) => note.id === id);

        if (created) {
          // keep dragging to set the note length
          this.noteDrag = {
            kind: "resize",
            originNotes: [{ ...created }],
            startTick: tick,
            startKey: key,
            moved: false,
          };
        }
      }
    } else {
      this.editor.clearSelection();
      this.rubber = { startTick: tick, startKey: key, endTick: tick, endKey: key };
    }
  };

  onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.localPoint(event);

    if (this.laneDrag) {
      this.applyLanePoint(x, y);

      return;
    }

    if (this.rulerDrag) {
      const tick = this.snapToBeat(this.tickAt(x));

      if (tick !== this.rulerDrag.startTick) this.rulerDrag.dragged = true;

      if (this.rulerDrag.dragged) {
        this.args.player.loop = {
          begin: Math.min(this.rulerDrag.startTick, tick),
          end: Math.max(this.rulerDrag.startTick, tick),
          enabled: true,
        };
      }

      return;
    }

    if (this.noteDrag) {
      const drag = this.noteDrag;
      const deltaTick = this.tickAt(x) - drag.startTick;
      const deltaKey = this.keyAt(y) - drag.startKey;

      drag.moved ||= Math.abs(deltaTick) > 0 || deltaKey !== 0;

      if (drag.kind === "move") {
        this.editor.moveNotes(drag.originNotes, deltaTick, deltaKey);
      } else {
        const origin = drag.originNotes[0];

        if (origin) this.editor.resizeNote(origin, deltaTick);
      }

      return;
    }

    if (this.rubber) {
      this.rubber.endTick = this.tickAt(x);
      this.rubber.endKey = this.keyAt(y);
      this.draw();

      return;
    }

    this.updateCursor(x, y);
  };

  onPointerUp = (event: PointerEvent): void => {
    const rulerDrag = this.rulerDrag;
    const rubber = this.rubber;

    this.rulerDrag = null;
    this.noteDrag = null;
    this.rubber = null;
    this.laneDrag = null;

    if (rulerDrag) {
      if (!rulerDrag.dragged) {
        this.args.player.position = rulerDrag.startTick;
      }

      return;
    }

    if (rubber) {
      const track = this.editor.selectedTrack;

      if (!track) return;

      const [minTick, maxTick] = order(rubber.startTick, rubber.endTick);
      const [minKey, maxKey] = order(rubber.startKey, rubber.endKey);

      this.editor.setSelection(
        track.events
          .filter(isNoteEvent)
          .filter(
            (note) =>
              note.tick < maxTick &&
              note.tick + note.duration > minTick &&
              note.noteNumber >= minKey &&
              note.noteNumber <= maxKey,
          )
          .map((note) => note.id),
      );
      this.draw();

      return;
    }

    void event;
  };

  // -- lane editing ---------------------------------------------------

  private laneTop(): number {
    return (this.viewport?.clientHeight ?? 0) - LANE_HEIGHT;
  }

  private laneValueAt(y: number): number {
    const fraction = Math.min(
      1,
      Math.max(0, ((this.viewport?.clientHeight ?? 0) - y) / LANE_HEIGHT),
    );
    const { lane, max } = this.laneChoice;

    if (lane.kind === "tempo") {
      return TEMPO_MIN + fraction * (TEMPO_MAX - TEMPO_MIN);
    }

    return fraction * max;
  }

  private applyLanePoint(x: number, y: number): void {
    const tick = this.tickAt(x);
    const value = this.laneValueAt(y);
    const lane = this.laneChoice.lane;

    if (lane.kind === "velocity") {
      const track = this.editor.selectedTrack;

      if (!track) return;

      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;
        if (tick < event.tick || tick >= event.tick + event.duration) continue;

        this.editor.setVelocity(event.id, value);
      }

      return;
    }

    this.editor.drawLanePoint(lane, tick, value);
  }

  // -- geometry ------------------------------------------------------

  private capturePointer(event: PointerEvent): void {
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // synthetic events (tests) have no active pointer to capture
    }
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.viewport?.getBoundingClientRect();

    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  }

  private tickAt(viewportX: number): number {
    const scrollLeft = this.viewport?.scrollLeft ?? 0;

    return Math.max(0, (scrollLeft + viewportX - KEYS_WIDTH) / this.pixelsPerTick);
  }

  private keyAt(viewportY: number): number {
    const scrollTop = this.viewport?.scrollTop ?? 0;
    const row = Math.floor((scrollTop + viewportY - RULER_HEIGHT) / PIXELS_PER_KEY);

    return Math.min(KEY_COUNT - 1, Math.max(0, KEY_COUNT - 1 - row));
  }

  private hitTestNote(
    tick: number,
    key: number,
    viewportX: number,
  ): { note: IdNote; onEdge: boolean } | null {
    const track = this.editor.selectedTrack;

    if (!track) return null;

    const notes = track.events.filter(isNoteEvent);

    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i] as IdNote;

      if (note.noteNumber !== key) continue;
      if (tick < note.tick || tick > note.tick + note.duration) continue;

      const endX = (note.tick + note.duration) * this.pixelsPerTick;
      const scrolledX = (this.viewport?.scrollLeft ?? 0) + viewportX - KEYS_WIDTH;
      const onEdge = endX - scrolledX <= RESIZE_HANDLE_PX;

      return { note, onEdge };
    }

    return null;
  }

  private updateCursor(x: number, y: number): void {
    const canvas = this.canvas;

    if (!canvas) return;

    if (y >= this.laneTop()) {
      canvas.style.cursor = "crosshair";

      return;
    }

    if (y < RULER_HEIGHT || x < KEYS_WIDTH) {
      canvas.style.cursor = "pointer";

      return;
    }

    const hit = this.hitTestNote(this.tickAt(x), this.keyAt(y), x);

    if (hit) {
      canvas.style.cursor = hit.onEdge ? "ew-resize" : "move";
    } else {
      canvas.style.cursor = this.editor.tool === "pencil" ? "crosshair" : "default";
    }
  }

  private snapToBeat(tick: number): number {
    const { song } = this.args;
    let measure = song.measures[0];

    for (const candidate of song.measures) {
      if (candidate.tick > tick) break;
      measure = candidate;
    }

    const ticksPerBeat = measure ? (song.timebase * 4) / measure.denominator : song.timebase;
    const base = measure?.tick ?? 0;

    return Math.max(0, base + Math.round((tick - base) / ticksPerBeat) * ticksPerBeat);
  }

  // -- lifecycle -----------------------------------------------------

  setup = modifier((viewport: HTMLElement) => {
    this.viewport = viewport;
    this.canvas = viewport.querySelector("canvas");
    this.spacer = viewport.querySelector(".piano-roll__spacer");

    const observer = new ResizeObserver(() => this.draw());

    observer.observe(viewport);

    return () => {
      observer.disconnect();
      this.viewport = null;
      this.canvas = null;
      this.spacer = null;
    };
  });

  /**
   * Consumes the reactive state (position, loop, zoom, selection, note
   * data, mutes, song) so the modifier re-runs; scroll offsets are
   * read from the DOM in draw() and don't need to be reactive.
   */
  react = modifier(() => {
    const { song, player, trackMute } = this.args;
    const isPlaying = player.isPlaying;
    const position = player.position;

    void player.loop;
    void this.zoom;
    void this.editor.selection;
    void this.editor.tool;
    void this.editor.selectedTrack;
    void this.laneChoiceId;
    void song.conductorTrack?.events;

    for (const track of song.playableTracks) {
      void trackMute.shouldPlayTrack(track.id);
      void track.events;
    }

    this.syncSpacer();

    if (song !== this.followedSong) {
      this.followedSong = song;
      this.editor.clearSelection();
      this.scrollToNotes();
    }

    if (isPlaying) this.followPlayhead(position);

    this.draw();
  });

  private syncSpacer(): void {
    if (!this.spacer) return;

    const width = Math.ceil(this.args.song.endOfSong * this.pixelsPerTick) + KEYS_WIDTH;

    this.spacer.style.width = `${width}px`;
    this.spacer.style.height = `${CONTENT_HEIGHT + RULER_HEIGHT}px`;
  }

  private scrollToNotes(): void {
    const viewport = this.viewport;

    if (!viewport) return;

    let sum = 0;
    let count = 0;

    for (const track of this.args.song.playableTracks) {
      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;

        sum += event.noteNumber;
        count++;
      }
    }

    const center = count ? sum / count : 60;

    viewport.scrollLeft = 0;
    viewport.scrollTop = (KEY_COUNT - center) * PIXELS_PER_KEY - viewport.clientHeight / 2;
  }

  private followPlayhead(position: number): void {
    const viewport = this.viewport;

    if (!viewport) return;

    const playheadX = position * this.pixelsPerTick;
    const viewWidth = viewport.clientWidth - KEYS_WIDTH;
    const left = viewport.scrollLeft;

    if (playheadX < left || playheadX > left + viewWidth * 0.9) {
      viewport.scrollLeft = Math.max(0, playheadX - viewWidth * 0.1);
    }
  }

  // -- drawing -------------------------------------------------------

  private draw(): void {
    const { canvas, viewport } = this;

    if (!canvas || !viewport) return;

    const width = viewport.clientWidth;
    const height = viewport.clientHeight;

    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const theme = themeOf(canvas);
    const ppt = this.pixelsPerTick;
    const scrollX = viewport.scrollLeft;
    const scrollY = viewport.scrollTop;
    const startTick = Math.max(0, (scrollX - KEYS_WIDTH) / ppt);
    const endTick = (scrollX + width) / ppt;

    const xOf = (tick: number): number => tick * ppt - scrollX + KEYS_WIDTH;
    const yOf = (key: number): number =>
      (KEY_COUNT - 1 - key) * PIXELS_PER_KEY - scrollY + RULER_HEIGHT;

    const laneTop = height - LANE_HEIGHT;

    this.drawNoteArea(ctx, { width, height: laneTop, theme, ppt, startTick, endTick, xOf, yOf });
    this.drawRuler(ctx, { width, theme, ppt, startTick, endTick, xOf });
    this.drawKeys(ctx, { height: laneTop, theme, yOf });
    this.drawLane(ctx, { width, height, laneTop, theme, ppt, startTick, endTick, xOf });

    // playhead across the lane too
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_WIDTH, laneTop, width - KEYS_WIDTH, LANE_HEIGHT);
    ctx.clip();
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.primary;
    ctx.fillRect(xOf(this.args.player.position) - 1, laneTop, 2, LANE_HEIGHT);
    ctx.restore();

    // separators
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = theme.text;
    ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    ctx.fillRect(0, laneTop - 1, width, 1);
    ctx.fillRect(KEYS_WIDTH - 1, 0, 1, height);
  }

  private drawLane(
    ctx: CanvasRenderingContext2D,
    opts: {
      width: number;
      height: number;
      laneTop: number;
      theme: Theme;
      ppt: number;
      startTick: number;
      endTick: number;
      xOf: (tick: number) => number;
    },
  ): void {
    const { width, height, laneTop, theme, startTick, endTick, xOf } = opts;
    const choice = this.laneChoice;
    const { song } = this.args;
    const track = choice.lane.kind === "tempo" ? song.conductorTrack : this.editor.selectedTrack;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, laneTop, width, LANE_HEIGHT);
    ctx.clip();

    ctx.globalAlpha = 0.04;
    ctx.fillStyle = theme.text;
    ctx.fillRect(0, laneTop, width, LANE_HEIGHT);

    // label in the keys column
    ctx.globalAlpha = 0.7;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(choice.label.slice(0, 8), 4, laneTop + 4);

    if (!track) {
      ctx.restore();

      return;
    }

    const yFor = (fraction: number): number =>
      height - Math.min(1, Math.max(0, fraction)) * (LANE_HEIGHT - 14);

    if (choice.lane.kind === "velocity") {
      ctx.fillStyle = trackColor(track.id);

      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;
        if (event.tick + event.duration < startTick || event.tick > endTick) continue;

        const selected = this.editor.selection.has(event.id);
        const y = yFor(event.velocity / 127);

        ctx.globalAlpha = selected ? 1 : 0.75;
        ctx.fillRect(xOf(event.tick), y, 4, height - y);
      }

      ctx.restore();

      return;
    }

    // step curves: pitch bend / CC / tempo
    const points: { tick: number; fraction: number }[] = [];

    for (const event of track.events) {
      if (choice.lane.kind === "tempo") {
        if (event.type === "meta" && event.subtype === "setTempo") {
          const bpm = 60_000_000 / event.microsecondsPerBeat;

          points.push({
            tick: event.tick,
            fraction: (bpm - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN),
          });
        }
      } else if (choice.lane.kind === "pitchBend") {
        if (event.type === "channel" && event.subtype === "pitchBend") {
          points.push({ tick: event.tick, fraction: event.value / 16_383 });
        }
      } else if (
        event.type === "channel" &&
        event.subtype === "controller" &&
        event.controllerType === choice.lane.controllerType
      ) {
        points.push({ tick: event.tick, fraction: event.value / 127 });
      }
    }

    ctx.strokeStyle = trackColor(track.id);
    ctx.fillStyle = trackColor(track.id);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;

    let previous: { x: number; y: number } | null = null;

    for (const point of points) {
      const x = xOf(point.tick);
      const y = yFor(point.fraction);

      if (previous) {
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(x, previous.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      previous = { x, y };
    }

    if (previous && previous.x < width) {
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(width, previous.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawNoteArea(
    ctx: CanvasRenderingContext2D,
    opts: {
      width: number;
      height: number;
      theme: Theme;
      ppt: number;
      startTick: number;
      endTick: number;
      xOf: (tick: number) => number;
      yOf: (key: number) => number;
    },
  ): void {
    const { width, height, theme, ppt, startTick, endTick, xOf, yOf } = opts;
    const { song, player, trackMute } = this.args;
    const loop = player.loop;
    const selectedTrack = this.editor.selectedTrack;

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_WIDTH, RULER_HEIGHT, width - KEYS_WIDTH, height - RULER_HEIGHT);
    ctx.clip();

    // black-key lanes
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = theme.text;

    for (let key = 0; key < KEY_COUNT; key++) {
      if (!BLACK_KEYS.has(key % 12)) continue;

      const y = yOf(key);

      if (y + PIXELS_PER_KEY < RULER_HEIGHT || y > height) continue;

      ctx.fillRect(KEYS_WIDTH, y, width - KEYS_WIDTH, PIXELS_PER_KEY);
    }

    // beat + measure grid
    for (const beat of beatsInRange(song.measures, song.timebase, startTick, endTick)) {
      ctx.globalAlpha = beat.isMeasureStart ? 0.25 : 0.08;
      ctx.fillRect(xOf(beat.tick), RULER_HEIGHT, 1, height - RULER_HEIGHT);
    }

    // loop region shading
    if (loop) {
      ctx.globalAlpha = loop.enabled ? 0.1 : 0.04;
      ctx.fillStyle = theme.primary;
      ctx.fillRect(xOf(loop.begin), RULER_HEIGHT, (loop.end - loop.begin) * ppt, height);
    }

    // notes: ghost tracks first, the selected (edited) track on top
    const ordered: Track[] = song.playableTracks.filter((track) => track !== selectedTrack);

    if (selectedTrack) ordered.push(selectedTrack);

    for (const track of ordered) {
      const isSelectedTrack = track === selectedTrack;
      const playing = trackMute.shouldPlayTrack(track.id);
      const baseAlpha = isSelectedTrack ? 0.95 : 0.18;

      ctx.globalAlpha = playing ? baseAlpha : baseAlpha * 0.3;
      ctx.fillStyle = trackColor(track.id);

      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;
        if (event.tick + event.duration < startTick) continue;
        if (event.tick > endTick) break;

        const x = xOf(event.tick);
        const y = yOf(event.noteNumber);

        if (y + PIXELS_PER_KEY < RULER_HEIGHT || y > height) continue;

        const noteHeight = PIXELS_PER_KEY - 1;
        const selected = isSelectedTrack && this.editor.selection.has(event.id);

        if (track.isRhythmTrack) {
          // signal draws drum hits as fixed-size diamonds
          ctx.beginPath();
          ctx.moveTo(x, y + noteHeight / 2);
          ctx.lineTo(x + noteHeight / 2, y);
          ctx.lineTo(x + noteHeight, y + noteHeight / 2);
          ctx.lineTo(x + noteHeight / 2, y + noteHeight);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, Math.max(2, event.duration * ppt - 1), noteHeight);
        }

        if (selected) {
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = theme.primary;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(
            x - 0.5,
            y - 0.5,
            Math.max(2, event.duration * ppt - 1) + 1,
            noteHeight + 1,
          );
          ctx.restore();
        }
      }
    }

    // rubber-band selection rectangle
    if (this.rubber) {
      const [minTick, maxTick] = order(this.rubber.startTick, this.rubber.endTick);
      const [minKey, maxKey] = order(this.rubber.startKey, this.rubber.endKey);

      ctx.globalAlpha = 0.15;
      ctx.fillStyle = theme.primary;
      ctx.fillRect(
        xOf(minTick),
        yOf(maxKey),
        (maxTick - minTick) * ppt,
        (maxKey - minKey + 1) * PIXELS_PER_KEY,
      );
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = theme.primary;
      ctx.strokeRect(
        xOf(minTick),
        yOf(maxKey),
        (maxTick - minTick) * ppt,
        (maxKey - minKey + 1) * PIXELS_PER_KEY,
      );
    }

    // playhead
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.primary;
    ctx.fillRect(xOf(player.position) - 1, RULER_HEIGHT, 2, height - RULER_HEIGHT);
    ctx.restore();
  }

  private drawRuler(
    ctx: CanvasRenderingContext2D,
    opts: {
      width: number;
      theme: Theme;
      ppt: number;
      startTick: number;
      endTick: number;
      xOf: (tick: number) => number;
    },
  ): void {
    const { width, theme, ppt, startTick, endTick, xOf } = opts;
    const { song, player } = this.args;
    const loop = player.loop;

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_WIDTH, 0, width - KEYS_WIDTH, RULER_HEIGHT);
    ctx.clip();

    ctx.globalAlpha = 0.06;
    ctx.fillStyle = theme.text;
    ctx.fillRect(KEYS_WIDTH, 0, width - KEYS_WIDTH, RULER_HEIGHT);

    if (loop) {
      ctx.globalAlpha = loop.enabled ? 0.35 : 0.15;
      ctx.fillStyle = theme.primary;
      ctx.fillRect(xOf(loop.begin), 0, (loop.end - loop.begin) * ppt, RULER_HEIGHT);
    }

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = theme.text;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "top";

    for (const beat of beatsInRange(song.measures, song.timebase, startTick, endTick)) {
      if (!beat.isMeasureStart) continue;

      const x = xOf(beat.tick);

      ctx.fillRect(x, 0, 1, RULER_HEIGHT);
      ctx.fillText(String(beat.measureNumber + 1), x + 3, 3);
    }

    ctx.fillStyle = theme.primary;
    ctx.fillRect(xOf(player.position) - 1, 0, 2, RULER_HEIGHT);
    ctx.restore();
  }

  private drawKeys(
    ctx: CanvasRenderingContext2D,
    opts: { height: number; theme: Theme; yOf: (key: number) => number },
  ): void {
    const { height, theme, yOf } = opts;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, KEYS_WIDTH, height - RULER_HEIGHT);
    ctx.clip();

    for (let key = 0; key < KEY_COUNT; key++) {
      const y = yOf(key);

      if (y + PIXELS_PER_KEY < RULER_HEIGHT || y > height) continue;

      if (BLACK_KEYS.has(key % 12)) {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = theme.text;
        ctx.fillRect(0, y, KEYS_WIDTH * 0.6, PIXELS_PER_KEY);
      }

      if (key % 12 === 0) {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = theme.text;
        ctx.font = "9px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${key / 12 - 1}`, KEYS_WIDTH * 0.62, y + PIXELS_PER_KEY / 2);
        ctx.globalAlpha = 0.25;
        ctx.fillRect(0, y + PIXELS_PER_KEY - 1, KEYS_WIDTH, 1);
      }
    }

    ctx.restore();
  }

  <template>
    <div class="surface elevation-md piano-roll">
      <div class="piano-roll__toolbar">
        <button
          type="button"
          class="preem__button piano-roll__tool"
          aria-pressed="{{if (isTool this.editor.tool 'pencil') 'true' 'false'}}"
          aria-label="Pencil tool (draw, move, resize notes)"
          {{on "click" (fn this.setTool "pencil")}}
        >✏️</button>
        <button
          type="button"
          class="preem__button piano-roll__tool"
          aria-pressed="{{if (isTool this.editor.tool 'selection') 'true' 'false'}}"
          aria-label="Selection tool"
          {{on "click" (fn this.setTool "selection")}}
        >⬚</button>

        <label class="piano-roll__quantize">
          Snap
          <select aria-label="Quantize" {{on "change" this.setQuantize}}>
            {{#each QUANTIZE_CHOICES as |choice|}}
              <option value={{choice}} selected={{isQuantize this.editor.quantize choice}}>
                1/{{choice}}
              </option>
            {{/each}}
          </select>
        </label>

        <label class="piano-roll__quantize">
          Lane
          <select aria-label="Control lane" {{on "change" this.setLane}}>
            {{#each LANE_CHOICES as |choice|}}
              <option value={{choice.id}} selected={{isLane this.laneChoiceId choice.id}}>
                {{choice.label}}
              </option>
            {{/each}}
          </select>
        </label>

        <button
          type="button"
          class="preem__button"
          aria-label="Undo"
          disabled={{unless this.history.canUndo true}}
          {{on "click" this.undo}}
        >↩</button>
        <button
          type="button"
          class="preem__button"
          aria-label="Redo"
          disabled={{unless this.history.canRedo true}}
          {{on "click" this.redo}}
        >↪</button>

        <span class="piano-roll__hint">
          Editing
          <strong>{{trackDisplayName this.editor.selectedTrack}}</strong>
          · ruler: click seeks, drag loops · right-click erases · ctrl+wheel zooms
        </span>

        <button
          type="button"
          class="preem__button"
          aria-label="Zoom out"
          {{on "click" this.zoomOut}}
        >−</button>
        <button
          type="button"
          class="preem__button"
          aria-label="Zoom in"
          {{on "click" this.zoomIn}}
        >+</button>
      </div>

      {{! template-lint-disable no-invalid-interactive }}
      <div
        class="piano-roll__viewport"
        {{this.setup}}
        {{this.react}}
        {{on "scroll" this.onScroll}}
        {{on "wheel" this.onWheel}}
        {{on "pointerdown" this.onPointerDown}}
        {{on "pointermove" this.onPointerMove}}
        {{on "pointerup" this.onPointerUp}}
        {{on "contextmenu" this.onContextMenu}}
      >
        <div class="piano-roll__spacer"></div>
        <canvas class="piano-roll__canvas" aria-label="Piano roll"></canvas>
      </div>
    </div>
  </template>
}

function order(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function isTool(current: string, tool: string): boolean {
  return current === tool;
}

function isQuantize(current: number, choice: number): boolean {
  return current === choice;
}

function isLane(current: string, choice: string): boolean {
  return current === choice;
}

function trackDisplayName(track: Track | null): string {
  if (!track) return "—";

  return track.name || `Track ${track.id}`;
}
