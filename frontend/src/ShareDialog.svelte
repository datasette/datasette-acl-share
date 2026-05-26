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
  import { ShareApi, ShareApiError, capabilitiesFromFeatures } from "./lib/api";
  import { avatarColor, initials, kindBadge } from "./lib/avatar";
  import {
    currentWildcardGrant,
    defaultPickerRole,
    generalAccessRoles,
    isOwnerGrant,
    orderGrants,
    selectableRoles,
  } from "./lib/grants";
  import {
    actorLabel,
    debounce,
    existingActorGrant,
    filterAlreadyGranted,
    SEARCH_DEBOUNCE_MS,
  } from "./lib/people";
  import { agentLabel, filterAgents, normalizeAgents } from "./lib/agents";
  import {
    existingGroupGrant,
    filterGroups,
    groupIdStr,
    memberCountLabel,
  } from "./lib/groups";
  import type {
    Actor,
    ActorKind,
    Grant,
    GrantRequest,
    Group,
    Principal,
    ShareState,
    WildcardPrincipal,
  } from "./lib/types";

  let {
    "resource-type": resourceType,
    parent,
    child,
    "resource-label": resourceLabel,
    "actor-json": actorJson,
    csrftoken,
    "api-base": apiBase,
    features,
  }: {
    "resource-type"?: string;
    parent?: string;
    child?: string;
    "resource-label"?: string;
    "actor-json"?: string;
    csrftoken?: string;
    "api-base"?: string;
    features?: string;
  } = $props();

  /** Which optional sections to show. Derived from the host `features` attr
   * (comma list); missing/empty enables everything available. */
  let caps = $derived(capabilitiesFromFeatures(features));

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
  // (most-privileged first), then by label, mirroring Google Docs. Wildcard
  // (kind:"public") grants are excluded — they live in the General access
  // section, not the per-person list.
  let orderedGrants = $derived.by<Grant[]>(() =>
    share
      ? orderGrants(
          share.grants.filter((g) => g.kind !== "public"),
          share.roles,
          rowLabel,
        )
      : [],
  );

  let dropdownRoles = $derived(selectableRoles(share?.roles ?? []));

  // --- add-box picker ------------------------------------------------------

  type PickerTab = "people" | "agents" | "groups";

  // The tabs to show, in order, gated by capability. Agents is hidden when the
  // agent backend is absent; groups when disabled by features.
  let pickerTabs = $derived.by<PickerTab[]>(() => {
    const tabs: PickerTab[] = [];
    if (caps.people) tabs.push("people");
    if (caps.agents) tabs.push("agents");
    if (caps.groups) tabs.push("groups");
    return tabs;
  });

  let activeTab = $state<PickerTab | null>(null);

  // Keep the active tab valid as capabilities resolve.
  $effect(() => {
    if (pickerTabs.length === 0) {
      activeTab = null;
    } else if (activeTab == null || !pickerTabs.includes(activeTab)) {
      activeTab = pickerTabs[0]!;
    }
  });

  let query = $state("");
  // Raw results for the current tab + query (before dedupe/filter).
  let peopleResults = $state<Actor[]>([]);
  let agentResults = $state<Actor[]>([]);
  let groupList = $state<Group[]>([]); // groups are listed once, filtered locally
  let searching = $state(false);
  let pickerError = $state<string | null>(null);
  // The principal selected from the result list, pending a Share click.
  let selected = $state<
    | { kind: "actor"; actor: Actor }
    | { kind: "group"; group: Group }
    | null
  >(null);
  let pickerRole = $state<string>("");
  let granting = $state(false);
  // Set to a principal key to flash/scroll its existing row when a duplicate
  // add is attempted; the row reads this to apply a highlight.
  let focusKey = $state<string | null>(null);

  // Default the add-box role to the type's lowest write role (≈ Editor).
  $effect(() => {
    const def = defaultPickerRole(share?.roles ?? []);
    if (def && (pickerRole === "" || !dropdownRoles.some((r) => r.name === pickerRole))) {
      pickerRole = def;
    }
  });

  // De-duped, ready-to-render result lists for the active tab.
  let peopleOptions = $derived(
    filterAlreadyGranted(peopleResults, share?.grants ?? []),
  );
  let agentOptions = $derived(
    filterAgents(normalizeAgents(agentResults), share?.grants ?? []),
  );
  let groupOptions = $derived(
    filterGroups(groupList, share?.grants ?? [], query),
  );

  // Debounced search runners (one per searchable tab). Re-created if `api`
  // changes (e.g. api-base attr changes) so they close over the live client.
  let runPeopleSearch = $derived(
    debounce((q: string) => void doSearchPeople(q), SEARCH_DEBOUNCE_MS),
  );
  let runAgentSearch = $derived(
    debounce((q: string) => void doSearchAgents(q), SEARCH_DEBOUNCE_MS),
  );

  async function doSearchPeople(q: string) {
    searching = true;
    pickerError = null;
    try {
      peopleResults = await api.searchPeople(q);
    } catch (err) {
      peopleResults = [];
      pickerError = errorMessage(err, "Search failed");
    } finally {
      searching = false;
    }
  }

  async function doSearchAgents(q: string) {
    searching = true;
    pickerError = null;
    try {
      agentResults = await api.listAgents(q);
    } catch (err) {
      agentResults = [];
      pickerError = errorMessage(err, "Couldn't list agents");
    } finally {
      searching = false;
    }
  }

  async function loadGroups() {
    searching = true;
    pickerError = null;
    try {
      groupList = await api.listGroups();
    } catch (err) {
      groupList = [];
      pickerError = errorMessage(err, "Couldn't list groups");
    } finally {
      searching = false;
    }
  }

  function selectTab(tab: PickerTab) {
    if (activeTab === tab) return;
    activeTab = tab;
    query = "";
    selected = null;
    pickerError = null;
    runPeopleSearch.cancel();
    runAgentSearch.cancel();
    if (tab === "groups") void loadGroups();
  }

  function onQueryInput(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    selected = null;
    if (activeTab === "people") runPeopleSearch(query);
    else if (activeTab === "agents") runAgentSearch(query);
    // groups filter locally via the derived list — no request needed.
  }

  function selectActor(actor: Actor) {
    // If this principal already has a grant, focus its row instead of adding.
    const existing = existingActorGrant(share?.grants ?? [], actor.id);
    if (existing) {
      flashExisting(existing);
      return;
    }
    selected = { kind: "actor", actor };
  }

  function selectGroup(group: Group) {
    const existing = existingGroupGrant(share?.grants ?? [], group.id);
    if (existing) {
      flashExisting(existing);
      return;
    }
    selected = { kind: "group", group };
  }

  function flashExisting(grant: Grant) {
    selected = null;
    const key = principalKey(grant);
    focusKey = key;
    pickerError = `${rowLabel(grant)} already has access.`;
    queueMicrotask(() => {
      const el = host?.querySelector<HTMLElement>(
        `[data-principal-key="${cssEscape(key)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
    // Clear the highlight after a moment so it reads as a flash.
    setTimeout(() => {
      if (focusKey === key) focusKey = null;
    }, 1600);
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
  }

  function selectedPrincipal(): Principal | null {
    if (!selected) return null;
    return selected.kind === "actor"
      ? { actor_id: selected.actor.id }
      : { group_id: selected.group.id };
  }

  function selectedLabel(): string {
    if (!selected) return "";
    return selected.kind === "actor"
      ? actorLabel(selected.actor)
      : selected.group.name;
  }

  async function onShare() {
    if (!share || !resourceType || !parent) return;
    const principal = selectedPrincipal();
    if (!principal || !pickerRole) return;
    granting = true;
    pickerError = null;
    actionError = null;
    const request: GrantRequest = { ...principal, role: pickerRole };
    try {
      const grant = await api.grant(resourceType, parent, child ?? null, request);
      // Insert the new row (or replace any stale row for the same principal).
      if (share) {
        const without = share.grants.filter(
          (g) => !(g.principal === grant.principal && g.id === grant.id),
        );
        share.grants = [...without, grant];
      }
      dispatch("share-granted", {
        principal: grant.principal,
        id: grant.id,
        role: grant.role,
      });
      dispatch("share-changed", {});
      // Reset the add-box for the next add.
      selected = null;
      query = "";
      peopleResults = [];
      agentResults = [];
    } catch (err) {
      pickerError = errorMessage(err, "Couldn't share");
    } finally {
      granting = false;
    }
  }

  function pickerEmptyMessage(): string {
    if (searching) return "Searching…";
    if (activeTab === "people") {
      return query.trim() ? "No people found" : "Type to search people";
    }
    if (activeTab === "agents") {
      return query.trim() ? "No agents found" : "Type to search agents";
    }
    return "No groups";
  }

  // --- general access ------------------------------------------------------

  // The "Restricted" sentinel for the principal selector (no wildcard grant).
  const RESTRICTED = "" as const;

  // The current wildcard grant (kind:"public"), reflected into the controls.
  let wildcard = $derived(currentWildcardGrant(share?.grants ?? []));

  // Which wildcard principal is currently active ("" = Restricted).
  let generalPrincipal = $derived<WildcardPrincipal | "">(
    wildcard ? (wildcard.id as WildcardPrincipal) : RESTRICTED,
  );

  // The current general-access role (only meaningful when not Restricted).
  let generalRole = $derived<string>(wildcard?.role ?? "");

  let generalRoles = $derived(generalAccessRoles(share?.roles ?? []));
  let generalBusy = $state(false);
  let generalError = $state<string | null>(null);

  function generalPrincipalLabel(p: WildcardPrincipal | ""): string {
    if (p === "*") return "Anyone";
    if (p === "_signed_in") return "Anyone signed in";
    return "Restricted";
  }

  async function onGeneralPrincipalChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value as
      | WildcardPrincipal
      | "";
    if (value === RESTRICTED) {
      await revokeWildcard();
      return;
    }
    // Granting a new wildcard principal: if switching from another wildcard,
    // revoke the old one first so only one general-access row exists.
    const role = generalRole || defaultPickerRole(share?.roles ?? []) || "";
    const previous = wildcard;
    await setWildcard(value, role, previous);
  }

  async function onGeneralRoleChange(event: Event) {
    const role = (event.currentTarget as HTMLSelectElement).value;
    const principal = generalPrincipal;
    if (principal === RESTRICTED || !role) return;
    await setWildcard(principal, role, null);
  }

  async function setWildcard(
    principal: WildcardPrincipal,
    role: string,
    revokePrevious: Grant | null,
  ) {
    if (!resourceType || !parent || !role) return;
    generalBusy = true;
    generalError = null;
    try {
      if (revokePrevious && revokePrevious.id !== principal) {
        await api.revoke(resourceType, parent, child ?? null, {
          actor_id: revokePrevious.id,
        });
      }
      const grant = await api.grant(resourceType, parent, child ?? null, {
        actor_id: principal,
        role,
      });
      if (share) {
        const without = share.grants.filter((g) => g.kind !== "public");
        share.grants = [...without, grant];
      }
      dispatch("share-granted", {
        principal: "actor",
        id: grant.id,
        role: grant.role,
      });
      dispatch("share-changed", {});
    } catch (err) {
      generalError = errorMessage(err, "Couldn't change general access");
    } finally {
      generalBusy = false;
    }
  }

  async function revokeWildcard() {
    if (!resourceType || !parent) return;
    const grant = wildcard;
    if (!grant) return;
    generalBusy = true;
    generalError = null;
    try {
      await api.revoke(resourceType, parent, child ?? null, {
        actor_id: grant.id,
      });
      if (share) {
        share.grants = share.grants.filter((g) => g.kind !== "public");
      }
      dispatch("share-revoked", { principal: "actor", id: grant.id });
      dispatch("share-changed", {});
    } catch (err) {
      generalError = errorMessage(err, "Couldn't change general access");
    } finally {
      generalBusy = false;
    }
  }
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
    {#if canManage && pickerTabs.length > 0}
      <section
        class="datasette-share-dialog__add"
        aria-label="Add people, agents or groups"
      >
        {#if pickerTabs.length > 1}
          <div
            class="datasette-share-dialog__tabs"
            role="tablist"
            aria-label="Pick principal type"
          >
            {#each pickerTabs as tab (tab)}
              <button
                type="button"
                role="tab"
                id={`datasette-share-tab-${tab}`}
                aria-selected={activeTab === tab}
                aria-controls="datasette-share-results"
                class="datasette-share-dialog__tab"
                class:is-active={activeTab === tab}
                onclick={() => selectTab(tab)}
              >
                {tab === "people"
                  ? "People"
                  : tab === "agents"
                    ? "Agents"
                    : "Groups"}
              </button>
            {/each}
          </div>
        {/if}

        <div class="datasette-share-dialog__add-row">
          <input
            type="search"
            class="datasette-share-dialog__search"
            placeholder={activeTab === "groups"
              ? "Filter groups…"
              : activeTab === "agents"
                ? "Search agents…"
                : "Search people…"}
            aria-label={activeTab === "groups"
              ? "Filter groups"
              : activeTab === "agents"
                ? "Search agents"
                : "Search people"}
            value={query}
            oninput={onQueryInput}
          />
          <select
            class="datasette-share-dialog__role-select"
            aria-label="Role for new share"
            bind:value={pickerRole}
            disabled={granting}
          >
            {#each dropdownRoles as role (role.name)}
              <option value={role.name}>{role.name}</option>
            {/each}
          </select>
          <button
            type="button"
            class="datasette-share-dialog__share-btn"
            disabled={selected == null || granting || !pickerRole}
            onclick={onShare}
          >
            {granting ? "Sharing…" : "Share"}
          </button>
        </div>

        {#if selected}
          <p class="datasette-share-dialog__selected" aria-live="polite">
            Selected: <strong>{selectedLabel()}</strong>
            <button
              type="button"
              class="datasette-share-dialog__clear-selected"
              aria-label="Clear selection"
              onclick={() => (selected = null)}>×</button
            >
          </p>
        {/if}

        {#if pickerError}
          <p class="datasette-share-dialog__error" role="alert">{pickerError}</p>
        {/if}

        <ul
          id="datasette-share-results"
          class="datasette-share-dialog__results"
          role="listbox"
          aria-label="Search results"
          aria-busy={searching}
        >
          {#if activeTab === "people"}
            {#each peopleOptions as actor (actor.id)}
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.kind === "actor" &&
                    selected.actor.id === actor.id}
                  class="datasette-share-dialog__result"
                  onclick={() => selectActor(actor)}
                >
                  <span
                    class="datasette-share-dialog__avatar datasette-share-dialog__avatar--initials datasette-share-dialog__result-avatar"
                    style:background-color={avatarColor(actor.id)}
                    aria-hidden="true">{initials(actor.display_name || actor.id)}</span
                  >
                  <span class="datasette-share-dialog__result-text">
                    <span class="datasette-share-dialog__name">{actorLabel(actor)}</span>
                    {#if actor.email}
                      <span class="datasette-share-dialog__sub">{actor.email}</span>
                    {/if}
                  </span>
                </button>
              </li>
            {:else}
              <li class="datasette-share-dialog__empty">{pickerEmptyMessage()}</li>
            {/each}
          {:else if activeTab === "agents"}
            {#each agentOptions as agent (agent.id)}
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.kind === "actor" &&
                    selected.actor.id === agent.id}
                  class="datasette-share-dialog__result"
                  onclick={() => selectActor(agent)}
                >
                  <span
                    class="datasette-share-dialog__avatar datasette-share-dialog__avatar--initials datasette-share-dialog__result-avatar"
                    style:background-color={avatarColor(agent.id)}
                    aria-hidden="true">{initials(agentLabel(agent))}</span
                  >
                  <span class="datasette-share-dialog__result-text">
                    <span class="datasette-share-dialog__name"
                      >{agentLabel(agent)} <span aria-hidden="true">🤖</span></span
                    >
                  </span>
                </button>
              </li>
            {:else}
              <li class="datasette-share-dialog__empty">{pickerEmptyMessage()}</li>
            {/each}
          {:else if activeTab === "groups"}
            {#each groupOptions as group (groupIdStr(group.id))}
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.kind === "group" &&
                    groupIdStr(selected.group.id) === groupIdStr(group.id)}
                  class="datasette-share-dialog__result"
                  onclick={() => selectGroup(group)}
                >
                  <span
                    class="datasette-share-dialog__avatar datasette-share-dialog__avatar--initials datasette-share-dialog__result-avatar"
                    style:background-color={avatarColor(groupIdStr(group.id))}
                    aria-hidden="true">👥</span
                  >
                  <span class="datasette-share-dialog__result-text">
                    <span class="datasette-share-dialog__name">{group.name}</span>
                    <span class="datasette-share-dialog__sub"
                      >{memberCountLabel(group.member_count)}</span
                    >
                  </span>
                </button>
              </li>
            {:else}
              <li class="datasette-share-dialog__empty">{pickerEmptyMessage()}</li>
            {/each}
          {/if}
        </ul>
      </section>
    {/if}

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
          <li
            class="datasette-share-dialog__row"
            class:is-owner={owner}
            class:is-flash={focusKey === principalKey(grant)}
            data-principal-key={principalKey(grant)}
          >
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

    {#if caps.public}
      <section
        class="datasette-share-dialog__section datasette-share-dialog__general"
        aria-label="General access"
      >
        <h3 class="datasette-share-dialog__section-title">General access</h3>

        {#if generalError}
          <p class="datasette-share-dialog__error" role="alert">{generalError}</p>
        {/if}

        <div class="datasette-share-dialog__general-row">
          <span
            class="datasette-share-dialog__avatar datasette-share-dialog__avatar--initials"
            style:background-color={generalPrincipal === RESTRICTED
              ? "#57606a"
              : avatarColor(generalPrincipal)}
            aria-hidden="true"
          >
            {generalPrincipal === RESTRICTED ? "🔒" : "🌐"}
          </span>

          <span class="datasette-share-dialog__general-text">
            {#if canManage}
              <select
                class="datasette-share-dialog__general-principal"
                aria-label="General access"
                value={generalPrincipal}
                disabled={generalBusy}
                onchange={onGeneralPrincipalChange}
              >
                <option value={RESTRICTED}>Restricted</option>
                <option value="_signed_in">Anyone signed in</option>
                <option value="*">Anyone</option>
              </select>
            {:else}
              <span class="datasette-share-dialog__name"
                >{generalPrincipalLabel(generalPrincipal)}</span
              >
            {/if}
            <span class="datasette-share-dialog__sub">
              {#if generalPrincipal === RESTRICTED}
                Only people with access can open
              {:else if generalPrincipal === "*"}
                Anyone on the internet can access
              {:else}
                Anyone signed in can access
              {/if}
            </span>
          </span>

          {#if generalPrincipal !== RESTRICTED}
            {#if canManage}
              <select
                class="datasette-share-dialog__role-select"
                aria-label="General access role"
                value={generalRole}
                disabled={generalBusy}
                onchange={onGeneralRoleChange}
              >
                {#if generalRole && !generalRoles.some((r) => r.name === generalRole)}
                  <option value={generalRole} disabled>{generalRole}</option>
                {/if}
                {#each generalRoles as role (role.name)}
                  <option value={role.name}>{role.name}</option>
                {/each}
              </select>
            {:else}
              <span class="datasette-share-dialog__role-tag"
                >{generalRole || "Custom"}</span
              >
            {/if}
          {/if}
        </div>
      </section>
    {/if}
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

  /* --- add box ----------------------------------------------------------- */
  .datasette-share-dialog__add {
    margin-bottom: 0.5rem;
  }
  .datasette-share-dialog__tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }
  .datasette-share-dialog__tab {
    font-size: 0.8125rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid #d0d7de;
    border-radius: 999px;
    background: #fff;
    color: #57606a;
    cursor: pointer;
  }
  .datasette-share-dialog__tab.is-active {
    background: #1f6feb;
    border-color: #1f6feb;
    color: #fff;
  }
  .datasette-share-dialog__add-row {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }
  .datasette-share-dialog__search {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.875rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .datasette-share-dialog__share-btn {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid #1f6feb;
    border-radius: 6px;
    background: #1f6feb;
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
  }
  .datasette-share-dialog__share-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .datasette-share-dialog__selected {
    margin: 0.375rem 0 0;
    font-size: 0.8125rem;
    color: #57606a;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .datasette-share-dialog__clear-selected {
    border: none;
    background: transparent;
    cursor: pointer;
    color: #57606a;
    font-size: 1rem;
    line-height: 1;
  }
  .datasette-share-dialog__results {
    list-style: none;
    margin: 0.375rem 0 0;
    padding: 0;
    max-height: 12rem;
    overflow-y: auto;
  }
  .datasette-share-dialog__result {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    padding: 0.375rem 0.25rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 6px;
    color: inherit;
  }
  .datasette-share-dialog__result:hover,
  .datasette-share-dialog__result:focus-visible,
  .datasette-share-dialog__result[aria-selected="true"] {
    background: #eef3fb;
    outline: none;
  }
  .datasette-share-dialog__result-avatar {
    position: static;
    inset: auto;
    z-index: auto;
    flex: 0 0 auto;
  }
  .datasette-share-dialog__result-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .datasette-share-dialog__empty {
    color: #57606a;
    font-size: 0.8125rem;
    padding: 0.5rem 0.25rem;
  }

  /* --- duplicate-add flash ---------------------------------------------- */
  .datasette-share-dialog__row.is-flash {
    animation: datasette-share-flash 1.6s ease-out;
  }
  @keyframes datasette-share-flash {
    0%,
    40% {
      background: #fff8c5;
    }
    100% {
      background: transparent;
    }
  }

  /* --- general access ---------------------------------------------------- */
  .datasette-share-dialog__general-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0;
  }
  .datasette-share-dialog__general-row
    .datasette-share-dialog__avatar--initials {
    position: static;
    inset: auto;
    z-index: auto;
    flex: 0 0 auto;
    font-size: 0.875rem;
  }
  .datasette-share-dialog__general-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
    gap: 0.125rem;
  }
  .datasette-share-dialog__general-principal {
    font-size: 0.875rem;
    padding: 0.25rem 0.375rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    color: inherit;
    align-self: flex-start;
  }
</style>
