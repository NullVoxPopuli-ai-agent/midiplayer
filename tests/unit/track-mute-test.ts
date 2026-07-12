import { module, test } from "qunit";

import { TrackMute } from "#app/midi/track-mute.ts";

module("Unit | midi | track-mute", function () {
  test("tracks play by default", function (assert) {
    const mute = new TrackMute();

    assert.true(mute.shouldPlayTrack(1));
  });

  test("muting silences a track", function (assert) {
    const mute = new TrackMute();

    mute.toggleMute(1);
    assert.false(mute.shouldPlayTrack(1));
    assert.true(mute.shouldPlayTrack(2));

    mute.toggleMute(1);
    assert.true(mute.shouldPlayTrack(1));
  });

  test("any solo overrides mutes: only soloed tracks play", function (assert) {
    const mute = new TrackMute();

    mute.toggleMute(3);
    mute.toggleSolo(2);

    assert.false(mute.shouldPlayTrack(1), "unmuted but not soloed");
    assert.true(mute.shouldPlayTrack(2), "soloed");
    assert.false(mute.shouldPlayTrack(3), "muted and not soloed");
  });

  test("reset clears everything", function (assert) {
    const mute = new TrackMute();

    mute.toggleMute(1);
    mute.toggleSolo(2);
    mute.reset();

    assert.true(mute.shouldPlayTrack(1));
    assert.false(mute.isSolo(2));
  });
});
