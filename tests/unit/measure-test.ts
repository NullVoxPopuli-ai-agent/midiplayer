import { module, test } from "qunit";

import { getMBTString, measuresFromTimeSignatures } from "#app/midi/measure.ts";

const TIMEBASE = 480;

module("Unit | midi | measure", function () {
  test("defaults to 4/4 starting at measure 0", function (assert) {
    const measures = measuresFromTimeSignatures([], TIMEBASE);

    assert.strictEqual(getMBTString(measures, 0, TIMEBASE), "0001:01:000");
    assert.strictEqual(getMBTString(measures, 480, TIMEBASE), "0001:02:000");
    assert.strictEqual(getMBTString(measures, 480 * 4, TIMEBASE), "0002:01:000");
    assert.strictEqual(getMBTString(measures, 480 * 4 + 481, TIMEBASE), "0002:02:001");
  });

  test("time signature changes shift the measure grid", function (assert) {
    const measures = measuresFromTimeSignatures(
      [
        // 4/4 for 2 measures, then 3/4
        {
          type: "meta",
          subtype: "timeSignature",
          tick: 480 * 8,
          numerator: 3,
          denominator: 4,
          metronome: 24,
          thirtyseconds: 8,
        },
      ],
      TIMEBASE,
    );

    // measure 3 starts at the signature change
    assert.strictEqual(getMBTString(measures, 480 * 8, TIMEBASE), "0003:01:000");
    // a 3/4 measure is now 3 beats long
    assert.strictEqual(getMBTString(measures, 480 * 11, TIMEBASE), "0004:01:000");
  });
});
