// Typed fetch client for the share dialog.
//
// Targets two backends:
//   acl       /-/acl/api/...        grants, groups, actors (the grant store)
//   profiles  /-/profiles/api/...   people search (avatars / display names)
//
import type {
  Actor,
  Capabilities,
  Grant,
  GrantRequest,
  GrantResponse,
  Group,
  Principal,
  RevokeResponse,
  ShareState,
} from "./types";

/** Default API prefixes. The acl base is overridable via the component's
 * `api-base` attribute; profiles is derived from sibling Datasette route
 * conventions and is not commonly overridden. */
export const DEFAULT_ACL_BASE = "/-/acl/api";
export const DEFAULT_PROFILES_BASE = "/-/profiles/api";

/**
 * The resource the dialog is sharing. Threaded into the picker calls so the
 * acl picker endpoints can authorize a per-resource Manager (a doc owner who
 * holds no global `datasette-acl` admin) rather than rejecting them.
 */
export interface ShareResource {
  resourceType: string;
  parent: string;
  child?: string | null;
}

export interface ShareApiOptions {
  /** acl API prefix (default `/-/acl/api`). */
  aclBase?: string;
  /** profiles API prefix (default `/-/profiles/api`). */
  profilesBase?: string;
  /** The dialog's resource, threaded onto picker calls for per-resource authz. */
  resource?: ShareResource;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A typed error surfaced to the component so it can render a message rather
 * than failing silently. `status` is 0 for network/transport failures.
 */
export class ShareApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: unknown;

  constructor(message: string, status: number, url: string, body?: unknown) {
    super(message);
    this.name = "ShareApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }

  /** True when the endpoint is absent (used for capability detection). */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function joinPath(base: string, ...parts: string[]): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const tail = parts
    .map((p) => encodeURIComponent(p))
    .join("/");
  return tail ? `${trimmedBase}/${tail}` : trimmedBase;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      usp.set(key, value);
    }
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

export class ShareApi {
  private readonly aclBase: string;
  private readonly profilesBase: string;
  private readonly resource?: ShareResource;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShareApiOptions = {}) {
    this.aclBase = options.aclBase || DEFAULT_ACL_BASE;
    this.profilesBase = options.profilesBase || DEFAULT_PROFILES_BASE;
    this.resource = options.resource;
    // Bind so callers passing `globalThis.fetch` keep the right `this`.
    const f = options.fetch || globalThis.fetch;
    this.fetchImpl = f.bind(globalThis);
  }

  /** The dialog's resource as query params, for per-resource picker authz.
   * Empty when no resource was supplied (back-compat: global-admin gate). */
  private resourceParams(): Record<string, string | undefined> {
    const r = this.resource;
    if (!r || !r.resourceType || !r.parent) return {};
    return {
      resource_type: r.resourceType,
      parent: r.parent,
      child: r.child != null && r.child !== "" ? r.child : undefined,
    };
  }

  // --- low-level transport -------------------------------------------------

  private async getJson<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw new ShareApiError(
        `Network error: ${(err as Error).message}`,
        0,
        url,
      );
    }
    return this.parse<T>(response, url);
  }

  private async postJson<T>(url: string, payload: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(payload ?? {}),
      });
    } catch (err) {
      throw new ShareApiError(
        `Network error: ${(err as Error).message}`,
        0,
        url,
      );
    }
    return this.parse<T>(response, url);
  }

  private async parse<T>(response: Response, url: string): Promise<T> {
    let body: unknown = undefined;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const message =
        (body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : undefined) || `Request failed (${response.status})`;
      throw new ShareApiError(message, response.status, url, body);
    }
    return body as T;
  }

  // --- acl: read -----------------------------------------------------------

  /** GET /-/acl/api/resource/{type}/{parent}[/{child}] → full share state. */
  async getResource(
    resourceType: string,
    parent: string,
    child?: string | null,
  ): Promise<ShareState> {
    const segs = [resourceType, parent];
    if (child != null && child !== "") {
      segs.push(child);
    }
    const url = joinPath(this.aclBase, "resource", ...segs);
    return this.getJson<ShareState>(url);
  }

  // --- acl: mutate ---------------------------------------------------------

  private mutationUrl(
    action: "grant" | "revoke" | "update",
    resourceType: string,
    parent: string,
    child?: string | null,
  ): string {
    const segs = [resourceType, parent];
    if (child != null && child !== "") {
      segs.push(child);
    }
    return joinPath(this.aclBase, "resource", ...segs, action);
  }

  /** POST .../grant → upsert a grant (idempotent). */
  async grant(
    resourceType: string,
    parent: string,
    child: string | null | undefined,
    request: GrantRequest,
  ): Promise<Grant> {
    const url = this.mutationUrl("grant", resourceType, parent, child);
    const res = await this.postJson<GrantResponse>(url, request);
    if (!res.grant) {
      throw new ShareApiError(res.error || "grant returned no grant", 200, url, res);
    }
    return res.grant;
  }

  /** POST .../update → swap a principal's action-set to a new role. */
  async update(
    resourceType: string,
    parent: string,
    child: string | null | undefined,
    request: GrantRequest,
  ): Promise<Grant> {
    const url = this.mutationUrl("update", resourceType, parent, child);
    const res = await this.postJson<GrantResponse>(url, request);
    if (!res.grant) {
      throw new ShareApiError(res.error || "update returned no grant", 200, url, res);
    }
    return res.grant;
  }

  /** POST .../revoke → remove all rows for a principal on this resource.
   * Resolves to the sorted list of action names that were removed. */
  async revoke(
    resourceType: string,
    parent: string,
    child: string | null | undefined,
    principal: Principal,
  ): Promise<string[]> {
    const url = this.mutationUrl("revoke", resourceType, parent, child);
    const res = await this.postJson<RevokeResponse>(url, principal);
    return res.removed ?? [];
  }

  // --- pickers -------------------------------------------------------------

  /** GET /-/profiles/api/search?q= → people picker (avatars/display names).
   * The resource params are sent for forward-compat, but profiles' search
   * endpoint currently ignores them and gates on the global `profile_access`
   * permission (not per-resource Manager). */
  async searchPeople(q: string): Promise<Actor[]> {
    const url = withQuery(joinPath(this.profilesBase, "search"), {
      q,
      ...this.resourceParams(),
    });
    const res = await this.getJson<{ results: Actor[] }>(url);
    return res.results ?? [];
  }

  /** GET /-/profiles/api/resolve?ids= → batch-resolve known actor ids to
   * profile records (display name / email / avatar), keyed by id. Used to
   * enrich the roster, whose grants arrive from acl as bare ids — acl's read
   * endpoint enriches via the firstresult `actors_from_ids` hook, which
   * profiles deliberately doesn't implement, so we resolve over HTTP instead.
   * Unknown ids are omitted from the result map. */
  async resolveActors(ids: string[]): Promise<Record<string, Actor>> {
    if (ids.length === 0) return {};
    const url = withQuery(joinPath(this.profilesBase, "resolve"), {
      ids: ids.join(","),
    });
    const res = await this.getJson<{ results: Record<string, Actor> }>(url);
    return res.results ?? {};
  }

  /** GET /-/acl/api/groups → the group picker. Carries the dialog's resource
   * so per-resource Managers (no global admin) are authorized. */
  async listGroups(): Promise<Group[]> {
    const url = withQuery(
      joinPath(this.aclBase, "groups"),
      this.resourceParams(),
    );
    const res = await this.getJson<{ groups: Group[] }>(url);
    return res.groups ?? [];
  }

  // --- capability detection ------------------------------------------------

  /**
   * Probe which optional backends exist. Treats a 404 (route absent) as
   * "feature off"; any other error (403 forbidden, network) is treated as the
   * feature being present-but-restricted, so we don't hide a section the user
   * might gain access to. groups + public are intrinsic to acl, so true.
   *
   * Prefer {@link capabilitiesFromFeatures} when the host already declares a
   * `features` attribute — it's cheaper (no network round-trips).
   */
  async probeCapabilities(): Promise<Capabilities> {
    const people = await this.probe(() => this.searchPeople(""));
    return { people, groups: true, public: true };
  }

  private async probe(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof ShareApiError && err.isNotFound) {
        return false;
      }
      // Restricted (403) or transient — assume the backend exists.
      return true;
    }
  }
}

/**
 * Build {@link Capabilities} from a host-supplied `features` attribute
 * (comma-separated, e.g. "people,groups,public"). Cheaper than probing.
 * An empty / missing string enables everything (the dialog's documented
 * default of "all available").
 */
export function capabilitiesFromFeatures(features?: string | null): Capabilities {
  if (features == null || features.trim() === "") {
    return { people: true, groups: true, public: true };
  }
  const set = new Set(
    features
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    people: set.has("people"),
    groups: set.has("groups"),
    public: set.has("public"),
  };
}
