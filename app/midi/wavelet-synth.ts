import { getSampleEventsFromSoundFont } from "@ryohey/wavelet";
// Vite serves/emits the pre-bundled AudioWorklet module as an asset
import processorUrl from "@ryohey/wavelet/dist/processor.js?url";

import type { SendableEvent, SynthOutput } from "./types.ts";
import type { SynthEvent } from "@ryohey/wavelet";

/**
 * @ryohey/wavelet's AudioWorklet soundfont synth, wrapped in signal's
 * SynthOutput interface. delayTime is converted from seconds to sample
 * frames, which is what the worklet's scheduler expects.
 */
export class WaveletSynth implements SynthOutput {
  readonly context: AudioContext;

  private node: AudioWorkletNode | null = null;
  private gain: GainNode;
  private sequenceNumber = 0;
  private isSetup = false;

  constructor() {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  get volume(): number {
    return this.gain.gain.value;
  }

  set volume(value: number) {
    this.gain.gain.value = value;
  }

  async setup(): Promise<void> {
    if (this.isSetup) return;

    await this.context.audioWorklet.addModule(processorUrl);
    this.isSetup = true;
  }

  loadSoundFont(data: ArrayBuffer): void {
    this.node?.disconnect();
    this.sequenceNumber = 0;

    this.node = new AudioWorkletNode(this.context, "synth-processor", {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    this.node.connect(this.gain);

    for (const { event, transfer } of getSampleEventsFromSoundFont(new Uint8Array(data))) {
      this.postSynthMessage(event, transfer);
    }
  }

  activate(): void {
    void this.context.resume();
  }

  sendEvent(event: SendableEvent, delayTimeSeconds = 0): void {
    if (event.type !== "channel") {
      // the wavelet processor only understands channel events
      return;
    }

    this.postSynthMessage({
      type: "midi",
      midi: event,
      delayTime: delayTimeSeconds * this.context.sampleRate,
    });
  }

  private postSynthMessage(event: SynthEvent, transfer?: Transferable[]): void {
    this.node?.port.postMessage(
      { ...event, sequenceNumber: this.sequenceNumber++ },
      transfer ?? [],
    );
  }
}
