import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { getMBTString } from "#app/midi/measure.ts";

import type PlayerService from "#services/player.ts";

export class Transport extends Component {
  @service declare player: PlayerService;

  playPause = (): void => {
    this.player.player?.playOrPause();
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

  get bpm(): string {
    return (this.player.player?.currentTempo ?? 120).toFixed(0);
  }

  <template>
    <div class="surface elevation-md transport">
      <div class="transport__buttons">
        <button
          type="button"
          class="preem__button"
          data-variant="primary"
          aria-label={{if this.playing "Pause" "Play"}}
          {{on "click" this.playPause}}
        >
          {{if this.playing "❚❚" "▶"}}
        </button>
        <button
          type="button"
          class="preem__button"
          aria-label="Stop and rewind"
          {{on "click" this.stop}}
        >
          ■
        </button>
      </div>

      <output class="transport__mbt" aria-label="Position (measure:beat:tick)">
        {{this.mbt}}
      </output>
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
    </div>
  </template>
}
