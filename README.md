# Midi Player

Web midi player (all storage local)

port of https://github.com/ryohey/signal

An Ember port of signal's playback core: Standard MIDI File parsing
([midifile-ts](https://github.com/ryohey/midifile-ts)), a look-ahead event
scheduler, and an AudioWorklet soundfont synth
([@ryohey/wavelet](https://github.com/ryohey/wavelet) with signal's A320U GM
soundfont), with a piano-roll visualization, transport (play/pause/stop/seek),
and per-track mute/solo. UI chrome by [nvp.ui](https://github.com/NullVoxPopuli/nvp.ui).

Everything runs in the browser — files are parsed, scheduled, and synthesized
locally, and nothing is uploaded anywhere.

## Usage

```bash
pnpm install
pnpm start   # dev server
```

Open the app, load a `.mid` file (or click "Play the demo song"), and press
play. The ~9.7 MB soundfont is downloaded from jsDelivr on first use.

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
