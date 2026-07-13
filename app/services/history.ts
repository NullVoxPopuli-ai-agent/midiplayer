import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";

import { songFromMidi, songToMidi } from "#app/midi/song.ts";

import type EditorService from "#services/editor.ts";
import type PlayerService from "#services/player.ts";

const LIMIT = 64;

/**
 * Snapshot-based undo/redo: each checkpoint is the song serialized as
 * a .mid (signal also snapshots the whole song per undo step). Call
 * push() BEFORE mutating.
 */
export default class HistoryService extends Service {
  @service declare player: PlayerService;
  @service declare editor: EditorService;

  @tracked private undoStack: Uint8Array[] = [];
  @tracked private redoStack: Uint8Array[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  push(): void {
    const song = this.player.song;

    if (!song) return;

    this.undoStack = this.undoStack.slice(-(LIMIT - 1)).concat([songToMidi(song)]);
    this.redoStack = [];
    this.player.markEdited();
  }

  undo(): void {
    const bytes = this.undoStack.at(-1);
    const song = this.player.song;

    if (!bytes || !song) return;

    this.undoStack = this.undoStack.slice(0, -1);
    this.redoStack = this.redoStack.concat([songToMidi(song)]);
    this.restore(bytes);
  }

  redo(): void {
    const bytes = this.redoStack.at(-1);
    const song = this.player.song;

    if (!bytes || !song) return;

    this.redoStack = this.redoStack.slice(0, -1);
    this.undoStack = this.undoStack.concat([songToMidi(song)]);
    this.restore(bytes);
  }

  /**
   * Snapshot restore rebuilds the Song, which regenerates every
   * event/track id — the selection must be cleared HERE, not as a
   * side effect of the piano roll re-rendering, or code running
   * between undo() and the next render operates on stale ids.
   */
  private restore(bytes: Uint8Array): void {
    this.player.restoreSong(songFromMidi(bytes));
    this.editor.clearSelection();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

declare module "@ember/service" {
  interface Registry {
    history: HistoryService;
  }
}
