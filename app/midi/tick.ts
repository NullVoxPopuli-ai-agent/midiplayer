export const DEFAULT_TEMPO = 120;

export function tickToMillisec(tick: number, bpm: number, timebase: number): number {
  return (tick / (timebase / 60) / bpm) * 1000;
}

export function millisecToTick(ms: number, bpm: number, timebase: number): number {
  return (((ms / 1000) * bpm) / 60) * timebase;
}

export function bpmFromSetTempo(microsecondsPerBeat: number): number {
  return 60_000_000 / microsecondsPerBeat;
}
