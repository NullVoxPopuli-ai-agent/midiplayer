# Midi Player

Web midi player (all storage local)

port of https://github.com/ryohey/signal

An Ember port of signal's playback core: Standard MIDI File parsing
([midifile-ts](https://github.com/ryohey/midifile-ts)), a look-ahead event
scheduler with loop support, and an AudioWorklet soundfont synth
([@ryohey/wavelet](https://github.com/ryohey/wavelet) with signal's A320U GM
soundfont — plus its drums font for the metronome). UI chrome by
[nvp.ui](https://github.com/NullVoxPopuli/nvp.ui).

Features:

- scrolling/zoomable piano roll (piano-key sidebar, measure ruler,
  playhead-follow; click the ruler to seek, drag it to set a loop,
  ctrl+wheel to zoom)
- transport with measure:beat:tick, wall-clock time, live BPM, loop and
  metronome toggles, master volume
- per-track mute/solo
- output routing to the built-in synth or any Web MIDI output device
- drop a `.mid` anywhere on the window to play it; the last song is
  remembered (IndexedDB) and soundfonts are cached (Cache API)
- keyboard: Space plays/pauses, Home rewinds

Everything runs in the browser — files are parsed, scheduled, and synthesized
locally, and nothing is uploaded anywhere.

## Usage

```bash
pnpm install
pnpm start   # dev server
```

Open the app, load a `.mid` file (or click "Play the demo song"), and press
play. The ~9.7 MB soundfont is downloaded from jsDelivr on first use and
cached locally after that.

```bash
pnpm test    # qunit tests (headless chrome via testem)
pnpm lint    # eslint + prettier + ember-tsc
pnpm build   # production build (dist/)
```

## Contributing

The playback core lives in `app/midi/` (framework-agnostic aside from
`@glimmer/tracking`), the Ember glue in `app/services/player.ts`, and the UI in
`app/components/`. See signal's
[architecture](https://github.com/ryohey/signal) for the original design; the
scheduler/tick math is a direct port.
