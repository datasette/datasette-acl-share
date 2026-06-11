// Types mirroring the datasette-acl JSON API (see its docs/json-api.md;
// includes the general-access-principals `principal_type` additions) and the
// datasette-user-profiles search API. These shapes are what the share dialog
// component consumes.
//
// Sources:
//   acl       datasette_acl/views/api.py  (resource_grants_json / *_json)
//   profiles  datasette_user_profiles/routes/api.py  (api_search → SearchResult)

/** Which kind of principal a grant or search hit refers to. */
export type ActorKind = "user" | "group" | "public";

/** The `principal` discriminator on grant entries. Wildcard "general access"
 * rows are stored server-side with a distinct principal_type of `public`, but
 * are still serialized as `principal: "actor"` entries (distinguished by
 * `kind: "public"`). */
export type PrincipalType = "actor" | "group";

/** The optional `principal_type` body field on grant/update/revoke mutations.
 * When omitted the server infers it (a wildcard id → `public`, else `actor`).
 * Pass it explicitly to disambiguate a real user whose id collides with a
 * wildcard (e.g. a user literally named `_signed_in`). `"public"` with a
 * non-wildcard id is a 400. */
export type GrantPrincipalType = "actor" | "public";

/** Wildcard principal ids used for the "General access" section.
 * `*` = anyone (anonymous/public); `_signed_in` = any logged-in actor.
 * (`_anonymous` exists in acl SQL but is not offered as a dialog option.) */
export type WildcardPrincipal = "*" | "_signed_in" | "_anonymous";

/**
 * A role registered for a resource type, as returned in `ShareState.roles`.
 * Mirrors `_roles_payload` in the acl API.
 */
export interface Role {
  name: string;
  actions: string[];
  rank: number;
  /** Present (true) only for manage-capable roles (Manager / Owner). */
  manage?: boolean;
  description?: string;
}

/**
 * One enriched grant row, as returned in `ShareState.grants`.
 * Mirrors the actor / group grant entries built by the acl API.
 *
 * Note: the acl API uses `id` for the principal identity (actor id, group id,
 * or wildcard string) and a separate `principal` discriminator — there is no
 * nested `principal` object on the wire.
 */
export interface Grant {
  /** Discriminator: "actor" or "group". */
  principal: PrincipalType;
  /** The principal identity: actor id, stringified group id, or wildcard. */
  id: string;
  /** Resolved friendly role name, or null when the action-set matches no role. */
  role: string | null;
  /** The raw granted action-set (sorted). */
  actions: string[];
  /** "user" | "group" | "public". */
  kind: ActorKind;
  /** Enrichment (profiles); absent when unavailable. */
  display_name?: string;
  email?: string;
  avatar_url?: string;
  /** Group grants only: number of members. */
  member_count?: number;
  /**
   * Set by the acl API when this principal owns the resource. The current acl
   * branch infers ownership from the role name instead of emitting this flag,
   * so the dialog treats `role === "Owner"` as owner too (see
   * {@link isOwnerGrant}); kept here for forward-compat.
   */
  is_owner?: boolean;
}

/**
 * The full share state for one resource.
 * Mirrors the `resource_grants_json` response.
 */
export interface ShareState {
  resource_type: string;
  parent: string;
  child: string | null;
  /** Whether the current actor may manage sharing for this resource. */
  can_manage: boolean;
  roles: Role[];
  grants: Grant[];
}

/**
 * A search / picker hit for a person (profiles).
 * Mirrors profiles' `SearchResult`.
 */
export interface Actor {
  id: string;
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string;
  kind: ActorKind;
}

/** A group from `GET /-/acl/api/groups`. */
export interface Group {
  id: number | string;
  name: string;
  member_count: number;
}

/** A principal to grant/revoke/update against. Exactly one of the id fields.
 * `principal_type` only applies with `actor_id` (see {@link GrantPrincipalType});
 * the dialog always sends it so a wildcard-named user id is never mistaken for
 * a general-access wildcard (and vice versa). */
export interface Principal {
  actor_id?: string;
  group_id?: number | string;
  principal_type?: GrantPrincipalType;
}

/** Body for a grant/update mutation: a principal plus a role (or raw actions). */
export interface GrantRequest extends Principal {
  role?: string;
  actions?: string[];
}

/** The `{ok, grant}` envelope returned by grant/update. */
export interface GrantResponse {
  ok: boolean;
  grant?: Grant;
  error?: string;
}

/**
 * The `{ok, removed}` envelope returned by revoke. `removed` is the sorted
 * list of action names that were actually removed (empty when the principal
 * held no grants).
 */
export interface RevokeResponse {
  ok: boolean;
  removed?: string[];
  error?: string;
}

/**
 * Which optional backends are available, so the dialog can show/hide sections.
 * `groups` is part of acl itself and so is always assumed present; `people`
 * (profiles search) is optional; `public` (general-access wildcards) is always
 * supported by acl.
 */
export interface Capabilities {
  people: boolean;
  groups: boolean;
  public: boolean;
}
