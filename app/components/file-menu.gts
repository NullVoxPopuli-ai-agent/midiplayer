import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";
import { Menu } from "nvp.ui/menu";

import { preventDefault } from "#utils/prevent-default.ts";

import type EditorService from "#services/editor.ts";
import type HistoryService from "#services/history.ts";
import type PlayerService from "#services/player.ts";

/**
 * signal's File menu, living in the app header.
 */
export class FileMenu extends Component {
  @service declare player: PlayerService;
  @service declare editor: EditorService;
  @service declare history: HistoryService;

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

    // allow re-selecting the same file later
    input.value = "";

    void this.load(this.player.loadFile(file));
  };

  newSong = (): void => void this.load(this.player.newSong());
  loadDemo = (): void => void this.load(this.player.loadDemoSong());
  loadLast = (): void => void this.load(this.player.loadLastSong());

  exportMidi = (): void => {
    this.player.exportMidi();
  };

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

  <template>
    <form class="file-menu" {{on "submit" preventDefault}}>
      <Menu @variant="primary" as |m|>
        <m.Trigger>File</m.Trigger>
        <m.Content as |c|>
          <c.Item @onSelect={{this.newSong}}>New song</c.Item>
          <c.Item @onSelect={{this.openFilePicker}}>Open .mid file…</c.Item>
          {{#if this.player.lastFile}}
            <c.Item @onSelect={{this.loadLast}}>
              Resume
              {{this.player.lastFile.name}}
            </c.Item>
          {{/if}}
          {{#if this.player.song}}
            <c.Item @onSelect={{this.exportMidi}}>Export .mid</c.Item>
          {{/if}}
          <c.Separator />
          <c.Item @onSelect={{this.loadDemo}}>Play the demo song</c.Item>
        </m.Content>
      </Menu>

      <input
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        hidden
        aria-label="Open a MIDI file"
        {{this.registerFileInput}}
        {{on "change" this.onFile}}
      />
    </form>
  </template>
}
