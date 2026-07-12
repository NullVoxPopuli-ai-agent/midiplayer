import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { trackColor } from "./track-color.ts";

import type { Track } from "#app/midi/song.ts";
import type PlayerService from "#services/player.ts";

function trackLabel(track: Track): string {
  if (track.name) return track.name;
  if (track.isRhythmTrack) return "Drums";

  return `Track ${track.id}`;
}

export class TrackList extends Component {
  @service declare player: PlayerService;

  toggleMute = (track: Track): void => {
    this.player.trackMute.toggleMute(track.id);
  };

  toggleSolo = (track: Track): void => {
    this.player.trackMute.toggleSolo(track.id);
  };

  <template>
    <ul class="surface elevation-md track-list">
      {{#each this.player.song.playableTracks as |track|}}
        <li class="track-list__track">
          <svg class="track-list__swatch" viewBox="0 0 10 10" aria-hidden="true">
            <circle cx="5" cy="5" r="5" fill={{trackColor track.id}} />
          </svg>
          <span class="track-list__name">{{trackLabel track}}</span>
          <span class="track-list__meta">
            ch
            {{track.channel}}
            ·
            {{track.noteCount}}
            notes
          </span>
          <span class="track-list__controls">
            <button
              type="button"
              class="preem__button track-list__toggle"
              aria-pressed="{{this.player.trackMute.isMuted track.id}}"
              aria-label="Mute {{trackLabel track}}"
              {{on "click" (fn this.toggleMute track)}}
            >M</button>
            <button
              type="button"
              class="preem__button track-list__toggle"
              aria-pressed="{{this.player.trackMute.isSolo track.id}}"
              aria-label="Solo {{trackLabel track}}"
              {{on "click" (fn this.toggleSolo track)}}
            >S</button>
          </span>
        </li>
      {{/each}}
    </ul>
  </template>
}
