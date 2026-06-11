// Pure helpers over the acl grant model, factored out of ShareDialog.svelte so
// they're unit-testable without mounting the component.

import type { Grant, Role, WildcardPrincipal } from "./types";

/** The wildcard principal ids the dialog's General-access section offers.
 * Both are required by DECISIONS.md: `*` (Anyone, incl. anonymous) and
 * `_signed_in` (Anyone signed in). */
export const GENERAL_ACCESS_PRINCIPALS: WildcardPrincipal[] = ["*", "_signed_in"];

/** True when a grant is a wildcard "General access" row. The server tags
 * these `kind: "public"` (stored with principal_type `public`); matching on
 * kind only — never on the raw id — keeps a real user who happens to be named
 * `*` / `_signed_in` (kind `user`) in the people roster. */
export function isWildcardGrant(grant: Grant): boolean {
  return grant.kind === "public";
}

/**
 * The current wildcard grant for the resource, if any. Only one is meaningful
 * at a time in the Google-Docs-style control (the most permissive wins), so we
 * return the first `kind:"public"` grant found.
 */
export function currentWildcardGrant(grants: Grant[]): Grant | null {
  return grants.find(isWildcardGrant) ?? null;
}

/**
 * Roles offered in the General-access control's role dropdown. Excludes manage
 * roles (you can't grant the world Owner/Manager) and excludes "Owner".
 */
export function generalAccessRoles(roles: Role[]): Role[] {
  return [...roles]
    .filter((r) => r.name.toLowerCase() !== "owner" && r.manage !== true)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Pick a sensible default role for the add-box's role <select>: the lowest-rank
 * write role (a role whose actions include a write-ish action) if any, else the
 * lowest-rank non-owner/non-manage role, else the first selectable role. This
 * favours "Editor" in the typical Viewer/Editor/Owner registry while staying
 * registry-agnostic.
 */
export function defaultPickerRole(roles: Role[]): string | null {
  const selectable = selectableRoles(roles);
  if (selectable.length === 0) return null;
  const writeRole = selectable.find((r) =>
    r.actions.some((a) => /(write|edit|manage|\*)/i.test(a)),
  );
  return (writeRole ?? selectable[0]!).name;
}

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
