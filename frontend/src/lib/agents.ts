// Pure helpers for the Agents picker tab (datasette-agent identities).
//
// Agents are grant-stored as actor principals (so the same revoke/update
// machinery applies); they're distinguished by `kind: "agent"`. The Agents tab
// is hidden entirely when the agent backend is absent (capability `agents`).

import type { Actor, Grant } from "./types";
import { filterAlreadyGranted } from "./people";

/** A friendly label for an agent search hit. */
export function agentLabel(agent: Actor): string {
  return agent.display_name?.trim() || agent.id;
}

/**
 * Filter agent results to those not already granted. Agents share the actor
 * principal space, so dedupe against actor-principal grant ids.
 */
export function filterAgents(results: Actor[], grants: Grant[]): Actor[] {
  return filterAlreadyGranted(results, grants);
}

/**
 * Normalize agent search hits so they always carry `kind: "agent"` even if the
 * backend omits it (the dialog renders the 🤖 badge off `kind`).
 */
export function normalizeAgents(results: Actor[]): Actor[] {
  return results.map((a) => (a.kind === "agent" ? a : { ...a, kind: "agent" }));
}
