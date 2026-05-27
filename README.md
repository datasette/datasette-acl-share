# datasette-acl-share

A reusable, Google-Docs-style **share dialog** for Datasette, shipped as a
framework-agnostic Svelte 5 custom element: `<datasette-acl-share-dialog>`.

One component, embedded by every document plugin (paper, places, sheets, …). It
orchestrates three backends so consumers write almost no sharing code:

| Concern | Backend |
|---|---|
| read/write grants, roles, groups | [datasette-acl](https://github.com/datasette/datasette-acl) |
| search people, render avatars | datasette-user-profiles |
| list / share-with agents | [datasette-agent](https://github.com/datasette/datasette-agent) |

The dialog degrades gracefully: no profiles → no avatars/search; no agent → no
agents tab.

## Usage

Drop the tag anywhere — inside a Svelte/Preact app, or in plain server-rendered
HTML (custom elements are just DOM):

```html
<datasette-acl-share-dialog
  resource-type="paper-doc"
  parent="mydb"
  child="42"
  resource-label="Q2 Planning"
></datasette-acl-share-dialog>
```

On connect the element calls the [datasette-acl](https://github.com/datasette/datasette-acl)
JSON API to render "people with access" (avatars, role dropdowns, remove
buttons) and a "General access" section, with an add-box that searches people
(profiles), agents (datasette-agent) and groups (acl). Each action is its own
fetch — grant / update / revoke — matching Google Docs' incremental behaviour.

### Attributes

| Attribute | Req | Purpose |
|---|---|---|
| `resource-type` | yes | acl resource type, e.g. `paper-doc`, `places-list`, `sheets-workbook` |
| `parent` | yes | resource identity part 1 (e.g. database name) |
| `child` | – | resource identity part 2 (e.g. row id); omit for parent-only resources |
| `resource-label` | – | display title shown in the dialog header |
| `actor-json` | – | current actor as JSON (`{"id":"alice","kind":"user"}`) — used to mark "(you)" |
| `csrftoken` | – | forwarded as `x-csrftoken` on writes; optional under datasette 1.0a30 (see [CSRF](#csrf)) |
| `features` | – | comma list of sections to show (`people,agents,groups,public`); empty/missing = all available |
| `api-base` | – | override the acl API prefix (default `/-/acl/api`) |

### Events

The element dispatches bubbling, composed `CustomEvent`s so hosts can react
(e.g. paper re-running its SSE subscriber sweep after a revoke):

| Event | `detail` |
|---|---|
| `share-granted` | `{principal, id, role}` |
| `share-updated` | `{principal, id, role}` |
| `share-revoked` | `{principal, id}` |
| `share-changed` | `{}` — fired after any mutation (coarse) |

`principal` is `"actor"` or `"group"`; `id` is the actor id, group id, or a
general-access wildcard (`*` / `_signed_in`).

## Including the bundle (opt-in)

The bundle is built with and served via
[datasette-vite](https://github.com/datasette/datasette-vite). It is **not**
injected site-wide — a host plugin opts in so the dialog only loads on pages
that use it. Call the `datasette_acl_share_assets(datasette)` helper from your
plugin's own asset hooks:

```python
from datasette import hookimpl
from datasette_acl_share import datasette_acl_share_assets

@hookimpl
def extra_js_urls(datasette, request):
    # gate on your own page(s) so it doesn't load everywhere
    if not _is_my_page(request):
        return []
    return datasette_acl_share_assets(datasette)["js"]

@hookimpl
def extra_css_urls(datasette, request):
    if not _is_my_page(request):
        return []
    return datasette_acl_share_assets(datasette)["css"]
```

`datasette_acl_share_assets(datasette)` returns
`{"js": [{"url": …, "module": True}], "css": [url, …]}`. The `js` list is ready
for Datasette's `extra_js_urls` hook; `css` for `extra_css_urls`. In
datasette-vite dev mode the `js` list includes the Vite client (HMR) and `css`
is empty (Vite injects CSS via JS) — your plugin code is identical in dev and
prod.

Svelte/Preact hosts that own their own Vite build can instead splice the URLs
into their page template (the element is registered as soon as the module
loads).

## Capability probe

So a host can set `features` without guessing which optional backends exist,
the plugin exposes `GET /-/share/capabilities`:

```json
{"people": true, "agents": false, "groups": true, "public": true}
```

- `people` — [datasette-user-profiles](https://github.com/datasette/datasette-user-profiles) installed (search + avatars)
- `agents` — [datasette-agent](https://github.com/datasette/datasette-agent) installed (agent identities tab)
- `groups`, `public` — intrinsic to datasette-acl, always `true`

`share_capabilities(datasette)` is also importable if you prefer to compute the
`features` string server-side.

## CSRF

datasette 1.0a30 replaced token-based `asgi-csrf` with the header-based
`CrossOriginProtectionMiddleware` (it checks `Sec-Fetch-Site` / `Origin`).
**Same-origin `fetch()` writes are accepted automatically with no token**, so:

- The dialog's writes (grant / update / revoke against the acl JSON API) work
  out of the box from any page served by the same Datasette instance.
- You do **not** need to pass `csrftoken`. The attribute is still honoured and
  forwarded as an `x-csrftoken` header for forward/back compat with older
  asgi-csrf deployments; core 1.0a30 ignores it.
- The acl JSON API endpoints (`/-/acl/api/resource/.../grant|revoke|update`)
  rely on this core middleware — they carry no per-route CSRF logic. The
  read endpoints and `GET /-/share/capabilities` are GETs and need no token.

If you nonetheless want belt-and-braces, pass Datasette's `csrftoken()` (from a
template or page data) into the element:

```html
<datasette-acl-share-dialog … csrftoken="{{ csrftoken() }}"></datasette-acl-share-dialog>
```

## Embedding

### Inside a Svelte app (paper, places, sheets)

Custom elements are just DOM, so a Svelte app renders the tag directly:

```svelte
<datasette-acl-share-dialog
  resource-type="paper-doc"
  parent={dbName}
  child={docId}
  resource-label={docTitle}
  actor-json={JSON.stringify(actor)}
  onshare-revoked={onShareRevoked}
></datasette-acl-share-dialog>
```

### Plain server-rendered HTML (town, kanban, Jinja pages)

No framework needed — include the bundle (via the helper above) and drop the
tag into a template, wiring events with `addEventListener`:

```html
<datasette-acl-share-dialog
  resource-type="places-list" parent="mydb" child="7"
  resource-label="Lunch spots"
></datasette-acl-share-dialog>
<script type="module">
  document.querySelector("datasette-acl-share-dialog")
    .addEventListener("share-changed", () => console.log("sharing changed"));
</script>
```

A Preact host (datasette-comments) embeds the same tag unchanged — the Svelte
custom element is framework-agnostic.

## Graceful degradation

The dialog adapts to whichever backends are installed:

- **No datasette-user-profiles** → no people search and no avatars; grant rows
  fall back to initials chips and the People tab is hidden (capability probe
  reports `people: false`).
- **No datasette-agent** → the Agents tab is hidden (`agents: false`); the agent
  identities endpoint 404 is treated as "feature off", not an error.
- **Groups / General access** are intrinsic to datasette-acl and always
  available.
- When the current actor cannot manage a resource (`can_manage: false`), the
  dialog renders read-only: roles show as tags, no add-box, no remove buttons.

## Layout

```
datasette_acl_share/   Python package (built assets: static/gen + manifest.json)
frontend/          Svelte 5 + TS source (Vite custom-element build)
```

## Development

```sh
just frontend-install   # one-time npm install
just frontend           # production build (writes static/gen + manifest.json)

# Or with Vite HMR:
just frontend-dev       # terminal 1: vite dev server (port 5180)
just dev-with-hmr       # terminal 2: datasette pointed at the dev server
```

Built assets (`datasette_acl_share/static/`, `manifest.json`) are gitignored and
produced by the build, matching the sibling Svelte plugins.

### Tests

```sh
npm --prefix frontend run test    # vitest (node + browser suites)
npm --prefix frontend run check   # svelte-check + tsc
uv run pytest                     # Python: asset helper + capability probe
```
