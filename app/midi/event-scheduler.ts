import { millisecToTick, tickToMillisec } from "./tick.ts";

export interface SchedulableEvent {
  tick: number;
}

export interface SchedulerLoop {
  begin: number;
  end: number;
}

/** the Player-level loop setting (the scheduler itself has no "enabled") */
export interface LoopSetting extends SchedulerLoop {
  enabled: boolean;
}

export interface ScheduledEvent<E extends SchedulableEvent> {
  event: E;
  /** absolute performance.now()-based timestamp (ms) at which to fire */
  timestamp: number;
}

/**
 * Pulls events out of an event source in look-ahead windows, stamping
 * each with an absolute wall-clock timestamp — a direct port of
 * signal's EventScheduler.
 *
 * The musical position advances by wall-clock delta at the tempo in
 * effect when each window is read; tempo changes take effect on the
 * next timer tick (50ms granularity), same as signal.
 *
 * When a loop is set and the window reaches loop.end, the remaining
 * window wraps to loop.begin: loop-end events (all-notes-off, supplied
 * by the caller) fire at the boundary, and the position rewinds into
 * loop coordinates (possibly before loop.begin, so that wall-clock
 * continuity is preserved).
 */
export class EventScheduler<E extends SchedulableEvent> {
  loop: SchedulerLoop | null = null;

  private _currentTick: number;
  private _scheduledTick: number;
  private _prevTime: number | undefined;

  constructor(
    private readonly getEvents: (startTick: number, endTick: number) => E[],
    private readonly createLoopEndEvents: () => Omit<E, "tick">[],
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
    const withTimestamp =
      (currentTick: number) =>
      (event: E): ScheduledEvent<E> => ({
        event,
        timestamp:
          timestamp + Math.max(0, tickToMillisec(event.tick - currentTick, bpm, this.timebase)),
      });

    const getEventsInRange = (startTick: number, endTick: number, currentTick: number) =>
      this.getEvents(startTick, endTick).map(withTimestamp(currentTick));

    if (this._prevTime === undefined) {
      this._prevTime = timestamp;
    }

    const delta = timestamp - this._prevTime;
    const deltaTick = Math.max(0, millisecToTick(delta, bpm, this.timebase));
    const nowTick = this._currentTick + deltaTick;
    const lookAheadTick = millisecToTick(this.lookAheadTime, bpm, this.timebase);

    // process from the last scheduled point to the look-ahead time
    const startTick = this._scheduledTick;
    const endTick = nowTick + lookAheadTick;

    this._prevTime = timestamp;

    const loop = this.loop;

    if (loop !== null && startTick < loop.end && endTick >= loop.end) {
      const offset = endTick - loop.end;
      const wrappedEnd = loop.begin + offset;
      // possibly < loop.begin: crosses it exactly when the wall clock
      // crosses loop.end
      const currentTick = loop.begin - (loop.end - nowTick);

      this._currentTick = currentTick;
      this._scheduledTick = wrappedEnd;

      return [
        ...getEventsInRange(startTick, loop.end, nowTick),
        ...this.createLoopEndEvents().map((event) =>
          withTimestamp(currentTick)({ ...event, tick: loop.begin } as E),
        ),
        ...getEventsInRange(loop.begin, wrappedEnd, currentTick),
      ];
    }

    this._currentTick = nowTick;
    this._scheduledTick = endTick;

    return getEventsInRange(startTick, endTick, nowTick);
  }
}
