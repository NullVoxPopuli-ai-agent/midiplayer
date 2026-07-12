import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { PianoRoll } from "./piano-roll.gts";
import { TrackList } from "./track-list.gts";
import { Transport } from "./transport.gts";

import type PlayerService from "#services/player.ts";

export class MidiPlayer extends Component {
  @service declare player: PlayerService;

  @tracked loadError: string | null = null;

  onFile = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    // allow re-selecting the same file later
    input.value = "";

    void this.load(this.player.loadFile(file));
  };

  loadDemo = (): void => {
    void this.load(this.player.loadDemoSong());
  };

  private async load(promise: Promise<void>): Promise<void> {
    this.loadError = null;

    try {
      await promise;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  get soundFontPercent(): string {
    return `${Math.round(this.player.soundFontProgress * 100)}%`;
  }

  <template>
    <div class="surface elevation-md picker">
      <label class="preem__button picker__file" data-variant="primary">
        Open .mid file
        <input
          type="file"
          accept=".mid,.midi,audio/midi,audio/x-midi"
          hidden
          {{on "change" this.onFile}}
        />
      </label>

      <button type="button" class="preem__button" {{on "click" this.loadDemo}}>
        Play the demo song
      </button>

      {{#if this.player.fileName}}
        <span class="picker__file-name">{{this.player.fileName}}</span>
      {{/if}}

      {{#if (eq this.player.soundFontStatus "loading")}}
        <span class="picker__status" role="status">
          Downloading soundfont (A320U, ~9.7 MB)…
          {{this.soundFontPercent}}
        </span>
      {{/if}}

      {{#if this.loadError}}
        <span class="picker__status picker__status--error" role="alert">
          {{this.loadError}}
        </span>
      {{/if}}
    </div>

    {{#if this.player.song}}
      {{#if this.player.player}}
        <Transport />
        <PianoRoll
          @song={{this.player.song}}
          @player={{this.player.player}}
          @trackMute={{this.player.trackMute}}
        />
        <TrackList />
      {{/if}}
    {{else}}
      <div class="surface elevation-sm empty-state">
        <p>
          Load a Standard MIDI File (.mid) — or try the generated demo song — and it will play in
          your browser through the same soundfont synth engine as
          <a href="https://github.com/ryohey/signal">ryohey/signal</a>.
        </p>
        <p>
          Nothing is uploaded anywhere: parsing, scheduling, and synthesis all happen locally.
        </p>
      </div>
    {{/if}}
  </template>
}

function eq(a: string, b: string): boolean {
  return a === b;
}
