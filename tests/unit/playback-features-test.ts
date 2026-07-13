import { module, test } from "qunit";

import { write } from "midifile-ts";

import { createDemoSong } from "#app/midi/demo-song.ts";
import { METRONOME_TRACK_ID, PlayerEventSource } from "#app/midi/event-source.ts";
import { GroupOutput } from "#app/midi/group-output.ts";
import { beatsInRange, measuresFromTimeSignatures } from "#app/midi/measure.ts";
import { Player } from "#app/midi/player.ts";
import { songFromMidi } from "#app/midi/song.ts";
import { TrackMute } from "#app/midi/track-mute.ts";
import { serializeMidiEvent } from "#app/midi/web-midi-output.ts";
import { keyLayout, noteName } from "#components/piano-roll-layout.ts";

import type { SynthOutput } from "#app/midi/types.ts";
import type { AnyEvent } from "midifile-ts";

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

module("Unit | midi | bug regressions", function () {
  test("mute toggle during playback flushes sounding notes", function (assert) {
    const sent: number[] = [];
    const output = {
      activate() {
        // silent
      },
      sendEvent(event: Parameters<SynthOutput["sendEvent"]>[0]) {
        if (event.type === "channel" && event.subtype === "controller") {
          sent.push(event.controllerType);
        }
      },
    };
    const song = createDemoSong();
    const trackMute = new TrackMute();
    const group = new GroupOutput(trackMute);

    group.outputs = [output];

    const player = new Player(group, new PlayerEventSource(song));

    player.play();
    sent.length = 0;

    trackMute.toggleMute(1);
    player.allSoundsOff(); // what PlayerService.toggleMute does while playing

    player.stop();

    assert.true(sent.includes(120), "all-sounds-off (CC 120) reached the output");
  });

  test("player tempo comes from the conductor walk, not a full event scan", function (assert) {
    const song = createDemoSong();
    const source = new PlayerEventSource(song);

    assert.strictEqual(source.bpmAt(0), song.bpmAt(0));
    assert.strictEqual(source.bpmAt(9999), song.bpmAt(9999));
  });

  test("format-1 multi-channel tracks are split instead of rechanneled", function (assert) {
    const conductor: AnyEvent[] = [
      { type: "meta", subtype: "setTempo", microsecondsPerBeat: 500_000, deltaTime: 0 },
      { type: "meta", subtype: "endOfTrack", deltaTime: 0 },
    ];
    const mixed: AnyEvent[] = [
      {
        type: "channel",
        subtype: "noteOn",
        channel: 3,
        noteNumber: 60,
        velocity: 100,
        deltaTime: 0,
      },
      {
        type: "channel",
        subtype: "noteOff",
        channel: 3,
        noteNumber: 60,
        velocity: 0,
        deltaTime: 240,
      },
      {
        type: "channel",
        subtype: "noteOn",
        channel: 4,
        noteNumber: 62,
        velocity: 100,
        deltaTime: 0,
      },
      {
        type: "channel",
        subtype: "noteOff",
        channel: 4,
        noteNumber: 62,
        velocity: 0,
        deltaTime: 240,
      },
      { type: "meta", subtype: "endOfTrack", deltaTime: 0 },
    ];
    const song = songFromMidi(write([conductor, mixed], 480));

    assert.deepEqual(
      song.playableTracks.map((track) => track.channel),
      [3, 4],
      "one track per channel",
    );
    assert.deepEqual(
      song.playableTracks.map((track) => track.noteCount),
      [1, 1],
    );
  });
});

module("Unit | piano-roll | key layout (fold)", function () {
  test("unfolded shows all 128 keys, top row = highest pitch", function (assert) {
    const layout = keyLayout([], false);

    assert.strictEqual(layout.keys.length, 128);
    assert.strictEqual(layout.keys[0], 127);
    assert.strictEqual(layout.rowOf.get(127), 0);
    assert.false(layout.folded);
  });

  test("folded shows only the edited track's used pitches, descending", function (assert) {
    const song = createDemoSong();
    const piano = song.playableTracks[0];
    const layout = keyLayout(piano?.events, true);

    assert.true(layout.folded);
    assert.true(layout.keys.length < 20, "only used pitches remain");
    assert.deepEqual(
      Array.from(layout.keys),
      Array.from(layout.keys).sort((a, b) => b - a),
      "descending",
    );
    assert.true(
      Array.from(layout.keys).every((key) =>
        piano?.events.some(
          (e) => e.type === "channel" && e.subtype === "note" && e.noteNumber === key,
        ),
      ),
      "every visible row is actually used",
    );
  });

  test("folding an empty track falls back to the full keyboard", function (assert) {
    const layout = keyLayout([], true);

    assert.strictEqual(layout.keys.length, 128);
    assert.false(layout.folded, "reported as unfolded so labels behave normally");
  });

  test("noteName maps MIDI numbers", function (assert) {
    assert.strictEqual(noteName(60), "C4");
    assert.strictEqual(noteName(61), "C#4");
    assert.strictEqual(noteName(69), "A4");
    assert.strictEqual(noteName(0), "C-1");
    assert.strictEqual(noteName(127), "G9");
  });
});
