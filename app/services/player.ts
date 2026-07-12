import { tracked } from "@glimmer/tracking";
import Service from "@ember/service";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { MutingOutput } from "#app/midi/muting-output.ts";
import { Player } from "#app/midi/player.ts";
import { songFromMidi } from "#app/midi/song.ts";
import { TrackMute } from "#app/midi/track-mute.ts";
import { WaveletSynth } from "#app/midi/wavelet-synth.ts";

import type { Song } from "#app/midi/song.ts";

/**
 * A320U.sf2 ("Signal Factory Sound") — the GM soundfont signal ships.
 */
const SOUNDFONT_URL = "https://cdn.jsdelivr.net/gh/ryohey/signal@4569a31/public/A320U.sf2";

export type SoundFontStatus = "idle" | "loading" | "ready" | "error";

export default class PlayerService extends Service {
  @tracked song: Song | null = null;
  @tracked fileName: string | null = null;
  @tracked player: Player | null = null;

  @tracked soundFontStatus: SoundFontStatus = "idle";
  @tracked soundFontProgress = 0; // 0..1
  @tracked error: string | null = null;

  @tracked volume = 1;

  readonly trackMute = new TrackMute();

  private synth: WaveletSynth | null = null;
  private synthReady: Promise<WaveletSynth> | null = null;

  willDestroy(): void {
    super.willDestroy();
    this.player?.teardown();
  }

  async loadFile(file: File): Promise<void> {
    const data = await file.arrayBuffer();

    await this.useSong(songFromMidi(data), file.name);
  }

  async loadDemoSong(): Promise<void> {
    await this.useSong(createDemoSong(), "Demo Song (generated)");
  }

  setVolume(value: number): void {
    this.volume = value;

    if (this.synth) {
      this.synth.volume = value;
    }
  }

  private async useSong(song: Song, name: string): Promise<void> {
    this.error = null;

    let synth: WaveletSynth;

    try {
      synth = await this.ensureSynth();
    } catch (error) {
      this.soundFontStatus = "error";
      this.error = `Could not load the soundfont: ${error instanceof Error ? error.message : String(error)}`;

      throw error;
    }

    this.player?.teardown();
    this.trackMute.reset();

    this.song = song;
    this.fileName = name;
    this.player = new Player(new MutingOutput(synth, this.trackMute), song);
  }

  /**
   * Create the AudioContext + worklet and download the soundfont, once.
   * Must first be called from a user gesture (loading a file / clicking
   * the demo button) so the AudioContext is allowed to start.
   */
  private ensureSynth(): Promise<WaveletSynth> {
    this.synthReady ??= (async () => {
      const synth = new WaveletSynth();

      synth.volume = this.volume;

      await synth.setup();

      this.soundFontStatus = "loading";

      const data = await this.download(SOUNDFONT_URL);

      synth.loadSoundFont(data);

      this.soundFontStatus = "ready";
      this.synth = synth;

      return synth;
    })().catch((error: unknown) => {
      // allow retrying after a failed download
      this.synthReady = null;

      throw error;
    });

    return this.synthReady;
  }

  private async download(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get("content-length") ?? 0);

    if (!response.body || !total) {
      return response.arrayBuffer();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      loaded += value.byteLength;
      this.soundFontProgress = loaded / total;
    }

    const result = new Uint8Array(loaded);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result.buffer;
  }
}

declare module "@ember/service" {
  interface Registry {
    player: PlayerService;
  }
}
