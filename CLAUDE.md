# CLAUDE.md — datasette-acl-share

Guide for future agents working in this repo. Keep it current when you change
the component's public contract, the dev setup, or the "what's left" list.

## What this is

A reusable, Google-Docs-style **share dialog** for Datasette, shipped as one
framework-agnostic Svelte 5 custom element: `<datasette-acl-share-dialog>`. It
is the UI layer over the **datasette-acl JSON API** (the grant store). It does
*not* implement any policy itself — it reads/writes grants, roles, groups and
"general access" wildcards over HTTP.

Two optional backends light up extra UI:
- **datasette-user-profiles** → people search + avatars/display names. Absent →
  initials chips, no People search.
- (Agents were removed — see "What's left".)

`groups` and "general access" (`*` / `_signed_in`) are intrinsic to acl and
always available.

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
tests/sample_plugins/sample_docs.py   throwaway demo plugin (NOT packaged; --plugins-dir)
tests/templates/                  demo page templates (--template-dir; extend base.html)
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

Attributes: `resource-type` (req), `parent` (req), `child`, `resource-label`,
`actor-json`, `csrftoken`, `api-base`, `features` (`people,groups,public`),
`open` (open on mount; non-`"false"`), `trigger-label`, `disabled`.

Events (bubbling/composed): `share-granted`, `share-updated`, `share-revoked`,
`share-changed`.

It talks to acl's JSON API under `/-/acl/api` (resource read, grant/revoke/
update, groups + actors pickers). Full spec: `../datasette-acl/docs/json-api.md`.
Notable: the **read endpoint is manager-only** (v1) and `revoke` returns the
sorted list of removed action names (`{"ok", "removed": [...]}`).

## Dependencies

`pyproject.toml` pins **datasette-acl to a git branch**:
`datasette-acl @ git+https://github.com/datasette/datasette-acl@acl/7-json-api`
(the JSON API hasn't landed in a tagged acl release yet — bump to a version pin
when it does). Also depends on `datasette>=1.0a20` and `datasette-vite`.

## Dev & test

```sh
just frontend-install          # one-time npm install
just frontend                  # production build → static/gen + manifest.json
just dev                       # datasette + sample-docs demo at :5171
just frontend-dev              # (terminal 1) vite HMR dev server on $DEV_PORT
just dev-with-hmr              # (terminal 2) datasette pointed at the dev server

npm --prefix frontend run test    # vitest (node + browser/chromium)
npm --prefix frontend run check   # svelte-check + tsc (the frontend gate; keep at 0 errors)
uv run pytest                     # python (run via `uv run --no-sync python -m pytest -q`)
```

`DEV_PORT` is a Justfile variable (single source of truth), passed to vite via
env and to datasette-vite's `dev_ports` setting. Built assets are gitignored.

There is no configured Python type-checker; the IDE's `ty` may flag the demo
plugin (e.g. `str | list[str]` from `DOCUMENTS` dicts, unused hook params,
unresolved `datasette_debug_gotham`) — these are runtime-correct noise, not gates.

## The sample-docs demo (`just dev`)

A dev-only plugin that gives the dialog a real resource:
- Registers acl resource type `sample-doc` (parent-only; `parent` = doc id) with
  Viewer/Editor/Manager roles via `register_actions` + `datasette_acl_roles`.
- Seeds 3 documents owned by gotham characters (clark=1, bruce=2, selina=3);
  each owner gets a Manager grant (seeded lazily on first request).
- `/sample-docs` (index) and `/sample-docs/<id>` (one doc, embeds the dialog).
  **Both gate on the `sample-doc-view` acl action** via `datasette.allowed`, so
  viewing reflects sharing: the index lists only docs you can view, and a doc
  page 403s without a grant. The share trigger is `disabled` unless you own the doc.

Switch actors with the **debug bar** (gotham, via datasette-debug-bar) — it sets
the `actor` cookie. user-profiles (seeded by gotham) gives names/avatars/search;
`-s permissions.profile_access.id '*'` in `just dev` lets actors use the picker.

Demo flow: log in as Clark → open doc 1 → share Viewer with Lois → switch to
Lois → doc 1 now appears on her index and opens.

## Current state / what's done

- Frontend types + API client aligned to acl's `acl/7-json-api` JSON API.
- Component is a modal-with-trigger (was inline), with `open`/`trigger-label`/
  `disabled`. Lazy load on open.
- Agent picker feature **removed** (see below).
- Sample-docs demo with real acl gating end-to-end.
- All suites green: frontend check (0 errors), vitest, pytest.

## What's left / deferred

- **Agents.** The dedicated Agents tab + `/-/agent/api` backend were removed to
  simplify (commit "Remove agent picker feature"). To bring agents back, fold
  them into **People search** via acl's actors picker `kind` filter
  (`/-/acl/api/actors?kind=agent`) rather than a separate tab/backend. Design
  notes: `../research-sharing/05-agent-actors-plan.md`.
- **datasette-acl dep is a git branch** — repin to a released version once
  `acl/7-json-api` ships.
- **Read endpoint is manager-only (acl v1).** Non-managers can't load the dialog
  at all; revisit if viewers should see a read-only roster.
- **Consumer migrations** (paper / places / sheets / comments embedding this
  element) are tracked in `../research-sharing/07-*` and `08-roadmap-*` — not
  done here.

Broader plan + open questions live in `../research-sharing/` (this plugin is
"Phase 3" in `08-roadmap-and-open-questions.md`).
