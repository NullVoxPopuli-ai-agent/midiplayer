import { getSampleEventsFromSoundFont } from "@ryohey/wavelet";
// Vite serves/emits the pre-bundled AudioWorklet module as an asset
import processorUrl from "@ryohey/wavelet/dist/processor.js?url";

import type { SendableEvent, SynthOutput } from "./types.ts";
import type { SynthEvent } from "@ryohey/wavelet";

const registeredContexts = new WeakSet<AudioContext>();

/**
 * @ryohey/wavelet's AudioWorklet soundfont synth, wrapped in signal's
 * SynthOutput interface. delayTime is converted from seconds to sample
 * frames, which is what the worklet's scheduler expects.
 *
 * Multiple instances (main + metronome, like signal) can share one
 * AudioContext; the worklet module is registered once per context.
 */
export class WaveletSynth implements SynthOutput {
  private node: AudioWorkletNode | null = null;
  private sequenceNumber = 0;

  constructor(
    readonly context: AudioContext,
    private readonly destination: AudioNode,
  ) {}

  async setup(): Promise<void> {
    if (registeredContexts.has(this.context)) return;

    await this.context.audioWorklet.addModule(processorUrl);
    registeredContexts.add(this.context);
  }

  loadSoundFont(data: ArrayBuffer): void {
    this.node?.disconnect();
    this.sequenceNumber = 0;

    this.node = new AudioWorkletNode(this.context, "synth-processor", {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    this.node.connect(this.destination);

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
