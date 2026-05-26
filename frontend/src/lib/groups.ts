// Pure helpers for the Groups picker tab (acl groups).
//
// Groups are listed (not searched) via `api.listGroups()`; we filter client
// side by the typed query and drop groups that already have a grant. Group
// grants are stored under the `group` principal.

import type { Group, Grant } from "./types";

/** A stable string form of a group id (acl returns numbers; grants stringify). */
export function groupIdStr(id: Group["id"]): string {
  return String(id);
}

/**
 * Filter the group list by a free-text query (case-insensitive name match) and
 * drop groups that already have a grant on the resource.
 */
export function filterGroups(
  groups: Group[],
  grants: Grant[],
  query: string,
): Group[] {
  const taken = new Set(
    grants.filter((g) => g.principal === "group").map((g) => g.id),
  );
  const q = query.trim().toLowerCase();
  return groups.filter((grp) => {
    if (taken.has(groupIdStr(grp.id))) return false;
    if (!q) return true;
    return grp.name.toLowerCase().includes(q);
  });
}

/**
 * Find an existing group grant for a given group id, or null. Used to focus the
 * existing row instead of adding a duplicate.
 */
export function existingGroupGrant(
  grants: Grant[],
  groupId: Group["id"],
): Grant | null {
  const id = groupIdStr(groupId);
  return grants.find((g) => g.principal === "group" && g.id === id) ?? null;
}

/** A "N members" sub-label for a group row. */
export function memberCountLabel(count: number): string {
  return `${count} member${count === 1 ? "" : "s"}`;
}
