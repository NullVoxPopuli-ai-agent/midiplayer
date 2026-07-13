import type { SendableEvent, SynthOutput } from "./types.ts";

/**
 * Serialize a channel/sysEx event to raw MIDI bytes.
 * Returns null for events that can't be represented.
 */
export function serializeMidiEvent(event: SendableEvent): number[] | null {
  if (event.type === "sysEx") {
    // midifile-ts stores sysEx data without the leading 0xF0
    return [0xf0, ...event.data];
  }

  if (event.type !== "channel") {
    return null;
  }

  const { channel } = event;

  switch (event.subtype) {
    case "noteOff":
      return [0x80 | channel, event.noteNumber, event.velocity];
    case "noteOn":
      return [0x90 | channel, event.noteNumber, event.velocity];
    case "noteAftertouch":
      return [0xa0 | channel, event.noteNumber, event.amount];
    case "controller":
      return [0xb0 | channel, event.controllerType, event.value];
    case "programChange":
      return [0xc0 | channel, event.value];
    case "channelAftertouch":
      return [0xd0 | channel, event.amount];
    case "pitchBend":
      return [0xe0 | channel, event.value & 0x7f, (event.value >> 7) & 0x7f];
    default:
      return null;
  }
}

/**
 * Sends events to a Web MIDI output device, using the same
 * performance.now()-based timestamps the scheduler produces.
 */
export class WebMidiOutput implements SynthOutput {
  constructor(private readonly port: MIDIOutput) {}

  activate(): void {
    void this.port.open();
  }

  sendEvent(event: SendableEvent, delayTimeSeconds: number): void {
    const bytes = serializeMidiEvent(event);

    if (!bytes) return;

    try {
      this.port.send(bytes, performance.now() + delayTimeSeconds * 1000);
    } catch {
      // ignore malformed events / closed ports rather than killing playback
    }
  }
}
