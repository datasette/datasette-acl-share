// Pure helpers for the People picker tab (profiles search).
//
// The add-box debounces user input and calls `api.searchPeople(q)`; these
// helpers keep the (testable) bits — debouncing and result filtering — out of
// the component so they can be unit-tested without a DOM.

import type { Actor, Grant } from "./types";

/**
 * A debounced async runner for type-ahead search. Each call cancels the
 * previously pending timer; the wrapped function only runs after `delayMs` of
 * quiet. The returned function also exposes `.cancel()` to drop a pending run
 * (e.g. when the tab changes or the box closes).
 *
 * Kept generic so other pickers can reuse it.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  }) as Debounced<A>;
  wrapped.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}

/** Default debounce window for the people type-ahead, in ms. */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Filter a search-result list down to actors who don't already have a grant on
 * the resource (so the picker doesn't offer to re-add someone). Compares by the
 * actor id against the grant set's actor-principal ids.
 */
export function filterAlreadyGranted(
  results: Actor[],
  grants: Grant[],
): Actor[] {
  const taken = new Set(
    grants.filter((g) => g.principal === "actor").map((g) => g.id),
  );
  return results.filter((a) => !taken.has(a.id));
}

/**
 * Find an existing actor grant for a given actor id, or null. Used to focus the
 * existing row instead of adding a duplicate.
 */
export function existingActorGrant(
  grants: Grant[],
  actorId: string,
): Grant | null {
  return (
    grants.find((g) => g.principal === "actor" && g.id === actorId) ?? null
  );
}

/** A friendly label for an actor search hit (display name → email → id). */
export function actorLabel(actor: Actor): string {
  return actor.display_name?.trim() || actor.email?.trim() || actor.id;
}
