// Pure helpers over the acl grant model, factored out of ShareDialog.svelte so
// they're unit-testable without mounting the component.

import type { Grant, Role } from "./types";

/**
 * Owner detection. The acl branch doesn't emit an `is_owner` flag yet (it
 * infers ownership from the role name), so honour the flag when present and
 * otherwise treat the literal "Owner" role as the owner row.
 */
export function isOwnerGrant(grant: Grant): boolean {
  if (grant.is_owner === true) return true;
  return (grant.role ?? "").toLowerCase() === "owner";
}

/**
 * Roles offered in a per-grant dropdown, ordered by ascending rank. The
 * "Owner" role is excluded — ownership transfer is out of scope for the
 * per-grant control.
 */
export function selectableRoles(roles: Role[]): Role[] {
  return [...roles]
    .filter((r) => r.name.toLowerCase() !== "owner")
    .sort((a, b) => a.rank - b.rank);
}

/**
 * People-with-access ordering: owner first, then by descending role rank
 * (most-privileged first), then by display label, mirroring Google Docs.
 */
export function orderGrants(
  grants: Grant[],
  roles: Role[],
  label: (g: Grant) => string,
): Grant[] {
  const rank = new Map(roles.map((r) => [r.name, r.rank] as const));
  return [...grants].sort((a, b) => {
    const ao = isOwnerGrant(a) ? 1 : 0;
    const bo = isOwnerGrant(b) ? 1 : 0;
    if (ao !== bo) return bo - ao; // owner first
    const ar = rank.get(a.role ?? "") ?? -1;
    const br = rank.get(b.role ?? "") ?? -1;
    if (ar !== br) return br - ar; // higher rank first
    return label(a).localeCompare(label(b));
  });
}
