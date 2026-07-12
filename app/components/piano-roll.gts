import Component from "@glimmer/component";
import { on } from "@ember/modifier";

import { modifier } from "ember-modifier";

import { isNoteEvent } from "#app/midi/note-assembler.ts";

import { trackColor } from "./track-color.ts";

import type { Player } from "#app/midi/player.ts";
import type { Song } from "#app/midi/song.ts";
import type { TrackMute } from "#app/midi/track-mute.ts";

const HEIGHT = 320;
const MIN_KEY_SPAN = 24;
const KEY_PADDING = 3;

interface KeyRange {
  min: number;
  max: number;
}

/**
 * The piano roll is a single canvas fit to the whole song:
 *   x = tick * pixelsPerTick, y = (maxKey - noteNumber) * pixelsPerKey
 * (signal's NoteCoordTransform, with the key range clamped to the notes
 * actually used since we don't scroll)
 */
function keyRange(song: Song): KeyRange {
  let min = 127;
  let max = 0;

  for (const track of song.playableTracks) {
    for (const event of track.events) {
      if (!isNoteEvent(event)) continue;

      min = Math.min(min, event.noteNumber);
      max = Math.max(max, event.noteNumber);
    }
  }

  if (min > max) {
    return { min: 48, max: 48 + MIN_KEY_SPAN };
  }

  min = Math.max(0, min - KEY_PADDING);
  max = Math.min(127, max + KEY_PADDING);

  while (max - min < MIN_KEY_SPAN) {
    if (min > 0) min--;
    if (max < 127) max++;
  }

  return { min, max };
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function draw(canvas: HTMLCanvasElement, song: Song, position: number, trackMute: TrackMute): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = HEIGHT;

  if (cssWidth === 0) return;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const style = getComputedStyle(canvas);
  const textColor = style.getPropertyValue("--color-text").trim() || "#888";
  const primary = style.getPropertyValue("--color-primary").trim() || "#09f";

  const range = keyRange(song);
  const keys = range.max - range.min + 1;
  const pixelsPerKey = cssHeight / keys;
  const totalTicks = Math.max(song.lastEventTick + song.timebase * 4, 1);
  const pixelsPerTick = cssWidth / totalTicks;

  // horizontal lanes for black keys
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = textColor;

  for (let key = range.min; key <= range.max; key++) {
    if (BLACK_KEYS.has(key % 12)) {
      const y = (range.max - key) * pixelsPerKey;

      ctx.fillRect(0, y, cssWidth, pixelsPerKey);
    }
  }

  // measure lines
  ctx.globalAlpha = 0.2;

  for (const [index, measure] of song.measures.entries()) {
    const next = song.measures[index + 1];
    const nextTick = next?.tick ?? totalTicks;
    const perMeasure = ((song.timebase * 4) / measure.denominator) * measure.numerator;

    for (let tick = measure.tick; tick < nextTick; tick += perMeasure) {
      const x = tick * pixelsPerTick;

      ctx.fillRect(x, 0, 1, cssHeight);
    }
  }

  // notes
  for (const track of song.playableTracks) {
    const playing = trackMute.shouldPlayTrack(track.id);

    ctx.globalAlpha = playing ? 0.9 : 0.15;
    ctx.fillStyle = trackColor(track.id);

    for (const event of track.events) {
      if (!isNoteEvent(event)) continue;

      const x = event.tick * pixelsPerTick;
      const y = (range.max - event.noteNumber) * pixelsPerKey;
      const noteHeight = Math.max(1, pixelsPerKey - 1);

      if (track.isRhythmTrack) {
        // drum hits render as fixed-width diamonds in signal; squares here
        ctx.fillRect(x, y, noteHeight, noteHeight);
      } else {
        const width = Math.max(2, event.duration * pixelsPerTick - 1);

        ctx.fillRect(x, y, width, noteHeight);
      }
    }
  }

  // playhead
  ctx.globalAlpha = 1;
  ctx.fillStyle = primary;
  ctx.fillRect(position * pixelsPerTick - 1, 0, 2, cssHeight);
}

export interface PianoRollSignature {
  Args: {
    song: Song;
    player: Player;
    trackMute: TrackMute;
  };
}

export class PianoRoll extends Component<PianoRollSignature> {
  seek = (event: MouseEvent): void => {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const { song, player } = this.args;
    const totalTicks = Math.max(song.lastEventTick + song.timebase * 4, 1);
    const fraction = event.offsetX / canvas.clientWidth;

    player.position = fraction * totalTicks;
  };

  render = modifier((canvas: HTMLCanvasElement) => {
    // consumed here so the modifier re-runs when they change
    const { song, player, trackMute } = this.args;
    const position = player.position;

    const redraw = () => draw(canvas, song, position, trackMute);

    redraw();

    const observer = new ResizeObserver(redraw);

    observer.observe(canvas);

    return () => observer.disconnect();
  });

  <template>
    <div class="surface elevation-md piano-roll">
      <canvas
        class="piano-roll__canvas"
        height={{HEIGHT}}
        aria-label="Piano roll — click to seek"
        {{this.render}}
        {{on "click" this.seek}}
      ></canvas>
    </div>
  </template>
}
