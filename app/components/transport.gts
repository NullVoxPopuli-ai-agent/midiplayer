import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { Button } from "nvp.ui";

import { getMBTString } from "#app/midi/measure.ts";
import { SYNTH_OUTPUT_ID } from "#services/player.ts";
import { preventDefault } from "#utils/prevent-default.ts";

import type EditorService from "#services/editor.ts";
import type PlayerService from "#services/player.ts";

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function eq(a: string, b: string): boolean {
  return a === b;
}

export class Transport extends Component {
  @service declare player: PlayerService;
  @service declare editor: EditorService;

  playPause = (): void => {
    this.player.player?.playOrPause();
  };

  toggleRecording = (): void => {
    void this.editor.toggleRecording();
  };

  stop = (): void => {
    this.player.player?.reset();
  };

  seek = (event: Event): void => {
    const player = this.player.player;

    if (!player) return;

    player.position = Number((event.target as HTMLInputElement).value);
  };

  setVolume = (event: Event): void => {
    this.player.setVolume(Number((event.target as HTMLInputElement).value));
  };

  toggleLoop = (): void => {
    this.player.toggleLoop();
  };

  clearLoop = (): void => {
    this.player.clearLoop();
  };

  toggleMetronome = (): void => {
    this.player.toggleMetronome();
  };

  refreshOutputs = (): void => {
    void this.player.refreshMidiOutputs();
  };

  selectOutput = (event: Event): void => {
    this.player.selectOutput((event.target as HTMLSelectElement).value);
  };

  get playing(): boolean {
    return this.player.player?.isPlaying ?? false;
  }

  get position(): number {
    return this.player.player?.position ?? 0;
  }

  get endOfSong(): number {
    return this.player.song?.endOfSong ?? 0;
  }

  get mbt(): string {
    const song = this.player.song;

    if (!song) return "0001:01:000";

    return getMBTString(song.measures, this.position, song.timebase);
  }

  get time(): string {
    const song = this.player.song;

    if (!song) return "0:00 / 0:00";

    return `${formatTime(song.secondsAt(this.position))} / ${formatTime(
      song.secondsAt(song.lastEventTick),
    )}`;
  }

  get bpm(): string {
    return (this.player.player?.currentTempo ?? 120).toFixed(0);
  }

  get hasLoop(): boolean {
    return this.player.loop !== null;
  }

  get loopEnabled(): boolean {
    return this.player.loop?.enabled ?? false;
  }

  <template>
    <form class="surface elevation-md transport" {{on "submit" preventDefault}}>
      <div class="transport__buttons">
        <Button @variant="primary" @onClick={{this.playPause}}>
          <span aria-hidden="true">{{if this.playing "❚❚" "▶"}}</span>
          <span class="sr-only">{{if this.playing "Pause" "Play"}}</span>
        </Button>
        <Button @onClick={{this.stop}}>
          <span aria-hidden="true">■</span>
          <span class="sr-only">Stop and rewind</span>
        </Button>
        {{#if this.hasLoop}}
          {{! a real toggle needs aria-pressed, which nvp.ui Button
              can't render yet (see nvp.ui button-pressed-state PR) }}
          <button
            type="button"
            class="preem__button transport__toggle"
            aria-pressed="{{this.loopEnabled}}"
            aria-label="Toggle loop"
            {{on "click" this.toggleLoop}}
          >
            ⟲
          </button>
          <Button @onClick={{this.clearLoop}}>
            <span aria-hidden="true">⟲✕</span>
            <span class="sr-only">Clear loop</span>
          </Button>
        {{else}}
          <Button @disabled="Drag the piano roll ruler to set a loop range first">
            <span aria-hidden="true">⟲</span>
            <span class="sr-only">Toggle loop</span>
          </Button>
        {{/if}}
        <button
          type="button"
          class="preem__button transport__toggle"
          aria-pressed="{{this.player.metronomeEnabled}}"
          aria-label="Toggle metronome"
          {{on "click" this.toggleMetronome}}
        >
          🜛
        </button>
        <button
          type="button"
          class="preem__button transport__toggle transport__record"
          aria-pressed="{{this.editor.isRecording}}"
          aria-label="Record from MIDI input onto the edited track"
          {{on "click" this.toggleRecording}}
        >
          ●
        </button>
      </div>

      {{#if this.editor.recordingStatus}}
        <span class="transport__rec-status" role="status">{{this.editor.recordingStatus}}</span>
      {{/if}}

      <output class="transport__mbt" aria-label="Position (measure:beat:tick)">
        {{this.mbt}}
      </output>
      <output class="transport__time" aria-label="Time">{{this.time}}</output>
      <output class="transport__bpm" aria-label="Tempo">{{this.bpm}} BPM</output>

      <input
        class="transport__seek"
        type="range"
        min="0"
        max={{this.endOfSong}}
        value={{this.position}}
        aria-label="Song position"
        {{on "input" this.seek}}
      />

      <label class="transport__volume">
        <span aria-hidden="true">🔊</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={{this.player.volume}}
          aria-label="Volume"
          {{on "input" this.setVolume}}
        />
      </label>

      <label class="transport__output">
        Output
        <select
          aria-label="MIDI output"
          {{on "focus" this.refreshOutputs}}
          {{on "change" this.selectOutput}}
        >
          <option
            value={{SYNTH_OUTPUT_ID}}
            selected={{eq this.player.selectedOutputId SYNTH_OUTPUT_ID}}
          >
            Built-in synth
          </option>
          {{#each this.player.midiOutputs as |output|}}
            <option value={{output.id}} selected={{eq this.player.selectedOutputId output.id}}>
              {{output.name}}
            </option>
          {{/each}}
        </select>
      </label>
    </form>
  </template>
}
