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
    () => [{ boundary: true }],
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

module("Unit | midi | event-scheduler | loop", function () {
  test("wraps the window at loop.end back to loop.begin", function (assert) {
    // 120bpm: 48 ticks per 50ms; look-ahead 100ms = 96 ticks
    const events = [{ tick: 100 }, { tick: 950 }, { tick: 970 }];
    const scheduler = schedulerFor(events, 900);

    scheduler.loop = { begin: 96, end: 960 };

    // window [900, 996) crosses 960 → head [900,960), boundary (tick
    // assigned = loop.begin), then [96, 96+36)
    const result = scheduler.readNextEvents(120, 1000);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [950, 96, 100],
      "events before the boundary, loop-end events, then events from loop.begin",
    );
  });

  test("the boundary events fire exactly at the loop end's timestamp", function (assert) {
    const scheduler = schedulerFor([], 900);

    scheduler.loop = { begin: 0, end: 960 };

    const result = scheduler.readNextEvents(120, 1000);
    const boundary = result.find((r) => "boundary" in r.event);

    // 60 ticks until the boundary at 120bpm/480tpb = 62.5ms
    assert.strictEqual(boundary?.timestamp, 1062.5);
  });

  test("position rewinds into loop coordinates and stays continuous", function (assert) {
    const scheduler = schedulerFor([], 900);

    scheduler.loop = { begin: 0, end: 960 };

    scheduler.readNextEvents(120, 1000);
    // at wrap time the position sits before loop.begin (wall-clock
    // continuity): 0 - (960 - 900) = -60
    assert.strictEqual(scheduler.currentTick, -60);

    // 100ms = 96 ticks later, it has crossed into the loop body
    scheduler.readNextEvents(120, 1100);
    assert.strictEqual(scheduler.currentTick, 36);
  });

  test("no loop means no wrap", function (assert) {
    const events = [{ tick: 950 }, { tick: 970 }];
    const scheduler = schedulerFor(events, 900);

    const result = scheduler.readNextEvents(120, 1000);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [950, 970],
    );
  });
});

module("Unit | midi | event-scheduler | stall resilience", function () {
  test("a stall longer than the loop restarts at loop.begin instead of killing the loop", function (assert) {
    const events = [{ tick: 100 }, { tick: 500 }];
    const scheduler = schedulerFor(events, 900);

    scheduler.loop = { begin: 0, end: 960 };

    scheduler.readNextEvents(120, 1000);

    // 60s stall: the window is dozens of loop lengths long
    const result = scheduler.readNextEvents(120, 61000);

    assert.deepEqual(
      result.map((r) => r.event.tick),
      [0],
      "only the loop-end (all-notes-off) events fire on the restart read",
    );
    assert.strictEqual(scheduler.scheduledTick, 0, "restarted at loop.begin");

    // the loop is still alive: the next normal read plays from the top
    const next = scheduler.readNextEvents(120, 61050);

    assert.deepEqual(
      next.map((r) => r.event.tick),
      [100],
      "playback continues inside the loop",
    );
  });
});
