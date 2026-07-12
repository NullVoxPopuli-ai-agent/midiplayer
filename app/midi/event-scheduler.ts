import { millisecToTick, tickToMillisec } from "./tick.ts";

export interface SchedulableEvent {
  tick: number;
}

export interface ScheduledEvent<E extends SchedulableEvent> {
  event: E;
  /** absolute performance.now()-based timestamp (ms) at which to fire */
  timestamp: number;
}

/**
 * Pulls events out of an event source in look-ahead windows, stamping
 * each with an absolute wall-clock timestamp.
 *
 * The musical position advances by wall-clock delta at the tempo in
 * effect when each window is read — tempo changes take effect on the
 * next timer tick (50ms granularity), same as signal.
 */
export class EventScheduler<E extends SchedulableEvent> {
  private _currentTick: number;
  private _scheduledTick: number;
  private _prevTime: number | undefined;

  constructor(
    private readonly getEvents: (startTick: number, endTick: number) => E[],
    startTick: number,
    private readonly timebase: number,
    private readonly lookAheadTime: number,
  ) {
    this._currentTick = startTick;
    this._scheduledTick = startTick;
  }

  get currentTick(): number {
    return this._currentTick;
  }

  get scheduledTick(): number {
    return this._scheduledTick;
  }

  seek(tick: number): void {
    this._currentTick = this._scheduledTick = Math.max(0, tick);
  }

  readNextEvents(bpm: number, timestamp: number): ScheduledEvent<E>[] {
    if (this._prevTime === undefined) {
      this._prevTime = timestamp;
    }

    const delta = timestamp - this._prevTime;
    const nowTick = this._currentTick + Math.round(millisecToTick(delta, bpm, this.timebase));

    const startTick = this._scheduledTick;
    const endTick = nowTick + Math.round(millisecToTick(this.lookAheadTime, bpm, this.timebase));

    this._prevTime = timestamp;
    this._currentTick = nowTick;

    if (endTick <= startTick) {
      return [];
    }

    this._scheduledTick = endTick;

    return this.getEvents(startTick, endTick).map((event) => {
      const waitTick = event.tick - nowTick;

      return {
        event,
        timestamp: timestamp + Math.max(0, tickToMillisec(waitTick, bpm, this.timebase)),
      };
    });
  }
}
