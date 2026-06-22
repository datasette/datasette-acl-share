// Pure helpers over the acl grant model, factored out of ShareDialog.svelte so
// they're unit-testable without mounting the component.

import type { Grant, Role, PublicAudience } from "./types";

/** The public audiences the dialog's General-access section offers:
 * `everyone` (Anyone, incl. anonymous) and `authenticated` (Anyone signed in).
 * (`anonymous` exists in acl but is not offered as a dialog option.) */
export const GENERAL_ACCESS_PRINCIPALS: PublicAudience[] = [
  "everyone",
  "authenticated",
];

/** True when a grant is a public "General access" audience. The server tags
 * these `principal: "public"` / `kind: "public"`; matching on kind only —
 * never on the raw id — keeps a real user whose id happens to match an
 * audience name (kind `user`) in the people roster. */
export function isWildcardGrant(grant: Grant): boolean {
  return grant.kind === "public";
}

/**
 * The current public audience grant for the resource, if any. Only one is
 * meaningful at a time in the Google-Docs-style control (the most permissive
 * wins), so we return the first `kind:"public"` grant found.
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
 * True when a grant confers management of the resource — an Owner, or any grant
 * whose resolved role is manage-capable (`role.manage === true`). Used to keep
 * the resource from being orphaned (see {@link isLastManageGrant}).
 */
export function isManageGrant(grant: Grant, roles: Role[]): boolean {
  if (isOwnerGrant(grant)) return true;
  const role = roles.find((r) => r.name === grant.role);
  return role?.manage === true;
}

/**
 * True when `grant` is the ONLY manage-capable grant on the resource, so
 * revoking it (or downgrading it to a non-manage role) would orphan the
 * resource — leaving nobody able to manage sharing. Because acl's read endpoint
 * is manager-only, an orphaned resource can't even re-open this dialog, so the
 * UI blocks the action. Returns false for non-manage grants (they're always
 * safe to remove).
 */
export function isLastManageGrant(
  grant: Grant,
  grants: Grant[],
  roles: Role[],
): boolean {
  if (!isManageGrant(grant, roles)) return false;
  return !grants.some(
    (g) =>
      !(g.principal === grant.principal && g.id === grant.id) &&
      isManageGrant(g, roles),
  );
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
