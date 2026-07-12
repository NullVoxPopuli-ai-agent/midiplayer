import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { Button } from "nvp.ui";

import { GM_INSTRUMENTS } from "#app/midi/gm.ts";
import { preventDefault } from "#utils/prevent-default.ts";

import { trackColor } from "./track-color.ts";

import type { Track } from "#app/midi/song.ts";
import type EditorService from "#services/editor.ts";
import type HistoryService from "#services/history.ts";
import type PlayerService from "#services/player.ts";

function trackLabel(track: Track): string {
  if (track.name) return track.name;
  if (track.isRhythmTrack) return "Drums";

  return `Track ${track.id}`;
}

function isSelected(track: Track, selected: Track | null): boolean {
  return track === selected;
}

function isRenaming(track: Track, id: number | null): boolean {
  return track.id === id;
}

function isProgram(track: Track, index: number): boolean {
  return (track.programNumber ?? 0) === index;
}

function volumeOf(track: Track): number {
  return track.controllerValueAt(7, 0) ?? 100;
}

function panOf(track: Track): number {
  return track.controllerValueAt(10, 0) ?? 64;
}

export class TrackList extends Component {
  @service declare player: PlayerService;
  @service declare editor: EditorService;
  @service declare history: HistoryService;

  @tracked renamingId: number | null = null;

  private sliding = false;

  selectTrack = (track: Track): void => {
    this.editor.selectTrack(track.id);
  };

  addTrack = (): void => {
    this.editor.addTrack();
  };

  removeTrack = (track: Track): void => {
    this.editor.removeTrack(track.id);
  };

  startRename = (track: Track): void => {
    this.renamingId = track.id;
  };

  commitRename = (track: Track, event: Event): void => {
    const value = (event.target as HTMLInputElement).value.trim();

    if (value && value !== track.name) {
      this.editor.renameTrack(track.id, value);
    }

    this.renamingId = null;
  };

  onRenameKey = (track: Track, event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      this.commitRename(track, event);
    } else if (event.key === "Escape") {
      this.renamingId = null;
    }
  };

  setProgram = (track: Track, event: Event): void => {
    this.editor.setProgram(track.id, Number((event.target as HTMLSelectElement).value));
  };

  onSlider = (track: Track, controllerType: number, event: Event): void => {
    if (!this.sliding) {
      this.history.push();
      this.sliding = true;
    }

    this.editor.setTrackController(
      track.id,
      controllerType,
      Number((event.target as HTMLInputElement).value),
    );
  };

  onSliderDone = (): void => {
    this.sliding = false;
  };

  toggleMute = (track: Track): void => {
    this.player.trackMute.toggleMute(track.id);
  };

  toggleSolo = (track: Track): void => {
    this.player.trackMute.toggleSolo(track.id);
  };

  get isLastTrack(): boolean {
    return (this.player.song?.playableTracks.length ?? 0) <= 1;
  }

  <template>
    <form class="surface elevation-md track-list" {{on "submit" preventDefault}}>
      <ul class="track-list__items">
        {{#each this.player.song.playableTracks as |track|}}
          <li
            class="track-list__track
              {{if (isSelected track this.editor.selectedTrack) 'track-list__track--selected'}}"
          >
            <svg class="track-list__swatch" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="5" cy="5" r="5" fill={{trackColor track.id}} />
            </svg>

            {{#if (isRenaming track this.renamingId)}}
              {{! template-lint-disable no-autofocus-attribute }}
              <input
                class="track-list__rename"
                type="text"
                value={{track.name}}
                aria-label="Track name"
                autofocus
                {{on "blur" (fn this.commitRename track)}}
                {{on "keydown" (fn this.onRenameKey track)}}
              />
            {{else}}
              <button
                type="button"
                class="track-list__name"
                aria-label="Edit {{trackLabel track}} in the piano roll"
                aria-pressed="{{isSelected track this.editor.selectedTrack}}"
                {{on "click" (fn this.selectTrack track)}}
              >
                {{trackLabel track}}
              </button>
              <Button @onClick={{fn this.startRename track}}>
                <span aria-hidden="true">✎</span>
                <span class="sr-only">Rename {{trackLabel track}}</span>
              </Button>
            {{/if}}

            {{#if track.isRhythmTrack}}
              <span class="track-list__meta">Drum kit · ch 9</span>
            {{else}}
              <select
                class="track-list__instrument"
                aria-label="Instrument for {{trackLabel track}}"
                {{on "change" (fn this.setProgram track)}}
              >
                {{#each GM_INSTRUMENTS as |instrument index|}}
                  <option value={{index}} selected={{isProgram track index}}>
                    {{instrument}}
                  </option>
                {{/each}}
              </select>
            {{/if}}

            <label class="track-list__slider">
              vol
              <input
                type="range"
                min="0"
                max="127"
                value={{volumeOf track}}
                aria-label="Volume for {{trackLabel track}}"
                {{on "input" (fn this.onSlider track 7)}}
                {{on "change" this.onSliderDone}}
              />
            </label>
            <label class="track-list__slider">
              pan
              <input
                type="range"
                min="0"
                max="127"
                value={{panOf track}}
                aria-label="Pan for {{trackLabel track}}"
                {{on "input" (fn this.onSlider track 10)}}
                {{on "change" this.onSliderDone}}
              />
            </label>

            <span class="track-list__meta">{{track.noteCount}} notes</span>

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
              <Button
                @onClick={{fn this.removeTrack track}}
                @disabled={{if this.isLastTrack "A song needs at least one track"}}
              >
                <span aria-hidden="true">✕</span>
                <span class="sr-only">Delete {{trackLabel track}}</span>
              </Button>
            </span>
          </li>
        {{/each}}
      </ul>

      <Button @onClick={{this.addTrack}}>+ Add track</Button>
    </form>
  </template>
}
