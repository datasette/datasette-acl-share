# CLAUDE.md — datasette-acl-share

Guide for future agents working in this repo. Keep it current when you change
the component's public contract, the dev setup, or the "what's left" list.

## What this is

A reusable, Google-Docs-style **share dialog** for Datasette, shipped as one
framework-agnostic Svelte 5 custom element: `<datasette-acl-share-dialog>`. It
is the UI layer over the **datasette-acl JSON API** (the grant store). It does
*not* implement any policy itself — it reads/writes grants, roles, groups and
"general access" public audiences over HTTP.

Two optional backends light up extra UI:
- **datasette-user-profiles** → people search + avatars/display names. Absent →
  initials chips, no People search.
- (Agents were removed — see "What's left".)

`groups` and "general access" (the `everyone` / `authenticated` public
audiences) are intrinsic to acl and always available.

## Architecture / layout

```
datasette_acl_share/__init__.py   Python: datasette_share_assets() asset helper
                                  + share_capabilities() + GET /-/share/capabilities
datasette_acl_share/static/gen/   built bundle + manifest.json (GITIGNORED; run `just frontend`)
frontend/src/ShareDialog.svelte   the custom element (one big component, light DOM)
frontend/src/main.ts              registers the element
frontend/src/lib/                 pure helpers: api.ts (typed fetch client), types.ts,
                                  grants.ts, pills.ts, people.ts, groups.ts, avatar.ts
                                  (+ matching *.test.ts; vitest node + browser suites)
tests/test_share.py               Python tests (asset helper + capability probe)
tests/sample_plugins/sample_resources.py   throwaway demo plugin (NOT packaged; --plugins-dir)
tests/sample_plugins/sample_resource_specs/   one module per resource type (pure-data SPECs)
tests/templates/                  demo page template (--template-dir; extends base.html)
docs/integration-guide.md         how host plugins embed the dialog (source-controlled)
```

The Python side ships assets **opt-in**: a host plugin calls
`datasette_share_assets(datasette)` (note: NOT `datasette_acl_share_assets`) from
its own `extra_js_urls`/`extra_css_urls` so the bundle loads only on its pages.

## Component contract

Renders a **share-icon button**; clicking opens a native modal `<dialog>`
(dismiss via ×, backdrop, or Esc). Content is *not* inline. The resource is
fetched lazily on first open (so many buttons on a page cost no network until
used). Light DOM (`shadow: "none"`), CSS selectors prefixed
`datasette-acl-share-dialog__*`. Attributes are kebab-case.

**Adding access** is an **inline add-row** — the last row of the roster table
(not a separate panel, and no People/Groups tabs). One unified combobox searches
people (profiles, async) and groups (acl, fetched once + filtered locally) at
the same time, merging both into one results dropdown under `People` / `Groups`
sub-headers (sub-headers shown only when both backends are present). Picks stage
as pills inside the field; a shared role `<select>` + **Add** button grant them
in a batch. The dropdown opens *upward* (the add-row sits at the dialog bottom).
`canManage === false` ⇒ no add-row at all.

Attributes: `resource-type` (req), `parent` (req), `child`, `resource-label`,
`actor-json`, `api-base`, `features` (`people,groups,public`),
`open` (open on mount; non-`"false"`), `trigger-label`, `disabled`.

Events (bubbling/composed): `share-granted`, `share-updated`, `share-revoked`,
`share-changed`.

It talks to acl's JSON API under `/-/acl/api` (resource read, grant/revoke/
update, groups + actors pickers). Full spec: `../datasette-acl/docs/json-api.md`.
Notable: the **read endpoint is manager-only** (v1) and `revoke` returns the
sorted list of removed action names (`{"ok", "removed": [...]}`).

**`principal_type` is the whole principal model** (acl retired wildcard ids):
every grant targets exactly one of an **actor** (`actor_id`, `principal_type:
"actor"`), a **group** (`group_id`), or a **public audience** named purely by
`principal_type` with *no id* — `everyone` (anyone, incl. anonymous),
`authenticated` (any signed-in actor), or `anonymous` (signed-out only). The
dialog offers `everyone` / `authenticated` in its General-access control. The
GET response renders an audience as `principal: "public"`, `id: "<audience>"`,
`kind: "public"`; `isWildcardGrant` matches on `kind` only, never the raw id,
so a real actor whose id happens to match an audience name stays in the People
roster. Mutations send the audience as `{"principal_type": "<audience>"}`.

## Dependencies

`pyproject.toml` requires **`datasette-acl>=0.6a0`** and `datasette-vite`. The
first-class public-audience principal types (and acl's `grant()` taking a
`Principal` object) that the dialog and demo seed code depend on shipped in acl
**0.6a0** — `just dev` installs it straight from PyPI (no more local-checkout
overlay).

## Dev & test

```sh
just frontend-install          # one-time npm install
just frontend                  # production build → static/gen + manifest.json
just dev                       # datasette + sample-resources demo at :5171
just frontend-dev              # (terminal 1) vite HMR dev server on $DEV_PORT
just dev-with-hmr              # (terminal 2) datasette pointed at the dev server

npm --prefix frontend run test    # vitest (node + browser/chromium)
npm --prefix frontend run check   # svelte-check + tsc (the frontend gate; keep at 0 errors)
uv run pytest                     # python
```

`DEV_PORT` is a Justfile variable (single source of truth), passed to vite via
env and to datasette-vite's `dev_ports` setting. Built assets are gitignored.

There is no configured Python type-checker; the IDE's `ty` may flag the demo
plugin (e.g. spec-dict value types, unused hook params, unresolved
`datasette_debug_gotham`) — these are runtime-correct noise, not gates.

## The sample-resources demo (`just dev`)

One dev-only plugin (`sample_resources.py`) serving a single
`/sample-resources` page — a gallery whose point is to show, side by side, lots
of different "documents" with different sharing, so switching actors visibly
recolours the whole page. It registers **four** acl resource types whose role
registries deliberately span the spectrum, and seeds a few instances of each:
- `playlist` — standard Viewer/Editor/Manager via acl's `standard_roles()`.
- `project` — hand-rolled roles, manage role named **Maintainer** (no
  "Manager"/"Owner"): proves the dialog keys off the `manage` flag, not the name.
- `paste` — the simple shape: **Viewer + Owner** only, plus a public audience.
- `channel` — the maximal one: five tiers with **two** manage-capable roles
  (Moderator + Owner), exercising last-manager counting and a deep dropdown.

Each type's specs live in the **`sample_resource_specs/`** package — one
pure-data module per type exporting a `SPEC` dict (type, label, features,
actions, roles, and demo `instances`). Add a resource type by dropping a module
there and appending it to `RESOURCE_SPECS`; `sample_resources.py` does all the
plumbing (builds a parent-only `Resource` subclass per spec via
`register_actions` + `datasette_acl_roles`). A spec's `instances` entry is
`{id, title, blurb, grants}`; each grant is `{role + one of actor|group|public}`
(group names resolve to newsroom dynamic-group ids; `public` is an audience
name).

**Instances are real, editable DB rows**, not hardcoded. They live in a
`sample_resource_instances(type, id, title, blurb)` table in Datasette's
**internal database** — the same db acl runs each type's `resources_sql` against
(it `SELECT`s from this table, so a create/delete is visible to acl
immediately). The `startup` hook creates the table and backfills the demo rows
(`INSERT OR IGNORE`); their grants are seeded lazily on first request via
`_ensure_seed_grants` (acl's tables must exist first). The page has
create/edit/delete routes (`/sample-resources/{create,edit,delete}`, POST,
CSRF-protected): creating grants the creator the type's **top manage role** (so
they can share it straight away); edit/delete are gated server-side on
`can_manage`. The internal db is in-memory under `just dev`, so edits last for
the process and reset to the demo set on restart.

Demo instances are seeded across the whole gotham cast in varied shapes (group
grants, cross-newsroom, named-people-only, public audiences) with managers
spread around — **Clark manages at least one of every type**, but bruce/lois/
jimmy/alfred each manage some too, and a few are deliberately **single-manager**
(e.g. project *Whistleblower*, channel *#announcements*) to exercise the orphan
guard. The page is a single centred column: per type an `h2` + one-line
description + the instance list, each instance tagged with **your** highest role
(or "no access", via `_highest_role_for_actor` → acl's `role_for_actions`) with
its share trigger `disabled` unless you can manage it. No per-instance subpage
and no view-gating — everything renders, the badges just change per actor.

Switch actors with the **debug bar** (gotham, via datasette-debug-bar) — it sets
the `actor` cookie. user-profiles (seeded by gotham) gives names/avatars/search;
`-s permissions.profile_access.id '*'` in `just dev` lets actors use the picker.

**Newsroom groups.** Gotham actors carry a `newsroom` attribute (`daily-planet` =
clark/lois/jimmy, `gotham-gazette` = bruce/alfred/selina). Gotham itself has no
acl code — `just dev` turns these into acl **dynamic groups** via config:
`-s plugins.datasette-acl.dynamic-groups.<name>.newsroom <name>`. acl pre-creates
the `acl_groups` rows at startup and recomputes membership per-actor from the
attribute, so both newsrooms surface under the **Groups** sub-section of the
dialog's unified add-row search and are grantable — no manual roster. (`member_count` in the groups endpoint fills in
lazily as acl resolves each actor.) To add a new newsroom group: add another
`dynamic-groups.<name>.newsroom <name>` flag — no plugin change needed.

Demo flow: log in as Clark → on the `playlist` *Summer Road-Trip Mix* open the
dialog → share Viewer with Lois → switch to Lois → that instance now shows her a
Viewer badge. Or share with the **daily-planet** group → every Daily Planet
actor (lois, jimmy) inherits it. Try a single-manager instance (project
*Whistleblower*) to see the orphan guard block removing the last Maintainer.

## Current state / what's done

- Frontend types + API client aligned to acl's JSON API (merged to acl `main`).
- Component is a modal-with-trigger (was inline), with `open`/`trigger-label`/
  `disabled`. Lazy load on open.
- Agent picker feature **removed** (see below).
- Sample-resources demo: one `/sample-resources` page over four acl resource
  types with deliberately varied role registries, each backfilled with several
  **editable** instances (a `sample_resource_instances` table in the internal
  db; create/edit/delete routes) across preseeded sharing shapes, gotham
  newsrooms wired as acl dynamic groups, and a per-instance badge of each
  actor's role.
- Plugin-author integration guide at `docs/integration-guide.md`.
- Aligned to acl's first-class public-audience model (`everyone` /
  `authenticated` / `anonymous`; wildcard ids retired): mutations send the
  audience as `principal_type` with no id, demo seeding builds `Principal`
  objects, and general-access detection is kind-only.
- All suites green: frontend check (0 errors), vitest, pytest.

## What's left / deferred

- **Agents.** The dedicated Agents tab + `/-/agent/api` backend were removed to
  simplify (commit "Remove agent picker feature"). To bring agents back, fold
  them into **People search** via acl's actors picker `kind` filter
  (`/-/acl/api/actors?kind=agent`) rather than a separate tab/backend. Design
  notes: `../research-sharing/05-agent-actors-plan.md`.
- **Read endpoint is manager-only (acl v1).** Non-managers can't load the dialog
  at all; revisit if viewers should see a read-only roster.
- **Consumer migrations** (paper / places / sheets / comments embedding this
  element) are tracked in `../research-sharing/07-*` and `08-roadmap-*` — not
  done here.

Broader plan + open questions live in `../research-sharing/` (this plugin is
"Phase 3" in `08-roadmap-and-open-questions.md`).
