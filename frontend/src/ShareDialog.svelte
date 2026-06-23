<svelte:options
  customElement={{
    tag: "datasette-acl-share-dialog",
    // Light DOM (no shadow root) so host pages can theme the dialog and there
    // are no shadow-DOM form/focus quirks. Styles are emitted with
    // `datasette-acl-share-`-prefixed selectors (see plan §2).
    shadow: "none",
  }}
/>

<script lang="ts">
  import { ShareApi, ShareApiError, capabilitiesFromFeatures } from "./lib/api";
  import { avatarColor, initials, kindBadge } from "./lib/avatar";
  import {
    ICON_GLOBE,
    ICON_INCOGNITO,
    ICON_PEOPLE,
    ICON_PERSON,
    ICON_PLUS,
  } from "./lib/icons";
  import {
    audienceLabel,
    audienceSublabel,
    availableAudiencesToAdd,
    defaultPickerRole,
    defaultPublicRole,
    generalAccessRoles,
    isLastManageGrant,
    isOwnerGrant,
    orderGrants,
    publicGrants,
    selectableRoles,
  } from "./lib/grants";
  import { debounce, filterAlreadyGranted, SEARCH_DEBOUNCE_MS } from "./lib/people";
  import {
    filterGroups,
    groupIdStr,
    memberCountLabel,
  } from "./lib/groups";
  import {
    addPill,
    batchGrantRequests,
    blockingGrant,
    hasPill,
    pillFromActor,
    pillFromGroup,
    pillKey,
    removePill,
    type Pill,
  } from "./lib/pills";
  import type {
    Actor,
    ActorKind,
    Grant,
    GrantRequest,
    Group,
    Principal,
    PublicAudience,
    ShareState,
  } from "./lib/types";

  let {
    "resource-type": resourceType,
    parent,
    child,
    "resource-label": resourceLabel,
    "actor-json": actorJson,
    "api-base": apiBase,
    features,
    open: openAttr,
    "trigger-label": triggerLabel,
    disabled: disabledAttr,
  }: {
    "resource-type"?: string;
    parent?: string;
    child?: string;
    "resource-label"?: string;
    "actor-json"?: string;
    "api-base"?: string;
    features?: string;
    /** When set (non-"false"), open the modal on mount instead of waiting for a
     * trigger click. */
    open?: string;
    /** Optional text shown next to the share icon on the trigger button. */
    "trigger-label"?: string;
    /** When set (non-"false"), disable the trigger so the dialog can't open
     * (e.g. the current actor isn't allowed to share this resource). */
    disabled?: string;
  } = $props();

  let isDisabled = $derived(disabledAttr != null && disabledAttr !== "false");

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
      // Thread the dialog's resource onto picker calls so the acl picker
      // endpoints can authorize a per-resource Manager (a doc owner with no
      // global `datasette-acl` admin) instead of rejecting them.
      resource:
        resourceType && parent
          ? { resourceType, parent, child: child ?? null }
          : undefined,
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

  // The modal. The dialog renders behind a share-icon trigger and is shown with
  // the native <dialog> modal (showModal) so it overlays the page rather than
  // sitting inline.
  let dialogEl = $state<HTMLDialogElement>();
  // Whether the dialog has ever been opened — gates the initial load so a
  // closed trigger costs no network (a page can have many share buttons).
  let hasOpened = $state(false);

  /** Accessible label for the trigger; distinct from the inner "Share" submit
   * button so both are unambiguous to assistive tech and tests. */
  let triggerAriaLabel = $derived(
    resourceLabel ? `Share “${resourceLabel}”` : "Share",
  );

  function openDialog() {
    if (isDisabled) return;
    hasOpened = true;
    if (dialogEl && !dialogEl.open) dialogEl.showModal();
  }

  function closeDialog() {
    dialogEl?.close();
  }

  /** A click whose target is the dialog element itself (not its content) is a
   * click on the ::backdrop — dismiss, like a typical modal. */
  function onDialogClick(event: MouseEvent) {
    if (event.target === dialogEl) closeDialog();
  }

  // Auto-open when the `open` attribute is set (host opt-in; also used by tests).
  let wantOpen = $derived(openAttr != null && openAttr !== "false");
  $effect(() => {
    if (wantOpen && dialogEl && !dialogEl.open) openDialog();
  });

  $effect(() => {
    // (Re)load whenever the resource identity changes, but only once the dialog
    // has been opened.
    const rt = resourceType;
    const p = parent;
    const c = child;
    if (!hasOpened) return;
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
      await enrichRoster();
    } catch (err) {
      loadError = loadErrorMessage(err);
      share = null;
    } finally {
      loading = false;
    }
  }

  /** Friendly message for a failed initial load. acl's read endpoint is
   * manager-only (v1), so a 403 here isn't a generic failure — it means the
   * actor can use the resource but isn't allowed to manage who it's shared
   * with. Say that plainly instead of leaking the raw "Request failed (403)". */
  function loadErrorMessage(err: unknown): string {
    if (err instanceof ShareApiError && err.status === 403) {
      return "You don't have permission to manage sharing for this. Ask someone who manages it to change who has access.";
    }
    return errorMessage(err, "Failed to load sharing");
  }

  /** acl's read endpoint returns actor grants as bare ids (it enriches via the
   * firstresult `actors_from_ids` hook, which user-profiles doesn't implement).
   * When People search is available, batch-resolve those ids against profiles'
   * resolve endpoint and merge display name / email onto each grant so the
   * roster shows "Clark Kent" rather than "clark". Best-effort: any failure
   * leaves the bare-id fallback in place. */
  async function enrichRoster() {
    if (!share || !caps.people) return;
    const ids = share.grants
      .filter((g) => g.kind === "user" && !g.display_name)
      .map((g) => g.id);
    if (ids.length === 0) return;
    let resolved: Record<string, Actor>;
    try {
      resolved = await api.resolveActors([...new Set(ids)]);
    } catch {
      return; // profiles absent or restricted — keep the id/email fallback
    }
    share.grants = share.grants.map((g) => {
      const hit = g.kind === "user" ? resolved[g.id] : undefined;
      return hit
        ? {
            ...g,
            display_name: hit.display_name ?? g.display_name,
            email: hit.email ?? g.email,
          }
        : g;
    });
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
    if (grant.principal === "group") {
      return { group_id: grant.id };
    }
    // A public audience is identified by its principal_type alone (no id).
    if (grant.kind === "public") {
      return { principal_type: grant.id as PublicAudience };
    }
    // Explicit principal_type so mutations on an actor never touch a like-named
    // general-access audience (and vice versa).
    return { actor_id: grant.id, principal_type: "actor" };
  }

  function isYou(grant: Grant): boolean {
    return (
      grant.principal === "actor" &&
      currentActor != null &&
      grant.id === currentActor.id
    );
  }

  function rowLabel(grant: Grant): string {
    if (grant.kind === "public") {
      return grant.display_name?.trim() || audienceLabel(grant.id);
    }
    // For actors with no profile name, fall back to email before the raw id so
    // we never surface a bare numeric actor id as someone's name.
    return grant.display_name?.trim() || grant.email?.trim() || grant.id;
  }

  function rowSubLabel(grant: Grant): string | null {
    if (grant.kind === "group") {
      const n = grant.member_count ?? 0;
      return `${n} member${n === 1 ? "" : "s"}`;
    }
    // Show the email under the name only when the name isn't already the email
    // (i.e. when a display name was present); otherwise it would just repeat.
    if (grant.kind === "user" && grant.email && grant.display_name?.trim()) {
      return grant.email;
    }
    return null;
  }

  function badge(kind: ActorKind): string | null {
    return kindBadge(kind);
  }

  // --- mutations -----------------------------------------------------------

  /** Shown when the user tries to strand the resource by removing/downgrading
   * its only manager. */
  const ORPHAN_REMOVE_MESSAGE =
    "Can't remove the only manager — the resource would be left with nobody " +
    "able to manage sharing. Grant another person or group a managing role first.";
  const ORPHAN_DOWNGRADE_MESSAGE =
    "Can't change the only manager's role — the resource would be left with " +
    "nobody able to manage sharing. Grant another person or group a managing " +
    "role first.";

  async function onRoleChange(grant: Grant, event: Event) {
    if (!share || !resourceType || !parent) return;
    const select = event.currentTarget as HTMLSelectElement;
    const newRole = select.value;
    const prevRole = grant.role;
    if (newRole === prevRole) return;

    // Same orphan guard as removal: downgrading the last manager to a
    // non-manage role would leave nobody able to manage. Revert the <select>
    // and surface the reason rather than stranding the resource.
    const newRoleManages =
      share.roles.find((r) => r.name === newRole)?.manage === true;
    if (
      !newRoleManages &&
      isLastManageGrant(grant, share.grants, share.roles)
    ) {
      select.value = prevRole ?? "";
      actionError = ORPHAN_DOWNGRADE_MESSAGE;
      return;
    }

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
    // Guard against orphaning: refuse to revoke the resource's last
    // manage-capable grant. Without a manager nobody can re-open this dialog
    // (acl's read endpoint is manager-only), so the resource would be stranded.
    if (isLastManageGrant(grant, share.grants, share.roles)) {
      actionError = ORPHAN_REMOVE_MESSAGE;
      return;
    }
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
  // Unified people-or-groups search: one combobox queries People (async, via
  // profiles) and Groups (acl, fetched once then filtered locally) at the same
  // time, merging both into a single results dropdown — no tabs. Available
  // whenever the actor can manage and at least one backend is present.
  let pickerAvailable = $derived(canManage && (caps.people || caps.groups));

  let query = $state("");
  // Raw results for the current tab + query (before dedupe/filter).
  let peopleResults = $state<Actor[]>([]);
  let groupList = $state<Group[]>([]); // groups are listed once, filtered locally
  let searching = $state(false);
  let pickerError = $state<string | null>(null);
  // The principals queued for a batch share, rendered as removable pills. The
  // role <select> + Share button apply to all of them at once.
  let pills = $state<Pill[]>([]);
  let pickerRole = $state<string>("");
  let granting = $state(false);
  // Set to a principal key to flash/scroll its existing row when a duplicate
  // add is attempted; the row reads this to apply a highlight.
  let focusKey = $state<string | null>(null);

  // --- overlay dropdown state ----------------------------------------------
  // The results render as a floating autocomplete overlay (absolutely
  // positioned under the search input) so the rest of the dialog doesn't
  // reflow when results appear.
  let dropdownOpen = $state(false);
  // Index of the keyboard-highlighted option within the active tab's options,
  // or -1 when nothing is highlighted yet.
  let highlight = $state(-1);
  let searchEl: HTMLInputElement | undefined = $state();
  let addBoxEl: HTMLElement | undefined = $state();

  // Default the add-box role to the type's lowest write role (≈ Editor).
  $effect(() => {
    const def = defaultPickerRole(share?.roles ?? []);
    if (def && (pickerRole === "" || !dropdownRoles.some((r) => r.name === pickerRole))) {
      pickerRole = def;
    }
  });

  // De-duped, ready-to-render result lists for the active tab. Already-granted
  // principals are filtered by the lib helpers; already-queued pills are then
  // dropped here so a pill can't be added twice.
  let peopleOptions = $derived(
    filterAlreadyGranted(peopleResults, share?.grants ?? []).filter(
      (a) => !hasPill(pills, { principal: "actor", id: a.id }),
    ),
  );
  let groupOptions = $derived(
    filterGroups(groupList, share?.grants ?? [], query).filter(
      (g) => !hasPill(pills, { principal: "group", id: groupIdStr(g.id) }),
    ),
  );

  // Each source as its own pill list (rendered under a "People"/"Groups"
  // subheader when both are present), plus a flat concatenation for keyboard
  // navigation + Enter-to-pick. People come first, then groups; the flat order
  // must match the rendered listbox so `highlight` indexes line up.
  let peoplePills = $derived(
    caps.people ? peopleOptions.map(pillFromActor) : [],
  );
  let groupPills = $derived(
    caps.groups ? groupOptions.map(pillFromGroup) : [],
  );
  let optionPills = $derived<Pill[]>([...peoplePills, ...groupPills]);
  // Show the subheaders only when both backends can contribute results.
  let showResultGroups = $derived(caps.people && caps.groups);

  // Whether the floating results overlay should be visible: open + something
  // to show (results, the "searching…"/"empty" hint, or a picker error).
  let showDropdown = $derived(dropdownOpen && pickerAvailable);

  // Keep the highlight within bounds as the option list changes.
  $effect(() => {
    if (highlight >= optionPills.length) highlight = optionPills.length - 1;
  });

  // Debounced search runners (one per searchable tab). Re-created if `api`
  // changes (e.g. api-base attr changes) so they close over the live client.
  let runPeopleSearch = $derived(
    debounce((q: string) => void doSearchPeople(q), SEARCH_DEBOUNCE_MS),
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

  function onQueryInput(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    highlight = -1;
    openDropdown();
    if (caps.people) runPeopleSearch(query);
    // groups filter locally via the derived list — no request needed.
  }

  function openDropdown() {
    dropdownOpen = true;
  }

  function onSearchFocus() {
    // Re-open on focus so a dismissed dropdown comes back without retyping.
    openDropdown();
    // Groups are listed once then filtered locally; (re)load if we haven't yet
    // so they're ready to surface alongside people results.
    if (caps.groups && groupList.length === 0 && !searching) {
      void loadGroups();
    }
  }

  /** Pick an option pill: add it (or flash an existing row for a dup grant). */
  function pickOption(pill: Pill) {
    const existing = blockingGrant(share?.grants ?? [], pill);
    if (existing) {
      flashExisting(existing);
      return;
    }
    pills = addPill(pills, pill);
    pickerError = null;
    // Clear the query so the next search starts fresh; keep the box focused so
    // the user can keep adding without re-clicking.
    query = "";
    highlight = -1;
    peopleResults = [];
    runPeopleSearch.cancel();
    searchEl?.focus();
    // Keep the dropdown open so the user can keep adding: people need a fresh
    // keystroke, while any groups stay visible (now filtered by the empty
    // query, i.e. the full list minus what's already picked/granted).
  }

  function removePillAt(pill: Pill) {
    pills = removePill(pills, pill);
  }

  function flashExisting(grant: Grant) {
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

  /** Keyboard support on the search box: arrow-key highlight + Enter picks,
   * Escape dismisses the dropdown. */
  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (dropdownOpen) {
        event.preventDefault();
        dropdownOpen = false;
        highlight = -1;
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openDropdown();
      if (optionPills.length > 0) {
        highlight = (highlight + 1) % optionPills.length;
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openDropdown();
      if (optionPills.length > 0) {
        highlight =
          highlight <= 0 ? optionPills.length - 1 : highlight - 1;
      }
      return;
    }
    if (event.key === "Enter") {
      if (optionPills.length === 0) return;
      event.preventDefault();
      // Enter picks the highlighted option, or the first when none highlighted.
      const idx = highlight >= 0 ? highlight : 0;
      const pill = optionPills[idx];
      if (pill) pickOption(pill);
    }
  }

  // Dismiss the overlay on a click or focus that lands outside the add-box.
  $effect(() => {
    if (!showDropdown) return;
    const onOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (addBoxEl && target && !addBoxEl.contains(target)) {
        dropdownOpen = false;
        highlight = -1;
      }
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("focusin", onOutside, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("focusin", onOutside, true);
    };
  });

  async function onShare() {
    if (!share || !resourceType || !parent) return;
    if (pills.length === 0 || !pickerRole) return;
    granting = true;
    pickerError = null;
    actionError = null;
    const role = pickerRole;
    const requests = batchGrantRequests(pills, role);
    const failed: { label: string; message: string }[] = [];
    const granted: Grant[] = [];
    // Grant each pill in turn (reuse ShareApi.grant per pill); collect the
    // results so we can reconcile the list and report any failures.
    for (let i = 0; i < requests.length; i++) {
      const pill = pills[i]!;
      try {
        const grant = await api.grant(
          resourceType,
          parent,
          child ?? null,
          requests[i]!,
        );
        granted.push(grant);
        dispatch("share-granted", {
          principal: grant.principal,
          id: grant.id,
          role: grant.role,
        });
      } catch (err) {
        failed.push({
          label: pill.label,
          message: errorMessage(err, "couldn't share"),
        });
      }
    }
    // Merge granted rows (replacing any stale row for the same principal).
    if (granted.length > 0 && share) {
      const keys = new Set(
        granted.map((g) => `${g.principal}:${g.id}`),
      );
      const without = share.grants.filter(
        (g) => !keys.has(`${g.principal}:${g.id}`),
      );
      share.grants = [...without, ...granted];
      dispatch("share-changed", {});
    }
    // Drop the successfully-granted pills; keep any that failed so the user can
    // retry. Reset the box when everything succeeded.
    if (failed.length === 0) {
      pills = [];
      query = "";
      peopleResults = [];
      dropdownOpen = false;
    } else {
      const grantedKeys = new Set(granted.map((g) => `${g.principal}:${g.id}`));
      pills = pills.filter((p) => !grantedKeys.has(pillKey(p)));
      pickerError = failed
        .map((f) => `${f.label}: ${f.message}`)
        .join("; ");
    }
    granting = false;
  }

  function pickerEmptyMessage(): string {
    if (searching) return "Searching…";
    const what =
      caps.people && caps.groups
        ? "people or groups"
        : caps.groups
          ? "groups"
          : "people";
    return query.trim() ? `No ${what} found` : `Type to search ${what}`;
  }

  // --- general access (public audiences) -----------------------------------
  //
  // acl models everyone / authenticated / anonymous as independent principals,
  // each with its own action-set. So the section renders one row per present
  // audience — each with its own role <select> + remove — and mutates them
  // independently and instantly (role change → atomic `update`, remove →
  // `revoke`), exactly like the people roster. Adding a new audience goes
  // through a small inline confirm (exposing a resource publicly is the one
  // risky action), then `grant`.

  // Every public-audience grant, ordered most-permissive first.
  let publicRows = $derived(publicGrants(share?.grants ?? []));
  // Non-manage, non-owner roles offered for any public audience.
  let generalRoles = $derived(generalAccessRoles(share?.roles ?? []));

  // The "Add public access" control: the audiences still addable (the two
  // non-overlapping ones, minus any already present) and its staged audience +
  // role. `everyone` is never offered as a *new* choice (it overlaps the other
  // two); a pre-existing everyone grant still shows as a removable row above.
  let addableAudiences = $derived(availableAudiencesToAdd(share?.grants ?? []));
  let addAudience = $state<PublicAudience | "">("");
  let addRole = $state<string>("");
  // When true, the inline "Make public?" confirm replaces the add-row.
  let pendingPublicAdd = $state(false);

  // Per-audience busy flags so one row's mutation doesn't disable the others.
  let generalBusy = $state<Record<string, boolean>>({});
  let generalError = $state<string | null>(null);

  // Keep the add-row's staged audience valid as availability changes (a grant
  // removes an option; a revoke restores one).
  $effect(() => {
    if (addAudience === "" || !addableAudiences.includes(addAudience)) {
      addAudience = addableAudiences[0] ?? "";
      pendingPublicAdd = false;
    }
  });
  // Default the add-row role to the most conservative (lowest) role, and keep it
  // valid against the resource's role registry.
  $effect(() => {
    if (addRole === "" || !generalRoles.some((r) => r.name === addRole)) {
      addRole = defaultPublicRole(share?.roles ?? []) ?? "";
    }
  });

  /** Icon for a public audience's avatar chip. */
  function audienceIcon(audience: string): string {
    if (audience === "authenticated") return ICON_PERSON;
    if (audience === "anonymous") return ICON_INCOGNITO;
    return ICON_GLOBE; // everyone
  }

  // Change one audience's role via atomic `update` (swaps the action-set, so a
  // downgrade actually removes the extra actions — unlike the additive `grant`).
  async function onPublicRoleChange(grant: Grant, event: Event) {
    if (!resourceType || !parent) return;
    const select = event.currentTarget as HTMLSelectElement;
    const newRole = select.value;
    const prevRole = grant.role;
    if (newRole === prevRole) return;
    const audience = grant.id as PublicAudience;
    generalBusy = { ...generalBusy, [audience]: true };
    generalError = null;
    patchGrant(grant.id, "public", { role: newRole }); // optimistic
    try {
      const updated = await api.update(resourceType, parent, child ?? null, {
        principal_type: audience,
        role: newRole,
      });
      patchGrant(grant.id, "public", updated);
      dispatch("share-updated", {
        principal: "public",
        id: grant.id,
        role: updated.role,
      });
      dispatch("share-changed", {});
    } catch (err) {
      patchGrant(grant.id, "public", { role: prevRole });
      select.value = prevRole ?? "";
      generalError = errorMessage(err, "Couldn't change general access");
    } finally {
      generalBusy = withoutKey(generalBusy, audience);
    }
  }

  async function onPublicRemove(grant: Grant) {
    if (!share || !resourceType || !parent) return;
    const audience = grant.id as PublicAudience;
    generalBusy = { ...generalBusy, [audience]: true };
    generalError = null;
    const previousGrants = share.grants;
    share.grants = share.grants.filter(
      (g) => !(g.principal === "public" && g.id === grant.id),
    );
    try {
      await api.revoke(resourceType, parent, child ?? null, {
        principal_type: audience,
      });
      dispatch("share-revoked", { principal: "public", id: grant.id });
      dispatch("share-changed", {});
    } catch (err) {
      if (share) share.grants = previousGrants;
      generalError = errorMessage(err, "Couldn't change general access");
    } finally {
      generalBusy = withoutKey(generalBusy, audience);
    }
  }

  // Adding public access is two-step: arm the inline confirm, then commit.
  function armPublicAdd() {
    if (!addAudience || !addRole) return;
    pendingPublicAdd = true;
  }
  function cancelPublicAdd() {
    pendingPublicAdd = false;
  }

  async function confirmPublicAdd() {
    if (!share || !resourceType || !parent || !addAudience || !addRole) return;
    const audience = addAudience;
    generalBusy = { ...generalBusy, [audience]: true };
    generalError = null;
    try {
      const grant = await api.grant(resourceType, parent, child ?? null, {
        principal_type: audience,
        role: addRole,
      });
      if (share) {
        const without = share.grants.filter(
          (g) => !(g.principal === "public" && g.id === audience),
        );
        share.grants = [...without, grant];
      }
      dispatch("share-granted", {
        principal: "public",
        id: grant.id,
        role: grant.role,
      });
      dispatch("share-changed", {});
      pendingPublicAdd = false; // the $effect re-seeds addAudience/addRole
    } catch (err) {
      generalError = errorMessage(err, "Couldn't change general access");
    } finally {
      generalBusy = withoutKey(generalBusy, audience);
    }
  }
</script>

<div class="datasette-acl-share" bind:this={host}>
  <button
    type="button"
    class="datasette-acl-share__trigger"
    class:has-label={triggerLabel}
    aria-label={triggerAriaLabel}
    aria-haspopup="dialog"
    disabled={isDisabled}
    onclick={openDialog}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M13.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.5 2.5 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5m-8.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m11 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"
      />
    </svg>
    {#if triggerLabel}<span class="datasette-acl-share__trigger-text"
        >{triggerLabel}</span
      >{/if}
  </button>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <dialog
    class="datasette-acl-share-dialog"
    bind:this={dialogEl}
    onclick={onDialogClick}
  >
    <header class="datasette-acl-share-dialog__header">
      <h2 class="datasette-acl-share-dialog__title">
        {resourceLabel ? `Share “${resourceLabel}”` : "Share"}
      </h2>
      <button
        type="button"
        class="datasette-acl-share-dialog__close"
        aria-label="Close"
        onclick={closeDialog}>×</button
      >
    </header>

  {#if loading}
    <p class="datasette-acl-share-dialog__loading">Loading…</p>
  {:else if loadError}
    <p class="datasette-acl-share-dialog__error" role="alert">{loadError}</p>
  {:else if share}
    <!-- One search result row, rendered for both the People and Groups
         sub-sections of the unified picker. `i` is the option's index in the
         flat `optionPills` list so keyboard `highlight` lines up. -->
    {#snippet resultOption(opt: Pill, i: number)}
      <li>
        <button
          type="button"
          role="option"
          id={`datasette-acl-share-opt-${i}`}
          aria-selected={highlight === i}
          class="datasette-acl-share-dialog__result"
          class:is-highlighted={highlight === i}
          onmousemove={() => (highlight = i)}
          onclick={() => pickOption(opt)}
        >
          <span
            class="datasette-acl-share-dialog__avatar datasette-acl-share-dialog__avatar--initials datasette-acl-share-dialog__result-avatar"
            style:background-color={avatarColor(opt.id)}
            aria-hidden="true"
            >{#if opt.kind === "group"}{@html ICON_PEOPLE}{:else}{initials(
                opt.label,
              )}{/if}</span
          >
          <span class="datasette-acl-share-dialog__result-text">
            <span class="datasette-acl-share-dialog__name">{opt.label}</span>
            {#if opt.kind === "user" && opt.email}
              <span class="datasette-acl-share-dialog__sub">{opt.email}</span>
            {:else if opt.kind === "group" && opt.member_count != null}
              <span class="datasette-acl-share-dialog__sub"
                >{memberCountLabel(opt.member_count)}</span
              >
            {/if}
          </span>
        </button>
      </li>
    {/snippet}

    <section
      class="datasette-acl-share-dialog__section"
      aria-label="People with access"
    >
      <h3 class="datasette-acl-share-dialog__section-title">People with access</h3>

      {#if actionError}
        <p class="datasette-acl-share-dialog__error" role="alert">{actionError}</p>
      {/if}

      <ul class="datasette-acl-share-dialog__list">
        {#each orderedGrants as grant (principalKey(grant))}
          {@const owner = isOwnerGrant(grant)}
          {@const you = isYou(grant)}
          {@const rowBusy = busy[principalKey(grant)] === true}
          {@const lastManager =
            share != null &&
            isLastManageGrant(grant, share.grants, share.roles)}
          <li
            class="datasette-acl-share-dialog__row"
            class:is-owner={owner}
            class:is-flash={focusKey === principalKey(grant)}
            data-principal-key={principalKey(grant)}
          >
            <span class="datasette-acl-share-dialog__avatar-wrap">
              {#if grant.avatar_url}
                <img
                  class="datasette-acl-share-dialog__avatar"
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
                class="datasette-acl-share-dialog__avatar datasette-acl-share-dialog__avatar--initials"
                style:background-color={avatarColor(grant.id)}
                aria-hidden="true"
              >
                {initials(rowLabel(grant))}
              </span>
              {#if badge(grant.kind)}
                <span
                  class="datasette-acl-share-dialog__kind-badge"
                  title={grant.kind}>{@html badge(grant.kind)}</span
                >
              {/if}
            </span>

            <span class="datasette-acl-share-dialog__identity">
              <span class="datasette-acl-share-dialog__name">
                {rowLabel(grant)}{#if you}<span
                    class="datasette-acl-share-dialog__you"> (you)</span
                  >{/if}
              </span>
              {#if rowSubLabel(grant)}
                <span class="datasette-acl-share-dialog__sub"
                  >{rowSubLabel(grant)}</span
                >
              {/if}
            </span>

            <span class="datasette-acl-share-dialog__controls">
              {#if owner}
                <span class="datasette-acl-share-dialog__role-tag">Owner</span>
              {:else if canManage}
                <select
                  class="datasette-acl-share-dialog__role-select"
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
                  class="datasette-acl-share-dialog__remove"
                  aria-label={`Remove ${rowLabel(grant)}`}
                  disabled={rowBusy || lastManager}
                  title={lastManager
                    ? "Can't remove the only manager — the resource would be orphaned"
                    : undefined}
                  onclick={() => onRemove(grant)}
                >
                  ×
                </button>
              {:else}
                <span class="datasette-acl-share-dialog__role-tag">
                  {grant.role ?? "Custom"}
                </span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>

      {#if pickerAvailable}
        <!-- Inline add-row: the last row of the roster table. Search people
             and/or groups in one box, stage them as pills, pick a role, and
             confirm — all in place, no separate add section. -->
        <div
          class="datasette-acl-share-dialog__add-row"
          bind:this={addBoxEl}
        >
          <span
            class="datasette-acl-share-dialog__add-icon"
            aria-hidden="true">{@html ICON_PLUS}</span
          >

          <!-- The field (pills + input) and floating results overlay share a
               relatively positioned wrapper so the listbox can absolutely
               position beneath the field without reflowing the dialog. -->
          <div class="datasette-acl-share-dialog__search-wrap">
            <div class="datasette-acl-share-dialog__field">
              {#each pills as pill (pillKey(pill))}
                <span class="datasette-acl-share-dialog__pill">
                  <span
                    class="datasette-acl-share-dialog__avatar datasette-acl-share-dialog__avatar--initials datasette-acl-share-dialog__pill-avatar"
                    style:background-color={avatarColor(pill.id)}
                    aria-hidden="true"
                    >{#if pill.kind === "group"}{@html ICON_PEOPLE}{:else}{initials(
                        pill.label,
                      )}{/if}</span
                  >
                  <span class="datasette-acl-share-dialog__pill-label"
                    >{pill.label}</span
                  >
                  <button
                    type="button"
                    class="datasette-acl-share-dialog__pill-remove"
                    aria-label={`Remove ${pill.label}`}
                    disabled={granting}
                    onclick={() => removePillAt(pill)}>×</button
                  >
                </span>
              {/each}
              <input
                type="search"
                bind:this={searchEl}
                class="datasette-acl-share-dialog__search"
                placeholder={pills.length > 0
                  ? "Add more…"
                  : "Add people or groups…"}
                aria-label="Add people or groups"
                role="combobox"
                aria-expanded={showDropdown}
                aria-controls="datasette-acl-share-results"
                aria-autocomplete="list"
                aria-activedescendant={highlight >= 0
                  ? `datasette-acl-share-opt-${highlight}`
                  : undefined}
                value={query}
                oninput={onQueryInput}
                onfocus={onSearchFocus}
                onkeydown={onSearchKeydown}
              />
            </div>

            {#if showDropdown}
              <ul
                id="datasette-acl-share-results"
                class="datasette-acl-share-dialog__results"
                role="listbox"
                aria-label="Search results"
                aria-busy={searching}
              >
                {#if optionPills.length === 0}
                  <li class="datasette-acl-share-dialog__empty">
                    {pickerEmptyMessage()}
                  </li>
                {:else}
                  {#if peoplePills.length > 0}
                    {#if showResultGroups}
                      <li
                        class="datasette-acl-share-dialog__result-group"
                        role="presentation"
                      >
                        People
                      </li>
                    {/if}
                    {#each peoplePills as opt, i (pillKey(opt))}
                      {@render resultOption(opt, i)}
                    {/each}
                  {/if}
                  {#if groupPills.length > 0}
                    {#if showResultGroups}
                      <li
                        class="datasette-acl-share-dialog__result-group"
                        role="presentation"
                      >
                        Groups
                      </li>
                    {/if}
                    {#each groupPills as opt, j (pillKey(opt))}
                      {@render resultOption(opt, peoplePills.length + j)}
                    {/each}
                  {/if}
                {/if}
              </ul>
            {/if}
          </div>

          <select
            class="datasette-acl-share-dialog__role-select"
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
            class="datasette-acl-share-dialog__share-btn"
            disabled={pills.length === 0 || granting || !pickerRole}
            onclick={onShare}
          >
            {granting ? "Adding…" : "Add"}
          </button>
        </div>

        {#if pickerError}
          <p class="datasette-acl-share-dialog__error" role="alert">{pickerError}</p>
        {/if}
      {/if}
    </section>

    {#if caps.public}
      <section
        class="datasette-acl-share-dialog__section datasette-acl-share-dialog__general"
        aria-label="General access"
      >
        <h3 class="datasette-acl-share-dialog__section-title">General access</h3>

        {#if generalError}
          <p class="datasette-acl-share-dialog__error" role="alert">{generalError}</p>
        {/if}

        {#if publicRows.length === 0}
          <p class="datasette-acl-share-dialog__general-empty">
            Restricted — only people with access can open this.
          </p>
        {:else}
          <ul class="datasette-acl-share-dialog__list">
            {#each publicRows as grant (grant.id)}
              {@const audience = grant.id}
              {@const rowBusy = generalBusy[audience] === true}
              <li
                class="datasette-acl-share-dialog__row"
                data-principal-key={`public:${audience}`}
              >
                <span class="datasette-acl-share-dialog__avatar-wrap">
                  <span
                    class="datasette-acl-share-dialog__avatar datasette-acl-share-dialog__avatar--initials"
                    style:background-color={avatarColor(audience)}
                    aria-hidden="true">{@html audienceIcon(audience)}</span
                  >
                </span>

                <span class="datasette-acl-share-dialog__identity">
                  <span class="datasette-acl-share-dialog__name"
                    >{audienceLabel(audience)}</span
                  >
                  <span class="datasette-acl-share-dialog__sub"
                    >{audienceSublabel(audience)}</span
                  >
                </span>

                <span class="datasette-acl-share-dialog__controls">
                  {#if canManage}
                    <select
                      class="datasette-acl-share-dialog__role-select"
                      aria-label={`Role for ${audienceLabel(audience)}`}
                      value={grant.role ?? ""}
                      disabled={rowBusy}
                      onchange={(e) => onPublicRoleChange(grant, e)}
                    >
                      {#if grant.role && !generalRoles.some((r) => r.name === grant.role)}
                        <option value={grant.role} disabled>{grant.role}</option>
                      {/if}
                      {#each generalRoles as role (role.name)}
                        <option value={role.name}>{role.name}</option>
                      {/each}
                    </select>
                    <button
                      type="button"
                      class="datasette-acl-share-dialog__remove"
                      aria-label={`Remove ${audienceLabel(audience)}`}
                      disabled={rowBusy}
                      onclick={() => onPublicRemove(grant)}
                    >
                      ×
                    </button>
                  {:else}
                    <span class="datasette-acl-share-dialog__role-tag"
                      >{grant.role ?? "Custom"}</span
                    >
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if canManage && addableAudiences.length > 0}
          {#if pendingPublicAdd && addAudience}
            <!-- Exposing a resource publicly is the one risky action, so it
                 takes an explicit confirm (role changes/removes apply directly). -->
            <div class="datasette-acl-share-dialog__general-confirm" role="alert">
              <span class="datasette-acl-share-dialog__general-confirm-text">
                Make this visible to <strong>{audienceLabel(addAudience)}</strong>
                as {addRole}?
              </span>
              <button
                type="button"
                class="datasette-acl-share-dialog__share-btn"
                aria-label="Confirm public access"
                disabled={generalBusy[addAudience] === true}
                onclick={confirmPublicAdd}
              >
                {generalBusy[addAudience] === true ? "Adding…" : "Confirm"}
              </button>
              <button
                type="button"
                class="datasette-acl-share-dialog__general-cancel"
                onclick={cancelPublicAdd}
              >
                Cancel
              </button>
            </div>
          {:else}
            <div
              class="datasette-acl-share-dialog__add-row datasette-acl-share-dialog__general-add"
            >
              <span class="datasette-acl-share-dialog__add-icon" aria-hidden="true"
                >{@html ICON_GLOBE}</span
              >
              <select
                class="datasette-acl-share-dialog__general-principal"
                aria-label="Add public access"
                bind:value={addAudience}
              >
                {#each addableAudiences as a (a)}
                  <option value={a}>{audienceLabel(a)}</option>
                {/each}
              </select>
              <select
                class="datasette-acl-share-dialog__role-select"
                aria-label="Role for public access"
                bind:value={addRole}
              >
                {#each generalRoles as role (role.name)}
                  <option value={role.name}>{role.name}</option>
                {/each}
              </select>
              <button
                type="button"
                class="datasette-acl-share-dialog__share-btn"
                aria-label="Add public access"
                disabled={!addAudience || !addRole}
                onclick={armPublicAdd}
              >
                Add
              </button>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
  </dialog>
</div>

<style>
  .datasette-acl-share {
    display: inline-block;
  }

  /* The share-icon trigger button. */
  .datasette-acl-share__trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #f6f8fa;
    color: #1f2328;
    cursor: pointer;
    line-height: 0;
  }
  .datasette-acl-share__trigger.has-label {
    padding: 0.375rem 0.625rem;
  }
  .datasette-acl-share__trigger:hover {
    background: #eef1f4;
  }
  .datasette-acl-share__trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .datasette-acl-share__trigger-text {
    font-family: system-ui, sans-serif;
    font-size: 0.875rem;
    line-height: 1;
  }

  /* The dialog itself, shown as a native modal via showModal(). */
  .datasette-acl-share-dialog {
    font-family:
      system-ui,
      -apple-system,
      "Segoe UI",
      sans-serif;
    color: #1f2328;
    width: min(32rem, calc(100vw - 2rem));
    max-width: 32rem;
    border: none;
    border-radius: 12px;
    padding: 1.25rem;
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.18),
      0 1px 3px rgba(0, 0, 0, 0.12);
  }
  .datasette-acl-share-dialog::backdrop {
    background: rgba(0, 0, 0, 0.35);
  }
  .datasette-acl-share-dialog__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .datasette-acl-share-dialog__close {
    border: none;
    background: transparent;
    color: #57606a;
    font-size: 1.375rem;
    line-height: 1;
    padding: 0 0.25rem;
    cursor: pointer;
    border-radius: 6px;
  }
  .datasette-acl-share-dialog__close:hover {
    background: #f0f1f2;
    color: #1f2328;
  }
  .datasette-acl-share-dialog__title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .datasette-acl-share-dialog__section-title {
    margin: 0.75rem 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
  }
  .datasette-acl-share-dialog__loading {
    color: #57606a;
    padding: 0.75rem 0;
  }
  .datasette-acl-share-dialog__error {
    color: #a0202a;
    background: #ffebe9;
    border: 1px solid #ffced0;
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
  }
  .datasette-acl-share-dialog__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .datasette-acl-share-dialog__row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0;
    border-bottom: 1px solid #f0f1f2;
  }
  .datasette-acl-share-dialog__row:last-child {
    border-bottom: none;
  }
  .datasette-acl-share-dialog__avatar-wrap {
    position: relative;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
  }
  .datasette-acl-share-dialog__avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }
  /* The initials chip sits behind the <img>; when the image loads it covers
   * the chip, and when it errors (onerror hides it) the chip shows through. */
  .datasette-acl-share-dialog__avatar--initials {
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
  .datasette-acl-share-dialog__kind-badge {
    position: absolute;
    right: -2px;
    bottom: -2px;
    font-size: 0.6875rem;
    line-height: 1;
    background: #fff;
    border-radius: 50%;
    padding: 1px;
  }
  .datasette-acl-share-dialog__identity {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .datasette-acl-share-dialog__name {
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .datasette-acl-share-dialog__you {
    color: #57606a;
  }
  .datasette-acl-share-dialog__sub {
    font-size: 0.75rem;
    color: #57606a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .datasette-acl-share-dialog__controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .datasette-acl-share-dialog__role-select {
    font-size: 0.8125rem;
    padding: 0.25rem 0.375rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    color: inherit;
  }
  .datasette-acl-share-dialog__role-select:disabled {
    opacity: 0.6;
  }
  .datasette-acl-share-dialog__role-tag {
    font-size: 0.75rem;
    color: #57606a;
    padding: 0.125rem 0.5rem;
    background: #eef1f4;
    border-radius: 6px;
  }
  .datasette-acl-share-dialog__remove {
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
  .datasette-acl-share-dialog__remove:hover:not(:disabled) {
    background: #ffebe9;
    border-color: #ffced0;
    color: #a0202a;
  }
  .datasette-acl-share-dialog__remove:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- inline add-row ---------------------------------------------------- */
  /* The last row of the roster table: a "+" glyph in the avatar column, the
     pills+input field in the identity column, and [role ▾][Add] in the
     controls column — same flex shape as __row so it reads as the next row. */
  .datasette-acl-share-dialog__add-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0;
    border-top: 1px solid #f0f1f2;
  }
  .datasette-acl-share-dialog__add-icon {
    flex: 0 0 auto;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #eef1f4;
    color: #57606a;
    font-size: 1rem;
  }
  /* Anchor for the floating results overlay. */
  .datasette-acl-share-dialog__search-wrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  /* The bordered box that visually contains the pills + the text input. */
  .datasette-acl-share-dialog__field {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3125rem;
    box-sizing: border-box;
    min-height: 2.25rem;
    padding: 0.25rem 0.375rem;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .datasette-acl-share-dialog__field:focus-within {
    border-color: #1f6feb;
    box-shadow: 0 0 0 1px #1f6feb;
  }
  .datasette-acl-share-dialog__search {
    flex: 1 1 6rem;
    min-width: 6rem;
    box-sizing: border-box;
    font-size: 0.875rem;
    padding: 0.1875rem 0.125rem;
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
  }
  .datasette-acl-share-dialog__share-btn {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid #1f6feb;
    border-radius: 6px;
    background: #1f6feb;
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
  }
  .datasette-acl-share-dialog__share-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* --- staged pills (inline in the add-row field) ------------------------ */
  .datasette-acl-share-dialog__pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 100%;
    padding: 0.1875rem 0.1875rem 0.1875rem 0.1875rem;
    background: #eef1f4;
    border: 1px solid #d0d7de;
    border-radius: 999px;
    font-size: 0.8125rem;
  }
  .datasette-acl-share-dialog__pill-avatar {
    position: static;
    inset: auto;
    z-index: auto;
    flex: 0 0 auto;
    width: 1.5rem;
    height: 1.5rem;
    font-size: 0.625rem;
  }
  .datasette-acl-share-dialog__pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .datasette-acl-share-dialog__pill-remove {
    flex: 0 0 auto;
    font-size: 0.875rem;
    line-height: 1;
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    color: #57606a;
  }
  .datasette-acl-share-dialog__pill-remove:hover:not(:disabled) {
    background: #ffebe9;
    color: #a0202a;
  }
  .datasette-acl-share-dialog__pill-remove:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- floating results overlay ------------------------------------------ */
  /* The results render as an absolutely-positioned autocomplete dropdown.
     Because the add-row is the LAST row of the roster, the overlay opens
     *upward* (bottom: 100%) over the roster rows above it — staying inside the
     dialog instead of hanging off its bottom edge — and floats over that
     content so showing results never reflows the dialog. */
  .datasette-acl-share-dialog__results {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    position: absolute;
    bottom: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    z-index: 50;
    max-height: 14rem;
    overflow-y: auto;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(31, 35, 40, 0.18);
  }
  .datasette-acl-share-dialog__result {
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
  .datasette-acl-share-dialog__result:hover,
  .datasette-acl-share-dialog__result:focus-visible,
  .datasette-acl-share-dialog__result.is-highlighted,
  .datasette-acl-share-dialog__result[aria-selected="true"] {
    background: #eef3fb;
    outline: none;
  }
  .datasette-acl-share-dialog__result-avatar {
    position: static;
    inset: auto;
    z-index: auto;
    flex: 0 0 auto;
  }
  .datasette-acl-share-dialog__result-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .datasette-acl-share-dialog__empty {
    color: #57606a;
    font-size: 0.8125rem;
    padding: 0.5rem 0.25rem;
  }
  /* "People" / "Groups" subheaders inside the unified results dropdown. */
  .datasette-acl-share-dialog__result-group {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
    padding: 0.375rem 0.5rem 0.125rem;
  }
  .datasette-acl-share-dialog__result-group:not(:first-child) {
    margin-top: 0.125rem;
    border-top: 1px solid #f0f1f2;
  }

  /* --- duplicate-add flash ---------------------------------------------- */
  .datasette-acl-share-dialog__row.is-flash {
    animation: datasette-acl-share-flash 1.6s ease-out;
  }
  @keyframes datasette-acl-share-flash {
    0%,
    40% {
      background: #fff8c5;
    }
    100% {
      background: transparent;
    }
  }

  /* --- general access ---------------------------------------------------- */
  /* Public-audience rows reuse the roster row/avatar/controls styles; only the
     audience picker, the empty state and the add/confirm controls are bespoke. */
  .datasette-acl-share-dialog__general-empty {
    margin: 0.25rem 0 0.5rem;
    color: #57606a;
    font-size: 0.8125rem;
  }
  .datasette-acl-share-dialog__general-principal {
    font-size: 0.875rem;
    padding: 0.25rem 0.375rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    color: inherit;
    flex: 1 1 auto;
    min-width: 0;
  }
  .datasette-acl-share-dialog__general-confirm {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    margin-top: 0.375rem;
    background: #fff8e6;
    border: 1px solid #f0d48a;
    border-radius: 8px;
  }
  .datasette-acl-share-dialog__general-confirm-text {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.8125rem;
    line-height: 1.3;
  }
  .datasette-acl-share-dialog__general-cancel {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 0.25rem 0.375rem;
    color: #57606a;
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .datasette-acl-share-dialog__general-cancel:hover {
    text-decoration: underline;
  }
</style>
