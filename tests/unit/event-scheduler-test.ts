import { module, test } from "qunit";

import { EventScheduler } from "#app/midi/event-scheduler.ts";

const TIMEBASE = 480;
const LOOK_AHEAD = 100; // ms

interface Ev {
  tick: number;
}

function schedulerFor(events: Ev[], startTick = 0) {
  return new EventScheduler<Ev>(
    (start, end) => events.filter((e) => e.tick >= start && e.tick < end),
    startTick,
    TIMEBASE,
    LOOK_AHEAD,
  );
}

module("Unit | midi | event-scheduler", function () {
  test("first read schedules the look-ahead window from the start tick", function (assert) {
    // at 120bpm, 100ms = 96 ticks
    const events = [{ tick: 0 }, { tick: 50 }, { tick: 96 }];
    const scheduler = schedulerFor(events);

    const result = scheduler.readNextEvents(120, 1000);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [0, 50],
      "only events inside [0, 96) are read",
    );
  });

  test("events are stamped with absolute timestamps, never in the past", function (assert) {
    const events = [{ tick: 0 }, { tick: 48 }];
    const scheduler = schedulerFor(events);

    const [first, second] = scheduler.readNextEvents(120, 1000);

    // tick 0 is "now"; tick 48 at 120bpm/480tpb = 50ms later
    assert.strictEqual(first?.timestamp, 1000);
    assert.strictEqual(second?.timestamp, 1050);
  });

  test("subsequent reads don't re-dispatch already-scheduled events", function (assert) {
    const events = [{ tick: 0 }, { tick: 50 }, { tick: 96 }, { tick: 200 }];
    const scheduler = schedulerFor(events);

    scheduler.readNextEvents(120, 1000);

    // 50ms later: position is now tick 48, window extends to tick 48+96=144
    const result = scheduler.readNextEvents(120, 1050);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [96],
      "window advances without overlap",
    );
  });

  test("position advances with wall-clock time at the given tempo", function (assert) {
    const scheduler = schedulerFor([]);

    scheduler.readNextEvents(120, 1000);
    scheduler.readNextEvents(120, 1500); // 500ms = 1 beat at 120bpm

    assert.strictEqual(scheduler.currentTick, TIMEBASE);
  });

  test("seek moves both the position and the dispatch high-water mark", function (assert) {
    const events = [{ tick: 0 }, { tick: 960 }];
    const scheduler = schedulerFor(events);

    scheduler.readNextEvents(120, 1000);
    scheduler.seek(960);

    const result = scheduler.readNextEvents(120, 1050);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [960],
      "events at the seek target play; earlier events don't replay",
    );
  });
});
