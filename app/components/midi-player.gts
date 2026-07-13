import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";
import { Button } from "nvp.ui";

import { preventDefault } from "#utils/prevent-default.ts";

import { ArrangeView } from "./arrange-view.gts";
import { PianoRoll } from "./piano-roll.gts";
import { TrackList } from "./track-list.gts";
import { Transport } from "./transport.gts";

import type EditorService from "#services/editor.ts";
import type HistoryService from "#services/history.ts";
import type PlayerService from "#services/player.ts";

function isMidiFile(file: File): boolean {
  return /\.midi?$/i.test(file.name) || file.type.includes("midi");
}

function eq(a: string, b: string): boolean {
  return a === b;
}

export class MidiPlayer extends Component {
  @service declare player: PlayerService;
  @service declare editor: EditorService;
  @service declare history: HistoryService;

  @tracked isDragOver = false;

  private fileInput: HTMLInputElement | null = null;

  registerFileInput = modifier((element: HTMLInputElement) => {
    this.fileInput = element;

    return () => (this.fileInput = null);
  });

  openFilePicker = (): void => {
    this.fileInput?.click();
  };

  onFile = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    input.value = "";
    void this.load(this.player.loadFile(file));
  };

  loadDemo = (): void => void this.load(this.player.loadDemoSong());
  loadLast = (): void => void this.load(this.player.loadLastSong());

  /**
   * Window-level handlers: drop a .mid anywhere to load it, space to
   * play/pause, home to rewind.
   */
  globalHandlers = modifier(() => {
    const onDragOver = (event: DragEvent) => {
      if (!(event.dataTransfer?.types ?? []).includes("Files")) return;

      event.preventDefault();
      this.isDragOver = true;
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) this.isDragOver = false;
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      this.isDragOver = false;

      const file = Array.from(event.dataTransfer?.files ?? []).find(isMidiFile);

      if (file) {
        void this.load(this.player.loadFile(file));
      } else if (event.dataTransfer?.files.length) {
        this.player.loadError = "That doesn't look like a .mid file";
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      if (!this.player.player) return;

      const mod = event.ctrlKey || event.metaKey;

      if (mod) {
        switch (event.code) {
          case "KeyZ":
            event.preventDefault();

            if (event.shiftKey) {
              this.history.redo();
            } else {
              this.history.undo();
            }

            return;
          case "KeyY":
            event.preventDefault();
            this.history.redo();

            return;
          case "KeyC":
            event.preventDefault();
            this.editor.copySelection();

            return;
          case "KeyX":
            event.preventDefault();
            this.editor.cutSelection();

            return;
          case "KeyV":
            event.preventDefault();
            this.editor.paste();

            return;
          case "KeyA":
            event.preventDefault();
            this.editor.selectAll();

            return;
          default:
            return;
        }
      }

      switch (event.code) {
        case "Space":
          event.preventDefault();
          this.player.player.playOrPause();

          break;
        case "Home":
          event.preventDefault();
          this.player.player.position = 0;

          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          this.editor.deleteSelection();

          break;
        default:
          break;
      }
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  private async load(promise: Promise<void>): Promise<void> {
    this.player.loadError = null;
    this.history.clear();
    this.editor.clearSelection();

    try {
      await promise;
    } catch (error) {
      this.player.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  get soundFontPercent(): string {
    return `${Math.round(this.player.soundFontProgress * 100)}%`;
  }

  get showStatusStrip(): boolean {
    return Boolean(
      this.player.fileName || this.player.soundFontStatus === "loading" || this.player.loadError,
    );
  }

  <template>
    <div {{this.globalHandlers}} class="midi-player">
      {{#if this.showStatusStrip}}
        <div class="surface elevation-md picker">
          {{#if this.player.fileName}}
            <span class="picker__file-name">{{this.player.fileName}}</span>
          {{/if}}

          {{#if (eq this.player.soundFontStatus "loading")}}
            <span class="picker__status" role="status">
              Downloading soundfont (A320U, ~9.7 MB)…
              {{this.soundFontPercent}}
            </span>
          {{/if}}

          {{#if this.player.loadError}}
            <span class="picker__status picker__status--error" role="alert">
              {{this.player.loadError}}
            </span>
          {{/if}}
        </div>
      {{/if}}

      {{#if this.player.song}}
        {{#if this.player.player}}
          <Transport />
          <ArrangeView />
          <div class="editor-layout">
            <TrackList />
            <PianoRoll
              @song={{this.player.song}}
              @player={{this.player.player}}
              @trackMute={{this.player.trackMute}}
            />
          </div>
        {{/if}}
      {{else}}
        <form class="surface elevation-md empty-state" {{on "submit" preventDefault}}>
          <h2 class="empty-state__title">Play &amp; edit MIDI, right in your browser</h2>
          <p>
            A port of
            <a href="https://github.com/ryohey/signal">ryohey/signal</a>
            to Ember: soundfont synth playback, a piano-roll editor with undo, control curves, a
            metronome, loops, and MIDI recording. Nothing is uploaded anywhere — parsing,
            scheduling, and synthesis all happen locally.
          </p>

          <div class="empty-state__actions">
            <Button @variant="primary" @onClick={{this.loadDemo}}>
              <:start>▶</:start>
              <:text>Play the demo song</:text>
            </Button>
            <Button @onClick={{this.openFilePicker}}>Open a .mid file…</Button>
            {{#if this.player.lastFile}}
              <Button @variant="secondary" @onClick={{this.loadLast}}>
                <:start>↻</:start>
                <:text>Resume {{this.player.lastFile.name}}</:text>
              </Button>
            {{/if}}
          </div>

          <input
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            hidden
            aria-label="Open a MIDI file"
            {{this.registerFileInput}}
            {{on "change" this.onFile}}
          />

          <p class="empty-state__hints">
            …or just drop a .mid file anywhere on this window. Space plays/pauses · Home rewinds ·
            the first play downloads a ~9.7 MB GM soundfont (cached after that).
          </p>
        </form>
      {{/if}}

      {{#if this.isDragOver}}
        <div class="drop-overlay" aria-hidden="true">
          <span class="drop-overlay__label">Drop your .mid file to play it</span>
        </div>
      {{/if}}
    </div>
  </template>
}
