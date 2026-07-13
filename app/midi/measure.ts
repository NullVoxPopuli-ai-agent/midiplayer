import type { TickedEvent } from "./types.ts";
import type { TimeSignatureEvent } from "midifile-ts";

export interface Measure {
  tick: number;
  /** 0-based measure index at `tick` */
  number: number;
  numerator: number;
  denominator: number;
}

const DEFAULT_MEASURE: Measure = {
  tick: 0,
  number: 0,
  numerator: 4,
  denominator: 4,
};

function ticksPerMeasure(measure: Measure, timebase: number): number {
  return ((timebase * 4) / measure.denominator) * measure.numerator;
}

export function measuresFromTimeSignatures(
  timeSignatures: readonly TickedEvent<TimeSignatureEvent>[],
  timebase: number,
): Measure[] {
  if (timeSignatures.length === 0) {
    return [DEFAULT_MEASURE];
  }

  const measures: Measure[] = [];
  let last = DEFAULT_MEASURE;

  for (const event of timeSignatures) {
    const gap = event.tick - last.tick;
    const number = last.number + Math.floor(gap / ticksPerMeasure(last, timebase));

    last = {
      tick: event.tick,
      number,
      numerator: event.numerator,
      denominator: event.denominator,
    };
    measures.push(last);
  }

  if (measures.length === 0 || (measures[0]?.tick ?? 0) > 0) {
    measures.unshift(DEFAULT_MEASURE);
  }

  return measures;
}

function measureAt(measures: readonly Measure[], tick: number): Measure {
  let found = measures[0] ?? DEFAULT_MEASURE;

  for (const measure of measures) {
    if (measure.tick > tick) break;
    found = measure;
  }

  return found;
}

/**
 * Format a tick as "measure:beat:tick" — e.g. "0001:01:000"
 * (1-based measure and beat, 0-based tick remainder)
 */
export function getMBTString(measures: readonly Measure[], tick: number, timebase: number): string {
  const measure = measureAt(measures, tick);
  const ticksPerBeat = (timebase * 4) / measure.denominator;
  const ticksIntoMeasure = tick - measure.tick;
  const perMeasure = ticksPerBeat * measure.numerator;

  const measureNumber = measure.number + Math.floor(ticksIntoMeasure / perMeasure);
  const remainder = ticksIntoMeasure % perMeasure;
  const beat = Math.floor(remainder / ticksPerBeat);
  const remainderTicks = Math.floor(remainder % ticksPerBeat);

  const mmmm = `${measureNumber + 1}`.padStart(4, "0");
  const bb = `${beat + 1}`.padStart(2, "0");
  const ttt = `${remainderTicks}`.padStart(3, "0");

  return `${mmmm}:${bb}:${ttt}`;
}

export interface Beat {
  tick: number;
  /** true when this beat starts a measure */
  isMeasureStart: boolean;
  /** 0-based measure index (for ruler labels) */
  measureNumber: number;
}

/**
 * All beats in [startTick, endTick) — used for the ruler and for
 * metronome click generation (signal's Beat.createInRange).
 */
export function beatsInRange(
  measures: readonly Measure[],
  timebase: number,
  startTick: number,
  endTick: number,
): Beat[] {
  const beats: Beat[] = [];

  for (const [index, measure] of measures.entries()) {
    const next = measures[index + 1];
    const segmentEnd = Math.min(next?.tick ?? Infinity, endTick);

    if (segmentEnd <= startTick) continue;
    if (measure.tick >= endTick) break;

    const ticksPerBeat = (timebase * 4) / measure.denominator;
    const perMeasure = ticksPerBeat * measure.numerator;

    // first beat in this segment at or after startTick
    const firstIndex = Math.max(0, Math.floor((startTick - measure.tick) / ticksPerBeat));

    for (let i = firstIndex; ; i++) {
      const tick = measure.tick + i * ticksPerBeat;

      if (tick >= segmentEnd) break;
      if (tick < startTick) continue;

      beats.push({
        tick,
        isMeasureStart: i % measure.numerator === 0,
        measureNumber: measure.number + Math.floor((i * ticksPerBeat) / perMeasure),
      });
    }
  }

  return beats;
}
