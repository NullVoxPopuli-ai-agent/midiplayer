import { module, test } from "qunit";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { isNoteEvent } from "#app/midi/note-assembler.ts";

module("Unit | midi | song (via the generated demo file)", function () {
  test("parses into a conductor track + playable tracks", function (assert) {
    const song = createDemoSong();

    assert.strictEqual(song.timebase, 480);
    assert.strictEqual(song.name, "Demo Song");
    assert.strictEqual(song.tracks.length, 4);
    assert.true(song.tracks[0]?.isConductor);
    assert.deepEqual(
      song.playableTracks.map((t) => [t.name, t.channel]),
      [
        ["Piano", 0],
        ["Bass", 1],
        ["Drums", 9],
      ],
    );
  });

  test("notes are assembled with durations", function (assert) {
    const song = createDemoSong();
    const piano = song.playableTracks[0];
    const notes = piano?.events.filter(isNoteEvent) ?? [];

    // 8 bars x 8 eighth notes
    assert.strictEqual(notes.length, 64);
    assert.true(notes.every((n) => n.duration > 0));
  });

  test("allEvents is flattened, channel-tagged, and tick-sorted", function (assert) {
    const song = createDemoSong();
    const events = song.allEvents;

    assert.true(events.length > 0);
    assert.true(
      events.every((e, i) => i === 0 || e.tick >= (events[i - 1]?.tick ?? 0)),
      "sorted by tick",
    );

    const drumEvents = events.filter((e) => e.type === "channel" && e.channel === 9);

    assert.true(drumEvents.length > 0, "drum events keep their channel");
    assert.true(
      drumEvents.every((e) => e.trackId === 3),
      "events are tagged with their track id",
    );
  });

  test("tempo and end-of-song", function (assert) {
    const song = createDemoSong();

    assert.strictEqual(song.bpmAt(0), 120);
    // the demo's last melody/bass notes are shortened by 20 ticks,
    // so the song ends just shy of the 8-bar line
    assert.strictEqual(song.lastEventTick, 8 * 4 * 480 - 20);
    assert.strictEqual(song.endOfSong, song.lastEventTick + 4 * 480);
  });

  test("getCurrentStateEvents restores program changes after a seek", function (assert) {
    const song = createDemoSong();
    const state = song.getCurrentStateEvents(960);

    const programs = state.filter((e) => e.type === "channel" && e.subtype === "programChange");

    assert.deepEqual(
      programs.map((e) => (e.type === "channel" ? [e.channel, e.value] : null)),
      [
        [0, 0], // piano
        [1, 33], // bass
      ],
    );
  });
});
