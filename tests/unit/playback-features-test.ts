import { module, test } from "qunit";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { METRONOME_TRACK_ID, PlayerEventSource } from "#app/midi/event-source.ts";
import { beatsInRange, measuresFromTimeSignatures } from "#app/midi/measure.ts";
import { serializeMidiEvent } from "#app/midi/web-midi-output.ts";

const TIMEBASE = 480;

module("Unit | midi | beats", function () {
  test("4/4 beats with measure starts", function (assert) {
    const measures = measuresFromTimeSignatures([], TIMEBASE);
    const beats = beatsInRange(measures, TIMEBASE, 0, TIMEBASE * 5);

    assert.deepEqual(
      beats.map((b) => [b.tick, b.isMeasureStart]),
      [
        [0, true],
        [480, false],
        [960, false],
        [1440, false],
        [1920, true],
      ],
    );
  });

  test("range boundaries are half-open", function (assert) {
    const measures = measuresFromTimeSignatures([], TIMEBASE);
    const beats = beatsInRange(measures, TIMEBASE, 400, 960);

    assert.deepEqual(
      beats.map((b) => b.tick),
      [480],
    );
  });
});

module("Unit | midi | event-source (metronome)", function () {
  test("injects one click per beat when enabled", function (assert) {
    const source = new PlayerEventSource(createDemoSong());

    const before = source.getEvents(0, TIMEBASE * 4).length;

    source.enableMetronome = true;

    const events = source.getEvents(0, TIMEBASE * 4);
    const clicks = events.filter((e) => e.trackId === METRONOME_TRACK_ID);

    assert.strictEqual(events.length, before + 4, "4 clicks in one 4/4 bar");
    assert.true(
      clicks.every((e) => e.type === "channel" && e.channel === 9),
      "clicks are channel-9 noteOns",
    );

    const first = clicks[0];
    const isMeasureClick =
      first?.type === "channel" && first.subtype === "noteOn" && first.noteNumber === 76;

    assert.true(isMeasureClick, "the downbeat uses the measure click");
  });
});

module("Unit | midi | web-midi serialization", function () {
  test("channel events serialize to raw MIDI bytes", function (assert) {
    assert.deepEqual(
      serializeMidiEvent({
        type: "channel",
        subtype: "noteOn",
        channel: 2,
        noteNumber: 60,
        velocity: 100,
      }),
      [0x92, 60, 100],
    );
    assert.deepEqual(
      serializeMidiEvent({
        type: "channel",
        subtype: "controller",
        channel: 0,
        controllerType: 7,
        value: 100,
      }),
      [0xb0, 7, 100],
    );
    assert.deepEqual(
      serializeMidiEvent({
        type: "channel",
        subtype: "pitchBend",
        channel: 1,
        value: 8192,
      }),
      [0xe1, 0x00, 0x40],
    );
  });

  test("sysEx gets its 0xF0 prefix restored", function (assert) {
    assert.deepEqual(serializeMidiEvent({ type: "sysEx", data: [0x41, 0xf7] }), [0xf0, 0x41, 0xf7]);
  });
});

module("Unit | midi | wall-clock time", function () {
  test("secondsAt walks the tempo map", function (assert) {
    const song = createDemoSong(); // 120bpm throughout

    assert.strictEqual(song.secondsAt(0), 0);
    // one 4/4 bar at 120bpm = 2s
    assert.strictEqual(song.secondsAt(TIMEBASE * 4), 2);
    // full 8 bars = 16s
    assert.strictEqual(song.secondsAt(TIMEBASE * 32), 16);
  });
});
