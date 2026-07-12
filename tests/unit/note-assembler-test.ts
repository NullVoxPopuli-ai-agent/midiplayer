import { module, test } from "qunit";

import { assembleNotes, deassembleNote, isNoteEvent } from "#app/midi/note-assembler.ts";

import type { NoteEvent, RawTrackEvent } from "#app/midi/types.ts";

function noteOn(tick: number, noteNumber: number, velocity = 100): RawTrackEvent {
  return { type: "channel", subtype: "noteOn", channel: 0, tick, noteNumber, velocity };
}

function noteOff(tick: number, noteNumber: number): RawTrackEvent {
  return { type: "channel", subtype: "noteOff", channel: 0, tick, noteNumber, velocity: 0 };
}

module("Unit | midi | note-assembler", function () {
  test("pairs noteOn/noteOff into a note with duration", function (assert) {
    const result = assembleNotes([noteOn(0, 60, 90), noteOff(480, 60)]);

    assert.deepEqual(result, [
      {
        type: "channel",
        subtype: "note",
        tick: 0,
        noteNumber: 60,
        velocity: 90,
        duration: 480,
      },
    ]);
  });

  test("pairing is FIFO per note number", function (assert) {
    const result = assembleNotes([
      noteOn(0, 60),
      noteOn(240, 60),
      noteOff(480, 60),
      noteOff(960, 60),
    ]).filter(isNoteEvent);

    assert.deepEqual(
      result.map((n) => [n.tick, n.duration]),
      [
        [0, 480],
        [240, 720],
      ],
    );
  });

  test("unmatched noteOns and noteOffs are dropped", function (assert) {
    const result = assembleNotes([noteOff(0, 62), noteOn(480, 60)]);

    assert.deepEqual(result, []);
  });

  test("other events pass through", function (assert) {
    const program: RawTrackEvent = {
      type: "channel",
      subtype: "programChange",
      channel: 0,
      tick: 0,
      value: 5,
    };

    assert.deepEqual(assembleNotes([program]), [program]);
  });

  test("deassembleNote splits a note back into on/off on the track channel", function (assert) {
    const note: NoteEvent = {
      type: "channel",
      subtype: "note",
      tick: 100,
      noteNumber: 64,
      velocity: 80,
      duration: 50,
    };

    assert.deepEqual(deassembleNote(note, 3), [
      {
        type: "channel",
        subtype: "noteOn",
        channel: 3,
        tick: 100,
        noteNumber: 64,
        velocity: 80,
      },
      {
        type: "channel",
        subtype: "noteOff",
        channel: 3,
        tick: 150,
        noteNumber: 64,
        velocity: 0,
      },
    ]);
  });
});
