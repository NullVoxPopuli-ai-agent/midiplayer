import { module, test } from "qunit";

import { bpmFromSetTempo, millisecToTick, tickToMillisec } from "#app/midi/tick.ts";

module("Unit | midi | tick", function () {
  test("one beat at 120bpm is 500ms", function (assert) {
    assert.strictEqual(tickToMillisec(480, 120, 480), 500);
  });

  test("500ms at 120bpm is one beat", function (assert) {
    assert.strictEqual(millisecToTick(500, 120, 480), 480);
  });

  test("conversions round-trip", function (assert) {
    const ms = tickToMillisec(1234, 97, 960);

    assert.true(Math.abs(millisecToTick(ms, 97, 960) - 1234) < 1e-9);
  });

  test("bpm from setTempo microseconds", function (assert) {
    assert.strictEqual(bpmFromSetTempo(500_000), 120);
    assert.strictEqual(bpmFromSetTempo(1_000_000), 60);
  });
});
