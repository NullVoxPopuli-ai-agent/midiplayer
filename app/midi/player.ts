import { tracked } from "@glimmer/tracking";

import { EventScheduler } from "./event-scheduler.ts";
import { bpmFromSetTempo, DEFAULT_TEMPO } from "./tick.ts";

import type { LoopSetting } from "./event-scheduler.ts";
import type { IEventSource, PlayerEvent, SynthOutput } from "./types.ts";

const TIMER_INTERVAL = 50;
const LOOK_AHEAD_TIME = 50;

const ALL_SOUNDS_OFF = 120;
const ALL_NOTES_OFF = 123;
const RESET_ALL_CONTROLLERS = 121;
const CHANNEL_COUNT = 16;

// Roland GS reset (data without the leading 0xF0, midifile-ts style)
const GS_RESET = [0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7];

/**
 * Drives playback: a 50ms timer reads events from the event source in
 * 100ms look-ahead windows and forwards them to the synth with a
 * per-event delay. (ported from signal's Player)
 */
export class Player {
  @tracked private _currentTick = 0;
  @tracked private _isPlaying = false;
  @tracked private _currentTempo = DEFAULT_TEMPO;
  @tracked private _loop: LoopSetting | null = null;

  private scheduler: EventScheduler<PlayerEvent> | null = null;
  private interval: number | null = null;

  constructor(
    private readonly output: SynthOutput,
    private readonly eventSource: IEventSource,
  ) {}

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get currentTempo(): number {
    return this._currentTempo;
  }

  get loop(): LoopSetting | null {
    return this._loop;
  }

  set loop(value: LoopSetting | null) {
    this._loop = value;

    if (this.scheduler) {
      this.scheduler.loop = value?.enabled ? value : null;
    }
  }

  get position(): number {
    return this._currentTick;
  }

  set position(tick: number) {
    const clamped = Math.min(Math.max(Math.floor(tick), 0), this.eventSource.endOfSong);

    this.scheduler?.seek(clamped);
    this._currentTick = clamped;
    this._currentTempo = this.bpmAt(clamped);

    if (this._isPlaying) {
      this.allSoundsOff();
    }

    this.sendCurrentStateEvents();
  }

  play(): void {
    if (this._isPlaying) return;

    this.output.activate();

    if (this._currentTick >= this.eventSource.endOfSong) {
      this._currentTick = 0;
    }

    this._currentTempo = this.bpmAt(this._currentTick);
    this.sendCurrentStateEvents();

    this.scheduler = new EventScheduler<PlayerEvent>(
      (start, end) => this.eventSource.getEvents(start, end),
      () => this.createLoopEndEvents(),
      this._currentTick,
      this.eventSource.timebase,
      TIMER_INTERVAL + LOOK_AHEAD_TIME,
    );
    this.scheduler.loop = this._loop?.enabled ? this._loop : null;

    this._isPlaying = true;
    this.interval = window.setInterval(() => this.onTimer(), TIMER_INTERVAL);
  }

  /** stop playback, keeping the current position */
  stop(): void {
    this.scheduler = null;
    this.allSoundsOff();
    this._isPlaying = false;

    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  playOrPause(): void {
    if (this._isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }

  /** stop, reset controllers, and rewind to the beginning */
  reset(): void {
    this.resetControllers();
    this.stop();
    this._currentTick = 0;
    this._currentTempo = this.bpmAt(0);
  }

  resetControllers(): void {
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      this.output.sendEvent(
        {
          type: "channel",
          subtype: "controller",
          channel,
          controllerType: RESET_ALL_CONTROLLERS,
          value: 0x7f,
        },
        0,
        -1,
      );
    }

    this.output.sendEvent({ type: "sysEx", data: GS_RESET }, 0, -1);
  }

  teardown(): void {
    this.stop();
  }

  allSoundsOff(): void {
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      this.output.sendEvent(
        {
          type: "channel",
          subtype: "controller",
          channel,
          controllerType: ALL_SOUNDS_OFF,
          value: 0,
        },
        0,
        -1,
      );
    }
  }

  allNotesOff(): void {
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      this.output.sendEvent(
        {
          type: "channel",
          subtype: "controller",
          channel,
          controllerType: ALL_NOTES_OFF,
          value: 0,
        },
        0,
        -1,
      );
    }
  }

  /** all-notes-off on every channel, fired at the loop boundary */
  private createLoopEndEvents(): Omit<PlayerEvent, "tick">[] {
    return Array.from({ length: CHANNEL_COUNT }, (_, channel) => ({
      type: "channel" as const,
      subtype: "controller" as const,
      channel,
      controllerType: ALL_NOTES_OFF,
      value: 0,
      trackId: -1,
    }));
  }

  private bpmAt(tick: number): number {
    let bpm = DEFAULT_TEMPO;

    for (const event of this.eventSource.getEvents(0, tick + 1)) {
      if (event.type === "meta" && event.subtype === "setTempo") {
        bpm = bpmFromSetTempo(event.microsecondsPerBeat);
      }
    }

    return bpm;
  }

  private sendCurrentStateEvents(): void {
    for (const event of this.eventSource.getCurrentStateEvents(this._currentTick)) {
      this.output.sendEvent(event, 0, -1);
    }
  }

  private applyPlayerEvent(event: PlayerEvent): void {
    if (event.type === "meta" && event.subtype === "setTempo") {
      this._currentTempo = bpmFromSetTempo(event.microsecondsPerBeat);
    }
  }

  private onTimer(): void {
    const scheduler = this.scheduler;

    if (!scheduler) return;

    const timestamp = performance.now();
    const events = scheduler.readNextEvents(this._currentTempo, timestamp);

    for (const { event, timestamp: eventTime } of events) {
      if (event.type === "channel" || event.type === "sysEx" || event.type === "dividedSysEx") {
        const delayTime = (eventTime - timestamp) / 1000;

        this.output.sendEvent(event, delayTime, event.trackId);
      } else {
        this.applyPlayerEvent(event);
      }
    }

    if (scheduler.scheduledTick >= this.eventSource.endOfSong) {
      this.stop();
      this._currentTick = this.eventSource.endOfSong;

      return;
    }

    // after a loop wrap the scheduler's tick may briefly sit before
    // loop.begin (even below 0) to preserve wall-clock continuity
    this._currentTick = Math.max(0, Math.floor(scheduler.currentTick));
  }
}
