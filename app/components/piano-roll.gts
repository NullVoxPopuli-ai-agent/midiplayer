import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";

import { modifier } from "ember-modifier";

import { beatsInRange } from "#app/midi/measure.ts";
import { isNoteEvent } from "#app/midi/note-assembler.ts";

import { trackColor } from "./track-color.ts";

import type { Player } from "#app/midi/player.ts";
import type { Song } from "#app/midi/song.ts";
import type { TrackMute } from "#app/midi/track-mute.ts";

const RULER_HEIGHT = 26;
const KEYS_WIDTH = 44;
const PIXELS_PER_KEY = 8;
const KEY_COUNT = 128;
const CONTENT_HEIGHT = KEY_COUNT * PIXELS_PER_KEY;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

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

export interface PianoRollSignature {
  Args: {
    song: Song;
    player: Player;
    trackMute: TrackMute;
  };
}

/**
 * A scrolling piano roll: one viewport-sized canvas kept sticky inside
 * a scroll container (a spacer div provides the scrollable area), so
 * arbitrarily long songs cost only one visible-window redraw — the
 * same virtualization idea as signal's WebGL canvas.
 *
 *   x = tick * pixelsPerTick   (signal's TickTransform)
 *   y = (127 - noteNumber) * pixelsPerKey   (KeyTransform)
 *
 * The measure ruler on top seeks on click and sets the loop range on
 * drag; the piano-key sidebar is drawn in the same canvas.
 */
export class PianoRoll extends Component<PianoRollSignature> {
  /** zoom 1 = 96 px per beat */
  @tracked zoom = 1;

  private viewport: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private spacer: HTMLElement | null = null;
  private followedSong: Song | null = null;
  private rulerDrag: { startTick: number; dragged: boolean } | null = null;

  get pixelsPerTick(): number {
    return (96 / this.args.song.timebase) * this.zoom;
  }

  zoomIn = (): void => this.setZoom(this.zoom * ZOOM_STEP);
  zoomOut = (): void => this.setZoom(this.zoom / ZOOM_STEP);

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

  onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.localPoint(event);

    if (x < KEYS_WIDTH) return;

    if (y < RULER_HEIGHT) {
      this.rulerDrag = { startTick: this.snapToBeat(this.tickAt(x)), dragged: false };

      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // synthetic events (tests) have no active pointer to capture
      }
    }
  };

  onPointerMove = (event: PointerEvent): void => {
    const drag = this.rulerDrag;

    if (!drag) return;

    const { x } = this.localPoint(event);
    const tick = this.snapToBeat(this.tickAt(x));

    if (tick !== drag.startTick) drag.dragged = true;

    if (drag.dragged) {
      this.args.player.loop = {
        begin: Math.min(drag.startTick, tick),
        end: Math.max(drag.startTick, tick),
        enabled: true,
      };
    }
  };

  onPointerUp = (event: PointerEvent): void => {
    const drag = this.rulerDrag;

    this.rulerDrag = null;

    if (drag) {
      if (!drag.dragged) {
        this.args.player.position = drag.startTick;
      }

      return;
    }

    // click in the note area seeks too
    const { x, y } = this.localPoint(event);

    if (x >= KEYS_WIDTH && y >= RULER_HEIGHT) {
      this.args.player.position = Math.max(0, this.tickAt(x));
    }
  };

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
   * Consumes the reactive state (position, loop, zoom, mutes, song) so
   * the modifier re-runs; scroll offsets are read from the DOM in
   * draw() and don't need to be reactive.
   */
  react = modifier(() => {
    const { song, player, trackMute } = this.args;
    const isPlaying = player.isPlaying;
    const position = player.position;

    void player.loop;
    void this.zoom;

    for (const track of song.playableTracks) void trackMute.shouldPlayTrack(track.id);

    this.syncSpacer();

    if (song !== this.followedSong) {
      this.followedSong = song;
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

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.viewport?.getBoundingClientRect();

    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  }

  private tickAt(viewportX: number): number {
    const scrollLeft = this.viewport?.scrollLeft ?? 0;

    return Math.max(0, (scrollLeft + viewportX - KEYS_WIDTH) / this.pixelsPerTick);
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

    this.drawNoteArea(ctx, { width, height, theme, ppt, startTick, endTick, xOf, yOf });
    this.drawRuler(ctx, { width, theme, ppt, startTick, endTick, xOf });
    this.drawKeys(ctx, { height, theme, yOf });

    // separators
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = theme.text;
    ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    ctx.fillRect(KEYS_WIDTH - 1, 0, 1, height);
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

    // notes
    for (const track of song.playableTracks) {
      ctx.globalAlpha = trackMute.shouldPlayTrack(track.id) ? 0.9 : 0.15;
      ctx.fillStyle = trackColor(track.id);

      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;
        if (event.tick + event.duration < startTick) continue;
        if (event.tick > endTick) break;

        const x = xOf(event.tick);
        const y = yOf(event.noteNumber);

        if (y + PIXELS_PER_KEY < RULER_HEIGHT || y > height) continue;

        const noteHeight = PIXELS_PER_KEY - 1;

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
      }
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
        <span class="piano-roll__hint">
          Click the ruler to seek · drag it to set a loop · ctrl+wheel to zoom
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
      >
        <div class="piano-roll__spacer"></div>
        <canvas class="piano-roll__canvas" aria-label="Piano roll"></canvas>
      </div>
    </div>
  </template>
}
