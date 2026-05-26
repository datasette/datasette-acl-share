<svelte:options
  customElement={{
    tag: "datasette-share-dialog",
    // Light DOM (no shadow root) so host pages can theme the dialog and there
    // are no shadow-DOM form/focus quirks. Styles are emitted with
    // `datasette-share-`-prefixed selectors (see plan §2).
    shadow: "none",
  }}
/>

<script lang="ts">
  import { ShareApi, ShareApiError } from "./lib/api";
  import { avatarColor, initials, kindBadge } from "./lib/avatar";
  import { isOwnerGrant, orderGrants, selectableRoles } from "./lib/grants";
  import type {
    Actor,
    ActorKind,
    Grant,
    GrantRequest,
    Principal,
    ShareState,
  } from "./lib/types";

  let {
    "resource-type": resourceType,
    parent,
    child,
    "resource-label": resourceLabel,
    "actor-json": actorJson,
    csrftoken,
    "api-base": apiBase,
  }: {
    "resource-type"?: string;
    parent?: string;
    child?: string;
    "resource-label"?: string;
    "actor-json"?: string;
    csrftoken?: string;
    "api-base"?: string;
  } = $props();

  /** The current actor, parsed from the `actor-json` attribute (for "(you)"). */
  let currentActor = $derived.by<Actor | null>(() => {
    if (!actorJson) return null;
    try {
      return JSON.parse(actorJson) as Actor;
    } catch {
      return null;
    }
  });

  const api = $derived(
    new ShareApi({
      aclBase: apiBase || undefined,
      csrftoken: csrftoken || undefined,
    }),
  );

  // The authoritative share state from the server. Mutations update it
  // optimistically, then reconcile against the response (or revert on error).
  let share = $state<ShareState | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  // Per-principal "busy" set keyed by a principal key, so a row can disable its
  // own controls while its mutation is in flight without blocking the others.
  let busy = $state<Record<string, boolean>>({});

  let canManage = $derived(share?.can_manage === true);

  // The host element, so we can dispatch CustomEvents the way Google-Docs-style
  // hosts expect (e.g. paper re-runs its SSE subscriber sweep on revoke).
  let host: HTMLElement | undefined = $state();

  $effect(() => {
    // Re-load whenever the resource identity changes.
    const rt = resourceType;
    const p = parent;
    const c = child;
    if (!rt || !p) {
      loading = false;
      loadError = "Missing resource-type or parent";
      return;
    }
    void load(rt, p, c ?? null);
  });

  async function load(rt: string, p: string, c: string | null) {
    loading = true;
    loadError = null;
    try {
      share = await api.getResource(rt, p, c);
    } catch (err) {
      loadError = errorMessage(err, "Failed to load sharing");
      share = null;
    } finally {
      loading = false;
    }
  }

  function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof ShareApiError) return err.message || fallback;
    if (err instanceof Error) return err.message || fallback;
    return fallback;
  }

  /** A stable key for a grant's principal (used for busy-state + revoke body). */
  function principalKey(grant: Grant): string {
    return `${grant.principal}:${grant.id}`;
  }

  function principalOf(grant: Grant): Principal {
    return grant.principal === "group"
      ? { group_id: grant.id }
      : { actor_id: grant.id };
  }

  function isYou(grant: Grant): boolean {
    return (
      grant.principal === "actor" &&
      currentActor != null &&
      grant.id === currentActor.id
    );
  }

  function rowLabel(grant: Grant): string {
    const base = grant.display_name?.trim() || grant.id;
    if (grant.kind === "public") {
      return grant.id === "*" ? "Anyone" : "Anyone signed in";
    }
    return base;
  }

  function rowSubLabel(grant: Grant): string | null {
    if (grant.kind === "group") {
      const n = grant.member_count ?? 0;
      return `${n} member${n === 1 ? "" : "s"}`;
    }
    if (grant.kind === "user" && grant.email) return grant.email;
    return null;
  }

  function badge(kind: ActorKind): string | null {
    return kindBadge(kind);
  }

  // --- mutations -----------------------------------------------------------

  async function onRoleChange(grant: Grant, event: Event) {
    if (!share || !resourceType || !parent) return;
    const select = event.currentTarget as HTMLSelectElement;
    const newRole = select.value;
    const prevRole = grant.role;
    if (newRole === prevRole) return;

    const key = principalKey(grant);
    actionError = null;
    busy = { ...busy, [key]: true };

    // Optimistic: reflect the new role immediately.
    patchGrant(grant.id, grant.principal, { role: newRole });

    const request: GrantRequest = { ...principalOf(grant), role: newRole };
    try {
      const updated = await api.update(resourceType, parent, child ?? null, request);
      // Reconcile against the server's canonical row (role + actions).
      patchGrant(grant.id, grant.principal, updated);
      dispatch("share-updated", {
        principal: grant.principal,
        id: grant.id,
        role: updated.role,
      });
      dispatch("share-changed", {});
    } catch (err) {
      // Revert the optimistic change and surface the error.
      patchGrant(grant.id, grant.principal, { role: prevRole });
      select.value = prevRole ?? "";
      actionError = errorMessage(err, "Couldn't update role");
    } finally {
      busy = withoutKey(busy, key);
    }
  }

  async function onRemove(grant: Grant) {
    if (!share || !resourceType || !parent) return;
    const key = principalKey(grant);
    const removed = grant;
    actionError = null;
    busy = { ...busy, [key]: true };

    // Optimistic: drop the row.
    const previousGrants = share.grants;
    share.grants = share.grants.filter(
      (g) => !(g.principal === removed.principal && g.id === removed.id),
    );

    try {
      await api.revoke(resourceType, parent, child ?? null, principalOf(removed));
      dispatch("share-revoked", {
        principal: removed.principal,
        id: removed.id,
      });
      dispatch("share-changed", {});
    } catch (err) {
      // Restore the row in its original position.
      if (share) share.grants = previousGrants;
      actionError = errorMessage(err, "Couldn't remove access");
    } finally {
      busy = withoutKey(busy, key);
    }
  }

  /** Merge `patch` into the matching grant row in place (reactive). */
  function patchGrant(
    id: string,
    principal: Grant["principal"],
    patch: Partial<Grant>,
  ) {
    if (!share) return;
    share.grants = share.grants.map((g) =>
      g.id === id && g.principal === principal ? { ...g, ...patch } : g,
    );
  }

  function withoutKey(
    obj: Record<string, boolean>,
    key: string,
  ): Record<string, boolean> {
    const next = { ...obj };
    delete next[key];
    return next;
  }

  function dispatch(type: string, detail: unknown) {
    host?.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true }),
    );
  }

  // People-with-access ordering: owner first, then by descending role rank
  // (most-privileged first), then by label, mirroring Google Docs.
  let orderedGrants = $derived.by<Grant[]>(() =>
    share ? orderGrants(share.grants, share.roles, rowLabel) : [],
  );

  let dropdownRoles = $derived(selectableRoles(share?.roles ?? []));
</script>

<div class="datasette-share-dialog" bind:this={host}>
  <header class="datasette-share-dialog__header">
    <h2 class="datasette-share-dialog__title">
      {resourceLabel ? `Share “${resourceLabel}”` : "Share"}
    </h2>
  </header>

  {#if loading}
    <p class="datasette-share-dialog__loading">Loading…</p>
  {:else if loadError}
    <p class="datasette-share-dialog__error" role="alert">{loadError}</p>
  {:else if share}
    <section
      class="datasette-share-dialog__section"
      aria-label="People with access"
    >
      <h3 class="datasette-share-dialog__section-title">People with access</h3>

      {#if actionError}
        <p class="datasette-share-dialog__error" role="alert">{actionError}</p>
      {/if}

      <ul class="datasette-share-dialog__list">
        {#each orderedGrants as grant (principalKey(grant))}
          {@const owner = isOwnerGrant(grant)}
          {@const you = isYou(grant)}
          {@const rowBusy = busy[principalKey(grant)] === true}
          <li class="datasette-share-dialog__row" class:is-owner={owner}>
            <span class="datasette-share-dialog__avatar-wrap">
              {#if grant.avatar_url}
                <img
                  class="datasette-share-dialog__avatar"
                  src={grant.avatar_url}
                  alt=""
                  onerror={(e) => {
                    // profiles 404s when a person has no picture — fall back
                    // to the initials chip by hiding the broken image.
                    (e.currentTarget as HTMLImageElement).style.display =
                      "none";
                  }}
                />
              {/if}
              <span
                class="datasette-share-dialog__avatar datasette-share-dialog__avatar--initials"
                style:background-color={avatarColor(grant.id)}
                aria-hidden="true"
              >
                {initials(grant.display_name || grant.id)}
              </span>
              {#if badge(grant.kind)}
                <span
                  class="datasette-share-dialog__kind-badge"
                  title={grant.kind}>{badge(grant.kind)}</span
                >
              {/if}
            </span>

            <span class="datasette-share-dialog__identity">
              <span class="datasette-share-dialog__name">
                {rowLabel(grant)}{#if you}<span
                    class="datasette-share-dialog__you"> (you)</span
                  >{/if}
              </span>
              {#if rowSubLabel(grant)}
                <span class="datasette-share-dialog__sub"
                  >{rowSubLabel(grant)}</span
                >
              {/if}
            </span>

            <span class="datasette-share-dialog__controls">
              {#if owner}
                <span class="datasette-share-dialog__role-tag">Owner</span>
              {:else if canManage}
                <select
                  class="datasette-share-dialog__role-select"
                  aria-label={`Role for ${rowLabel(grant)}`}
                  value={grant.role ?? ""}
                  disabled={rowBusy}
                  onchange={(e) => onRoleChange(grant, e)}
                >
                  {#if grant.role == null}
                    <option value="" disabled>Custom</option>
                  {/if}
                  {#each dropdownRoles as role (role.name)}
                    <option value={role.name}>{role.name}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="datasette-share-dialog__remove"
                  aria-label={`Remove ${rowLabel(grant)}`}
                  disabled={rowBusy}
                  onclick={() => onRemove(grant)}
                >
                  ×
                </button>
              {:else}
                <span class="datasette-share-dialog__role-tag">
                  {grant.role ?? "Custom"}
                </span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .datasette-share-dialog {
    font-family:
      system-ui,
      -apple-system,
      "Segoe UI",
      sans-serif;
    color: #1f2328;
    max-width: 32rem;
  }
  .datasette-share-dialog__header {
    margin-bottom: 0.75rem;
  }
  .datasette-share-dialog__title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .datasette-share-dialog__section-title {
    margin: 0.75rem 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
  }
  .datasette-share-dialog__loading {
    color: #57606a;
    padding: 0.75rem 0;
  }
  .datasette-share-dialog__error {
    color: #a0202a;
    background: #ffebe9;
    border: 1px solid #ffced0;
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
  }
  .datasette-share-dialog__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .datasette-share-dialog__row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0;
    border-bottom: 1px solid #f0f1f2;
  }
  .datasette-share-dialog__row:last-child {
    border-bottom: none;
  }
  .datasette-share-dialog__avatar-wrap {
    position: relative;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
  }
  .datasette-share-dialog__avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }
  /* The initials chip sits behind the <img>; when the image loads it covers
   * the chip, and when it errors (onerror hides it) the chip shows through. */
  .datasette-share-dialog__avatar--initials {
    position: absolute;
    inset: 0;
    z-index: -1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .datasette-share-dialog__kind-badge {
    position: absolute;
    right: -2px;
    bottom: -2px;
    font-size: 0.6875rem;
    line-height: 1;
    background: #fff;
    border-radius: 50%;
    padding: 1px;
  }
  .datasette-share-dialog__identity {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .datasette-share-dialog__name {
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .datasette-share-dialog__you {
    color: #57606a;
  }
  .datasette-share-dialog__sub {
    font-size: 0.75rem;
    color: #57606a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .datasette-share-dialog__controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .datasette-share-dialog__role-select {
    font-size: 0.8125rem;
    padding: 0.25rem 0.375rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    color: inherit;
  }
  .datasette-share-dialog__role-select:disabled {
    opacity: 0.6;
  }
  .datasette-share-dialog__role-tag {
    font-size: 0.75rem;
    color: #57606a;
    padding: 0.125rem 0.5rem;
    background: #eef1f4;
    border-radius: 6px;
  }
  .datasette-share-dialog__remove {
    font-size: 1rem;
    line-height: 1;
    width: 1.5rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    cursor: pointer;
    color: #57606a;
  }
  .datasette-share-dialog__remove:hover:not(:disabled) {
    background: #ffebe9;
    border-color: #ffced0;
    color: #a0202a;
  }
  .datasette-share-dialog__remove:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
