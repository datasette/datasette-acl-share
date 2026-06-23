// Pure helpers over the acl grant model, factored out of ShareDialog.svelte so
// they're unit-testable without mounting the component.

import type { Grant, Role, PublicAudience } from "./types";

/** All public audiences, in display order (most permissive first). acl models
 * each as an independent principal with its own action-set, so the General
 * access section renders one row per present audience, each with its own role. */
export const PUBLIC_AUDIENCES: PublicAudience[] = [
  "everyone",
  "authenticated",
  "anonymous",
];

/** Audiences offered for *adding* a new general-access row: the two
 * non-overlapping ones — `authenticated` (signed-in) and `anonymous`
 * (signed-out). `everyone` is deliberately omitted as a *new* choice because it
 * overlaps both (a signed-in caller would get the union of grants), which is
 * confusing to add on purpose; "everyone at Viewer" is expressible as both rows.
 * A pre-existing `everyone` grant still renders as a removable row (see
 * {@link publicGrants}), so legacy/seeded data is never hidden. */
export const ADDABLE_AUDIENCES: PublicAudience[] = ["authenticated", "anonymous"];

/** Human label for a public audience principal_type. */
export function audienceLabel(audience: string): string {
  if (audience === "everyone") return "Anyone";
  if (audience === "authenticated") return "Anyone signed in";
  if (audience === "anonymous") return "Anyone signed out";
  return audience;
}

/** One-line description shown under a public audience's label. */
export function audienceSublabel(audience: string): string {
  if (audience === "everyone") return "Anyone on the internet can access";
  if (audience === "authenticated") return "Anyone signed in can access";
  if (audience === "anonymous") return "Anyone not signed in can access";
  return "";
}

/** True when a grant is a public "General access" audience. The server tags
 * these `principal: "public"` / `kind: "public"`; matching on kind only —
 * never on the raw id — keeps a real user whose id happens to match an
 * audience name (kind `user`) in the people roster. */
export function isWildcardGrant(grant: Grant): boolean {
  return grant.kind === "public";
}

/**
 * Every public-audience grant on the resource, ordered most-permissive first
 * (everyone → authenticated → anonymous). Each is rendered as its own row in the
 * General access section and mutated independently.
 */
export function publicGrants(grants: Grant[]): Grant[] {
  const order = new Map(PUBLIC_AUDIENCES.map((a, i) => [a as string, i]));
  return grants
    .filter(isWildcardGrant)
    .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

/**
 * Which public audiences can still be added: the {@link ADDABLE_AUDIENCES}
 * minus any already present on the resource. Drives the "Add public access"
 * control; when empty the control is hidden.
 */
export function availableAudiencesToAdd(grants: Grant[]): PublicAudience[] {
  const present = new Set(grants.filter(isWildcardGrant).map((g) => g.id));
  return ADDABLE_AUDIENCES.filter((a) => !present.has(a));
}

/**
 * A conservative default role for newly added public access: the lowest-rank
 * non-manage role (typically "Viewer"). Unlike {@link defaultPickerRole} (which
 * favours a write role for the people add-box), exposing a resource publicly
 * should default to the least-privileged role.
 */
export function defaultPublicRole(roles: Role[]): string | null {
  return generalAccessRoles(roles)[0]?.name ?? null;
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
