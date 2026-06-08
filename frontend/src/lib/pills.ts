// Pure helpers for the add-box "pill" picker: the user selects several
// people / groups (each rendered as a removable chip) before clicking
// Share, which grants the chosen role to every selected pill at once.
//
// These helpers keep the (testable) list bookkeeping — add/remove/dedupe and
// building the batch-grant payloads — out of the component so they can be unit
// tested without a DOM, mirroring the sibling lib modules.

import type { Actor, ActorKind, Grant, GrantRequest, Group, Principal } from "./types";
import { actorLabel } from "./people";
import { groupIdStr } from "./groups";

/**
 * One pending selection in the add-box. Each pill remembers its principal
 * (actor id / group id / wildcard id) plus enough enrichment to render a chip
 * (avatar colour key, kind badge, optional avatar image).
 */
export interface Pill {
  /** Discriminator mirroring {@link Grant.principal}. */
  principal: "actor" | "group";
  /** The principal identity: actor id or stringified group id. */
  id: string;
  /** The chip label (display name → email → id). */
  label: string;
  /** Principal kind, for the avatar badge (user / group). */
  kind: ActorKind;
  /** Optional avatar image url (people only). */
  avatar_url?: string;
  /** Optional sub-label (a person's email), shown in the results dropdown. */
  email?: string;
  /** Group pills only: member count, shown in the results dropdown. */
  member_count?: number;
}

/** A stable key for a pill's principal, matching {@link Grant} keying. */
export function pillKey(pill: Pick<Pill, "principal" | "id">): string {
  return `${pill.principal}:${pill.id}`;
}

/** Build a pill from a person search hit. */
export function pillFromActor(actor: Actor): Pill {
  return {
    principal: "actor",
    id: actor.id,
    label: actorLabel(actor),
    kind: actor.kind,
    ...(actor.avatar_url ? { avatar_url: actor.avatar_url } : {}),
    ...(actor.email ? { email: actor.email } : {}),
  };
}

/** Build a pill from a group list hit. */
export function pillFromGroup(group: Group): Pill {
  return {
    principal: "group",
    id: groupIdStr(group.id),
    label: group.name,
    kind: "group",
    member_count: group.member_count,
  };
}

/** True when `pills` already contains a pill for the same principal. */
export function hasPill(pills: Pill[], pill: Pick<Pill, "principal" | "id">): boolean {
  const key = pillKey(pill);
  return pills.some((p) => pillKey(p) === key);
}

/**
 * Add a pill to the list, de-duped by principal. Returns a new array (the
 * original is unchanged). A pill that's already present is ignored.
 */
export function addPill(pills: Pill[], pill: Pill): Pill[] {
  if (hasPill(pills, pill)) return pills;
  return [...pills, pill];
}

/** Remove a pill by principal key. Returns a new array. */
export function removePill(
  pills: Pill[],
  target: Pick<Pill, "principal" | "id">,
): Pill[] {
  const key = pillKey(target);
  return pills.filter((p) => pillKey(p) !== key);
}

/**
 * The {@link Principal} body for a pill, used to build grant/revoke requests.
 * Group ids stay as the stringified form the grant store accepts.
 */
export function pillPrincipal(pill: Pill): Principal {
  return pill.principal === "group"
    ? { group_id: pill.id }
    : { actor_id: pill.id };
}

/**
 * Build the batch of grant requests for the selected pills at a given role —
 * one request per pill, in pill order. Used to fan out `ShareApi.grant` calls.
 */
export function batchGrantRequests(pills: Pill[], role: string): GrantRequest[] {
  return pills.map((pill) => ({ ...pillPrincipal(pill), role }));
}

/**
 * Whether a principal may be added as a pill: not already granted on the
 * resource and not already a pill. Returns the blocking grant (so the caller
 * can flash the existing row) or `null` when the pill is addable.
 */
export function blockingGrant(
  grants: Grant[],
  pill: Pick<Pill, "principal" | "id">,
): Grant | null {
  return (
    grants.find(
      (g) => g.principal === pill.principal && g.id === pill.id,
    ) ?? null
  );
}
