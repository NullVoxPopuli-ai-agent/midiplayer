import { tracked } from "@glimmer/tracking";
import Service from "@ember/service";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { PlayerEventSource } from "#app/midi/event-source.ts";
import { GroupOutput } from "#app/midi/group-output.ts";
import { Player } from "#app/midi/player.ts";
import { emptySong, songFromMidi, songToMidi } from "#app/midi/song.ts";
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
  /** last song-load failure, shown in the status strip */
  @tracked loadError: string | null = null;

  @tracked volume = 1;

  @tracked lastFile: StoredFile | null = null;

  /**
   * Bumped when the USER loads a song (not on undo/redo restores) —
   * lets the piano roll reset its scroll only for genuinely new songs.
   */
  @tracked songGeneration = 0;

  /** "synth" or a Web MIDI output id */
  @tracked selectedOutputId: string = SYNTH_OUTPUT_ID;
  @tracked midiOutputs: MIDIOutput[] = [];
  @tracked midiInputs: MIDIInput[] = [];

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

  async newSong(): Promise<void> {
    await this.useSong(emptySong(), "untitled.mid");
  }

  /**
   * Swap in a restored song (undo/redo) without resetting transport or
   * mute state.
   */
  restoreSong(song: Song): void {
    const position = this.player?.position ?? 0;
    const wasPlaying = this.player?.isPlaying ?? false;
    const metronome = this.eventSource?.enableMetronome ?? false;
    const loop = this.player?.loop ?? null;

    this.player?.teardown();

    this.song = song;
    this.eventSource = new PlayerEventSource(song);
    this.eventSource.enableMetronome = metronome;
    this.player = new Player(this.groupOutput, this.eventSource);
    // the restored song may have shrunk past the loop (e.g. undoing a
    // paste at the end) — a loop beyond endOfSong would never wrap
    this.player.loop = loop && loop.end <= song.endOfSong ? loop : null;
    this.player.position = Math.min(position, song.endOfSong);

    if (wasPlaying) this.player.play();

    this.markEdited();
  }

  /** download the current song as a .mid file */
  exportMidi(): void {
    const song = this.song;

    if (!song) return;

    const bytes = songToMidi(song);
    const blob = new Blob([bytes.slice().buffer], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = this.fileName ?? "song.mid";
    link.click();
    URL.revokeObjectURL(url);
  }

  private autosaveTimer: number | null = null;

  /** debounce-persist the edited song so "Resume" restores edits */
  markEdited(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);

    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;

      const song = this.song;

      if (!song) return;

      const data = songToMidi(song).slice().buffer;

      this.lastFile = { name: this.fileName ?? "untitled.mid", data };
      void saveLastFile(this.lastFile);
    }, 1000);
  }

  /** send a state event (program/controller change) to the output now */
  sendLiveEvent(event: Parameters<GroupOutput["sendEvent"]>[0]): void {
    this.groupOutput.sendEvent(event, 0, -1);
  }

  /** short audition blip when drawing notes in the editor */
  previewNote(channel: number, noteNumber: number): void {
    const synth = this.mainSynth;

    if (!synth) return;

    synth.activate();
    synth.sendEvent({ type: "channel", subtype: "noteOn", channel, noteNumber, velocity: 100 }, 0);
    synth.sendEvent({ type: "channel", subtype: "noteOff", channel, noteNumber, velocity: 0 }, 0.3);
  }

  setVolume(value: number): void {
    this.volume = value;

    if (this.masterGain) {
      this.masterGain.gain.value = value;
    }
  }

  // -- mute / solo ----------------------------------------------------

  /**
   * Mute/solo toggles flush sounding notes: GroupOutput drops a muted
   * track's events at send time — including pending noteOffs — so
   * without this, notes ring forever (signal flushes on mute changes
   * too).
   */
  toggleMute(trackId: number): void {
    this.trackMute.toggleMute(trackId);
    this.flushIfPlaying();
  }

  toggleSolo(trackId: number): void {
    this.trackMute.toggleSolo(trackId);
    this.flushIfPlaying();
  }

  private flushIfPlaying(): void {
    if (this.player?.isPlaying) {
      this.player.allSoundsOff();
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
      this.midiOutputs = Array.from(this.midiAccess.outputs.values());
      this.midiInputs = Array.from(this.midiAccess.inputs.values());
    } catch {
      this.midiOutputs = [];
      this.midiInputs = [];
    }
  }

  selectOutput(id: string): void {
    this.selectedOutputId = id;
    this.applyOutputSelection();
  }

  // -- internals ----------------------------------------------------

  private applyOutputSelection(): void {
    // silence the OLD output before swapping, or its held notes stick
    // (especially external MIDI hardware nothing will address again)
    this.player?.allSoundsOff();

    if (this.selectedOutputId === SYNTH_OUTPUT_ID) {
      this.groupOutput.outputs = this.mainSynth ? [this.mainSynth] : [];

      return;
    }

    const port = this.midiOutputs.find((output) => output.id === this.selectedOutputId);

    if (port) {
      this.groupOutput.outputs = [new WebMidiOutput(port)];
    }
  }

  private async useSong(song: Song, name: string): Promise<void> {
    this.error = null;

    // a pending autosave of the PREVIOUS song must not fire after the
    // new one loads — it would overwrite the Resume slot
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }

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
    this.songGeneration++;
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
