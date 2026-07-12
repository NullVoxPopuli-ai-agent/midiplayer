import { module, test } from "qunit";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { isNoteEvent } from "#app/midi/note-assembler.ts";
import { emptySong, songFromMidi, songToMidi, Track } from "#app/midi/song.ts";

import type { NoteEvent } from "#app/midi/types.ts";

function note(tick: number, noteNumber: number, duration = 240): NoteEvent {
  return { type: "channel", subtype: "note", tick, noteNumber, velocity: 100, duration };
}

module("Unit | midi | editable model", function () {
  test("addEvent keeps events tick-sorted and ids unique", function (assert) {
    const track = new Track(1, 0, [note(480, 60)]);

    const added = track.addEvent(note(0, 62));

    assert.deepEqual(
      track.events.map((e) => e.tick),
      [0, 480],
    );
    assert.notStrictEqual(added.id, track.events[1]?.id);
  });

  test("updateEvent re-sorts on tick change", function (assert) {
    const track = new Track(1, 0, [note(0, 60), note(480, 62)]);
    const first = track.events[0];

    track.updateEvent(first?.id ?? -1, { tick: 960 });

    assert.deepEqual(
      track.events.map((e) => e.tick),
      [480, 960],
    );
  });

  test("removeEvents deletes by id", function (assert) {
    const track = new Track(1, 0, [note(0, 60), note(480, 62)]);

    track.removeEvents([track.events[0]?.id ?? -1]);

    assert.strictEqual(track.events.length, 1);
    assert.strictEqual(track.events[0]?.tick, 480);
  });

  test("setName updates the trackName event", function (assert) {
    const track = new Track(1, 0, []);

    track.setName("Lead");
    assert.strictEqual(track.name, "Lead");

    track.setName("Bass");
    assert.strictEqual(track.name, "Bass");
    assert.strictEqual(
      track.events.filter((e) => e.type === "meta" && e.subtype === "trackName").length,
      1,
      "renaming does not accumulate trackName events",
    );
  });

  test("song mutations invalidate allEvents", function (assert) {
    const song = createDemoSong();
    const before = song.allEvents.length;

    song.playableTracks[0]?.addEvent(note(0, 100));

    assert.strictEqual(song.allEvents.length, before + 2, "one note = noteOn + noteOff");
  });

  test("createTrack / removeTrack", function (assert) {
    const song = createDemoSong();
    const track = song.createTrack(3, [note(0, 60)]);

    assert.true(song.playableTracks.some((t) => t.id === track.id));

    song.removeTrack(track.id);
    assert.false(song.playableTracks.some((t) => t.id === track.id));
  });

  test("songToMidi round-trips through songFromMidi", function (assert) {
    const song = createDemoSong();

    song.playableTracks[0]?.addEvent(note(960, 72, 480));

    const restored = songFromMidi(songToMidi(song));

    assert.strictEqual(restored.timebase, song.timebase);
    assert.strictEqual(restored.tracks.length, song.tracks.length);

    const notes = (index: number, s: typeof song) =>
      (s.playableTracks[index]?.events ?? [])
        .filter(isNoteEvent)
        .map((n) => [n.tick, n.noteNumber, n.duration, n.velocity]);

    for (let i = 0; i < song.playableTracks.length; i++) {
      assert.deepEqual(notes(i, restored), notes(i, song), `track ${i} notes survive`);
    }
  });

  test("emptySong matches signal's factory shape", function (assert) {
    const song = emptySong();

    assert.strictEqual(song.timebase, 480);
    assert.true(song.tracks[0]?.isConductor);
    assert.strictEqual(song.playableTracks.length, 1);
    assert.strictEqual(song.playableTracks[0]?.channel, 0);
    assert.strictEqual(song.playableTracks[0]?.controllerValueAt(7, 0), 100, "volume 100");
    assert.strictEqual(song.playableTracks[0]?.controllerValueAt(10, 0), 64, "pan 64");
    assert.strictEqual(song.bpmAt(0), 120);
  });
});
