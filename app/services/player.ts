import { tracked } from "@glimmer/tracking";
import Service from "@ember/service";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { PlayerEventSource } from "#app/midi/event-source.ts";
import { GroupOutput } from "#app/midi/group-output.ts";
import { Player } from "#app/midi/player.ts";
import { songFromMidi } from "#app/midi/song.ts";
import { TrackMute } from "#app/midi/track-mute.ts";
import { WaveletSynth } from "#app/midi/wavelet-synth.ts";
import { WebMidiOutput } from "#app/midi/web-midi-output.ts";
import { cachedFetch, loadLastFile, saveLastFile } from "#utils/local-files.ts";

import type { LoopSetting } from "#app/midi/event-scheduler.ts";
import type { Song } from "#app/midi/song.ts";
import type { StoredFile } from "#utils/local-files.ts";

/**
 * The GM + drums soundfonts signal ships (A320U, "Signal Factory Sound").
 */
const SOUNDFONT_URL = "https://cdn.jsdelivr.net/gh/ryohey/signal@4569a31/public/A320U.sf2";
const DRUMS_SOUNDFONT_URL =
  "https://cdn.jsdelivr.net/gh/ryohey/signal@6959f35/public/A320U_drums.sf2";

export type SoundFontStatus = "idle" | "loading" | "ready" | "error";

export const SYNTH_OUTPUT_ID = "synth";

export default class PlayerService extends Service {
  @tracked song: Song | null = null;
  @tracked fileName: string | null = null;
  @tracked player: Player | null = null;
  @tracked eventSource: PlayerEventSource | null = null;

  @tracked soundFontStatus: SoundFontStatus = "idle";
  @tracked soundFontProgress = 0; // 0..1
  @tracked error: string | null = null;

  @tracked volume = 1;

  @tracked lastFile: StoredFile | null = null;

  /** "synth" or a Web MIDI output id */
  @tracked selectedOutputId: string = SYNTH_OUTPUT_ID;
  @tracked midiOutputs: MIDIOutput[] = [];

  readonly trackMute = new TrackMute();

  private groupOutput = new GroupOutput(this.trackMute);
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private mainSynth: WaveletSynth | null = null;
  private synthReady: Promise<WaveletSynth> | null = null;
  private midiAccess: MIDIAccess | null = null;

  constructor(...args: ConstructorParameters<typeof Service>) {
    super(...args);
    void loadLastFile().then((file) => (this.lastFile = file));
  }

  willDestroy(): void {
    super.willDestroy();
    this.player?.teardown();
  }

  async loadFile(file: File): Promise<void> {
    const data = await file.arrayBuffer();

    await this.useSong(songFromMidi(data), file.name);
    this.lastFile = { name: file.name, data };
    void saveLastFile(this.lastFile);
  }

  async loadLastSong(): Promise<void> {
    const file = this.lastFile;

    if (!file) return;

    await this.useSong(songFromMidi(file.data), file.name);
  }

  async loadDemoSong(): Promise<void> {
    await this.useSong(createDemoSong(), "Demo Song (generated)");
  }

  setVolume(value: number): void {
    this.volume = value;

    if (this.masterGain) {
      this.masterGain.gain.value = value;
    }
  }

  // -- metronome ----------------------------------------------------

  get metronomeEnabled(): boolean {
    return this.eventSource?.enableMetronome ?? false;
  }

  toggleMetronome(): void {
    if (this.eventSource) {
      this.eventSource.enableMetronome = !this.eventSource.enableMetronome;
    }
  }

  // -- loop ---------------------------------------------------------

  get loop(): LoopSetting | null {
    return this.player?.loop ?? null;
  }

  setLoopRange(begin: number, end: number): void {
    if (!this.player) return;

    this.player.loop = {
      begin: Math.min(begin, end),
      end: Math.max(begin, end),
      enabled: true,
    };
  }

  toggleLoop(): void {
    const player = this.player;

    if (!player?.loop) return;

    player.loop = { ...player.loop, enabled: !player.loop.enabled };
  }

  clearLoop(): void {
    if (this.player) {
      this.player.loop = null;
    }
  }

  // -- output routing -----------------------------------------------

  async refreshMidiOutputs(): Promise<void> {
    try {
      this.midiAccess ??= await navigator.requestMIDIAccess();
      this.midiOutputs = [...this.midiAccess.outputs.values()];
    } catch {
      this.midiOutputs = [];
    }
  }

  selectOutput(id: string): void {
    this.selectedOutputId = id;
    this.applyOutputSelection();
  }

  // -- internals ----------------------------------------------------

  private applyOutputSelection(): void {
    if (this.selectedOutputId === SYNTH_OUTPUT_ID) {
      this.groupOutput.outputs = this.mainSynth ? [this.mainSynth] : [];

      return;
    }

    const port = this.midiOutputs.find((output) => output.id === this.selectedOutputId);

    if (port) {
      this.player?.allSoundsOff();
      this.groupOutput.outputs = [new WebMidiOutput(port)];
    }
  }

  private async useSong(song: Song, name: string): Promise<void> {
    this.error = null;

    try {
      await this.ensureSynth();
    } catch (error) {
      this.soundFontStatus = "error";
      this.error = `Could not load the soundfont: ${
        error instanceof Error ? error.message : String(error)
      }`;

      throw error;
    }

    this.player?.teardown();
    this.trackMute.reset();

    this.song = song;
    this.fileName = name;
    this.eventSource = new PlayerEventSource(song);
    this.player = new Player(this.groupOutput, this.eventSource);
  }

  /**
   * Create the AudioContext, worklet, and both synths (main +
   * metronome, like signal), and download the soundfonts — once.
   * Must first be called from a user gesture (loading a file /
   * clicking the demo button) so the AudioContext is allowed to start.
   */
  private ensureSynth(): Promise<WaveletSynth> {
    this.synthReady ??= (async () => {
      const context = (this.audioContext ??= new AudioContext());

      if (!this.masterGain) {
        this.masterGain = context.createGain();
        this.masterGain.gain.value = this.volume;
        this.masterGain.connect(context.destination);
      }

      const main = new WaveletSynth(context, this.masterGain);
      const metronome = new WaveletSynth(context, this.masterGain);

      await main.setup();

      this.soundFontStatus = "loading";

      const [mainFont, drumsFont] = await Promise.all([
        cachedFetch(SOUNDFONT_URL, (fraction) => (this.soundFontProgress = fraction)),
        cachedFetch(DRUMS_SOUNDFONT_URL),
      ]);

      main.loadSoundFont(mainFont);
      metronome.loadSoundFont(drumsFont);

      this.soundFontStatus = "ready";
      this.mainSynth = main;
      this.groupOutput.metronomeOutput = metronome;
      this.applyOutputSelection();

      return main;
    })().catch((error: unknown) => {
      // allow retrying after a failed download
      this.synthReady = null;

      throw error;
    });

    return this.synthReady;
  }
}

declare module "@ember/service" {
  interface Registry {
    player: PlayerService;
  }
}
