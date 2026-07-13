/**
 * A stable, theme-friendly color per track (also used as a helper in
 * templates).
 */
export function trackColor(trackId: number): string {
  const hue = (trackId * 67 + 200) % 360;

  return `hsl(${hue} 70% 55%)`;
}
