/**
 * The app's forms exist for a11y semantics (grouping labelled
 * controls), not for submission.
 */
export function preventDefault(event: Event): void {
  event.preventDefault();
}
