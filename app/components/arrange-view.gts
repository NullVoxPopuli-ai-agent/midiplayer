import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";

import { isNoteEvent } from "#app/midi/note-assembler.ts";

import { trackColor } from "./track-color.ts";

import type EditorService from "#services/editor.ts";
import type PlayerService from "#services/player.ts";

const ROW_HEIGHT = 22;

/**
 * Whole-song overview (signal's arrange view, reduced to navigation):
 * one row per track with note-density marks, fit to the viewport
 * width. Click a row to select that track and seek.
 */
export class ArrangeView extends Component {
  @service declare player: PlayerService;
  @service declare editor: EditorService;

  private canvas: HTMLCanvasElement | null = null;

  onClick = (event: MouseEvent): void => {
    const song = this.player.song;
    const canvas = this.canvas;

    if (!song || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
    const track = song.playableTracks[row];

    if (track) this.editor.selectTrack(track.id);

    const fraction = (event.clientX - rect.left) / rect.width;
    const player = this.player.player;

    if (player) {
      player.position = fraction * song.endOfSong;
    }
  };

  setup = modifier((canvas: HTMLCanvasElement) => {
    this.canvas = canvas;

    const observer = new ResizeObserver(() => this.draw(canvas));

    observer.observe(canvas);

    return () => {
      observer.disconnect();
      this.canvas = null;
    };
  });

  /** consumes tracked state (position, selection, notes) → auto-redraws */
  react = modifier(() => {
    if (this.canvas) this.draw(this.canvas);
  });

  /** consumed reactive state lives in draw(), called from the modifier */
  private draw(canvas: HTMLCanvasElement): void {
    const song = this.player.song;
    const position = this.player.player?.position ?? 0;
    const selected = this.editor.selectedTrack;

    if (!song) return;

    const tracks = song.playableTracks;
    const cssWidth = canvas.clientWidth;
    const cssHeight = tracks.length * ROW_HEIGHT;

    if (cssWidth === 0) return;

    canvas.style.height = `${cssHeight}px`;

    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const style = getComputedStyle(canvas);
    const textColor = style.getPropertyValue("--color-text").trim() || "#888";
    const primary = style.getPropertyValue("--color-primary").trim() || "#09f";
    const totalTicks = Math.max(song.endOfSong, 1);

    tracks.forEach((track, row) => {
      const y = row * ROW_HEIGHT;

      // row background; selected row tinted
      ctx.globalAlpha = track === selected ? 0.16 : 0.05;
      ctx.fillStyle = track === selected ? primary : textColor;
      ctx.fillRect(0, y, cssWidth, ROW_HEIGHT - 2);

      // note range within the row: pitch mapped into the row height
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = trackColor(track.id);

      for (const event of track.events) {
        if (!isNoteEvent(event)) continue;

        const x = (event.tick / totalTicks) * cssWidth;
        const w = Math.max(1, (event.duration / totalTicks) * cssWidth);
        const pitchFraction = 1 - event.noteNumber / 127;
        const noteY = y + 3 + pitchFraction * (ROW_HEIGHT - 8);

        ctx.fillRect(x, noteY, w, 2);
      }
    });

    // playhead
    ctx.globalAlpha = 1;
    ctx.fillStyle = primary;
    ctx.fillRect((position / totalTicks) * cssWidth - 1, 0, 2, cssHeight);
  }

  <template>
    {{! template-lint-disable no-invalid-interactive }}
    <div class="surface elevation-sm arrange-view">
      <canvas
        class="arrange-view__canvas"
        aria-label="Song overview — click to select a track and seek"
        {{this.setup}}
        {{this.react}}
        {{on "click" this.onClick}}
      ></canvas>
    </div>
  </template>
}
