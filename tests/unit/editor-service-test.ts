import { module, test } from "qunit";
import { setupTest } from "ember-qunit";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { PlayerEventSource } from "#app/midi/event-source.ts";
import { Player } from "#app/midi/player.ts";

import type { SynthOutput } from "#app/midi/types.ts";
import type EditorService from "#services/editor.ts";
import type HistoryService from "#services/history.ts";
import type PlayerService from "#services/player.ts";

const nullOutput: SynthOutput = {
  activate() {
    // no audio in unit tests
  },
  sendEvent() {
    // no audio in unit tests
  },
};

module("Unit | services | editor", function (hooks) {
  setupTest(hooks);

  let editor: EditorService;
  let history: HistoryService;
  let player: PlayerService;

  hooks.beforeEach(function () {
    editor = this.owner.lookup("service:editor");
    history = this.owner.lookup("service:history");
    player = this.owner.lookup("service:player");

    const song = createDemoSong();

    player.song = song;
    player.player = new Player(nullOutput, new PlayerEventSource(song));
  });

  test("createNote takes exactly one undo checkpoint and undo removes the note", function (assert) {
    const track = editor.selectedTrack;
    const before = track?.noteCount ?? 0;

    const id = editor.createNote(0, 100);

    assert.notStrictEqual(id, null, "note created");
    assert.strictEqual(editor.selectedTrack?.noteCount, before + 1);
    assert.true(history.canUndo);

    history.undo();

    assert.strictEqual(editor.selectedTrack?.noteCount, before, "undo removes it");
    assert.false(history.canUndo, "exactly one checkpoint was taken");
  });

  test("deleteNote takes exactly one checkpoint and undo restores", function (assert) {
    const track = editor.selectedTrack;
    const firstNote = track?.events.find((e) => e.type === "channel" && e.subtype === "note");
    const before = track?.noteCount ?? 0;

    editor.deleteNote(firstNote?.id ?? -1);

    assert.strictEqual(editor.selectedTrack?.noteCount, before - 1);

    history.undo();

    assert.strictEqual(editor.selectedTrack?.noteCount, before, "undo restores the note");
    assert.false(history.canUndo);
  });

  test("moveNotes snaps and clamps to the keyboard", function (assert) {
    const id = editor.createNote(480, 60);
    const origin = editor.selectedNotes.map((note) => ({ ...note }));

    editor.moveNotes(origin, editor.snapTicks, 200);

    const moved = editor.selectedNotes.find((note) => note.id === id);

    assert.strictEqual(moved?.tick, 480 + editor.snapTicks, "tick moved by one snap unit");
    assert.strictEqual(moved?.noteNumber, 127, "pitch clamped to 127");
  });

  test("copy/paste round-trips at the playhead", function (assert) {
    const before = editor.selectedTrack?.noteCount ?? 0;

    editor.selectAll();
    editor.copySelection();

    const playerInstance = player.player;

    if (playerInstance) playerInstance.position = 0;

    editor.paste();

    assert.strictEqual(editor.selectedTrack?.noteCount, before * 2, "all notes pasted");

    history.undo();
    assert.strictEqual(editor.selectedTrack?.noteCount, before);
  });

  test("selectTrack clears the selection", function (assert) {
    editor.selectAll();
    assert.true(editor.selection.size > 0);

    const other = player.song?.playableTracks[1];

    editor.selectTrack(other?.id ?? -1);

    assert.strictEqual(editor.selection.size, 0);
    assert.strictEqual(editor.selectedTrack?.id, other?.id);
  });
});

module("Unit | services | editor (bug regressions)", function (hooks) {
  setupTest(hooks);

  let editor: EditorService;
  let history: HistoryService;
  let player: PlayerService;

  hooks.beforeEach(function () {
    editor = this.owner.lookup("service:editor");
    history = this.owner.lookup("service:history");
    player = this.owner.lookup("service:player");

    const song = createDemoSong();

    player.song = song;
    player.player = new Player(nullOutput, new PlayerEventSource(song));
  });

  test("moving off-grid notes snaps the delta, not the position", function (assert) {
    // an off-grid note, like recorded input would produce
    const track = editor.selectedTrack;
    const offGrid = track?.addEvent({
      type: "channel",
      subtype: "note",
      tick: 100,
      noteNumber: 70,
      velocity: 90,
      duration: 100,
    });
    const origin = [{ ...offGrid, type: "channel", subtype: "note" } as never];

    // purely vertical move (deltaTick below the snap unit)
    editor.moveNotes(origin, 10, 1);

    const after = track?.events.find((e) => e.id === offGrid?.id);

    assert.strictEqual(after?.tick, 100, "vertical move must not shift the tick");

    // horizontal move by exactly one snap unit keeps the offset
    editor.moveNotes(origin, editor.snapTicks, 0);

    const moved = track?.events.find((e) => e.id === offGrid?.id);

    assert.strictEqual(moved?.tick, 100 + editor.snapTicks, "offset from the grid is preserved");
  });

  test("resizing an off-grid note by a sub-snap amount keeps its duration", function (assert) {
    const track = editor.selectedTrack;
    const note = track?.addEvent({
      type: "channel",
      subtype: "note",
      tick: 100,
      noteNumber: 70,
      velocity: 90,
      duration: 240,
    });

    editor.resizeNote({ ...note } as never, 10);

    const after = track?.events.find((e) => e.id === note?.id);

    assert.strictEqual(
      after && "duration" in after ? after.duration : 0,
      240,
      "small edge drag must not shrink the note to the grid",
    );
  });

  test("recording: retriggering a held pitch flushes the first press", function (assert) {
    const track = editor.selectedTrack;
    const before = track?.noteCount ?? 0;

    // noteOn C4, noteOn C4 again (retrigger), noteOff C4
    editor.handleMidiMessage(new Uint8Array([0x90, 60, 100]));
    editor.handleMidiMessage(new Uint8Array([0x90, 60, 90]));
    editor.handleMidiMessage(new Uint8Array([0x80, 60, 0]));

    assert.strictEqual(
      editor.selectedTrack?.noteCount,
      before + 2,
      "both presses become notes — the first is not silently lost",
    );
  });

  test("undo clears the selection immediately (ids are regenerated)", function (assert) {
    editor.createNote(0, 100);
    editor.selectAll();
    assert.true(editor.selection.size > 0);

    history.undo();

    assert.strictEqual(editor.selection.size, 0, "no stale ids survive the restore");
  });
});
