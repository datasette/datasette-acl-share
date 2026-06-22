# Integrating the share dialog into your plugin

A guide for plugin authors (human or agent) who want to add a Google-Docs-style
**Share** button to their Datasette plugin's pages using
`datasette-acl-share`.

## What this is, and the division of labour

`datasette-acl-share` ships exactly one thing you embed: a framework-agnostic
custom element, **`<datasette-acl-share-dialog>`**, plus a small Python helper
to load its assets. It is **only the UI**. It does not store grants or decide
policy — it reads and writes them over HTTP against the **datasette-acl** JSON
API.

So integrating means wiring up **three** layers:

| Layer | Who owns it | What you do |
|-------|-------------|-------------|
| **Grant store + policy** | `datasette-acl` | Register a *resource type*, its *actions*, and friendly *roles*; gate your pages on those actions. |
| **Share UI** | `datasette-acl-share` | Load the bundle on your pages and drop the `<datasette-acl-share-dialog>` element into your template. |
| **Your resource** | you | The thing being shared (a document, a project, a row…) and the pages that render it. |

If you only do layer 2 without layer 1, the dialog will load but have nothing
to talk to. Most of the work below is actually datasette-acl modelling.

### Prerequisites

- `datasette>=1.0a30`
- `datasette-acl` installed and its internal database available
  (`--internal internal.db` or equivalent persistent internal DB).
- **Optional:** `datasette-user-profiles` — lights up People search + avatars /
  display names. Absent → the dialog falls back to initials chips and hides the
  People search tab. Groups and "general access" audiences work regardless.

Declare both in your `pyproject.toml` (acl-share pulls acl transitively, but
you import from `datasette_acl` directly, so depend on it explicitly):

```toml
dependencies = [
    "datasette>=1.0a30",
    "datasette-acl",
    "datasette-acl-share",
]
```

---

## Step 1 — Model your resource in datasette-acl

The canonical worked example is
[`tests/sample_plugins/sample_resources.py`](../tests/sample_plugins/sample_resources.py)
— read it alongside this section. The four pieces:

### 1a. A `Resource` subclass

```python
from datasette.permissions import Resource

class MyDocResource(Resource):
    name = "my-doc"          # the resource *type* string used everywhere
    parent_class = None      # parent-only (no child level); set a class for parent/child

    @classmethod
    async def resources_sql(cls, datasette, actor=None):
        # One row per resource, with `parent` (and `child`) columns. Used by
        # acl to enumerate resources for listing-type permission checks.
        return " UNION ALL ".join(
            f"SELECT '{doc_id}' AS parent, NULL AS child" for doc_id in all_doc_ids()
        )
```

A resource is addressed by `(resource_type, parent[, child])`. For a parent-only
type, `parent` is your object's id and `child` is `NULL`.

### 1b. Register actions (`register_actions`)

Actions are the granular permissions acl tracks. Bind each to your resource
class:

```python
from datasette import hookimpl
from datasette.permissions import Action

@hookimpl
def register_actions(datasette):
    return [
        Action(name="my-doc-view",   description="View a doc",   resource_class=MyDocResource),
        Action(name="my-doc-edit",   description="Edit a doc",   resource_class=MyDocResource),
        Action(name="my-doc-manage", description="Manage sharing", resource_class=MyDocResource),
    ]
```

### 1c. Declare friendly roles (`datasette_acl_roles`)

Roles bundle actions into the names the dialog shows (Viewer / Editor /
Manager). Exactly one role should be `manage=True` — its *exclusive* action
(here `my-doc-manage`) is what authorizes re-sharing, and what makes
`can_manage` true so the dialog renders its editing UI.

```python
@hookimpl
def datasette_acl_roles(datasette):
    from datasette_acl.roles import AclRole
    return [
        AclRole(resource_type="my-doc", name="Viewer",  actions=["my-doc-view"], rank=1, description="Can view"),
        AclRole(resource_type="my-doc", name="Editor",  actions=["my-doc-view", "my-doc-edit"], rank=2, description="Can view and edit"),
        AclRole(resource_type="my-doc", name="Manager", actions=["my-doc-view", "my-doc-edit", "my-doc-manage"], rank=3, manage=True, description="Full control, including sharing"),
    ]
```

> ⚠️ The manage role must **bundle** the lower roles' actions but be
> distinguished by an action that appears in **no** non-manage role (the
> "manage-only" action). Otherwise any Viewer/Editor would count as a manager.

### 1d. Seed initial grants

New resources usually need at least an owner who can manage. Seed via the
Python helper (idempotent). Do it **lazily on first request**, not in
`startup` — acl's own startup migrations must run first, and cross-plugin
startup order isn't guaranteed:

```python
from datasette_acl.grants import grant, Principal

await grant(datasette, "my-doc", doc_id, principal=Principal.actor(owner_id), role="Manager", by_actor="my-plugin-seed")
# group grant:     principal=Principal.group(<int>)  (resolve the id by name first)
# public audience: principal=Principal.public("authenticated")  # any logged-in actor
#                  also "everyone" (anyone, incl. anonymous) or "anonymous" (signed-out only)
```

Every grant names exactly one `Principal` — an actor, a group, or a public
audience. Audiences are a *class* of caller identified purely by their type
(`everyone` / `authenticated` / `anonymous`) with **no id**, so there's no
reserved id namespace: an actor literally named `everyone` is just an ordinary
actor, never confused with the audience.

### 1e. Gate your pages on the actions

This is what makes sharing *mean* something — viewing reflects the grants:

```python
from datasette import Forbidden

if not await datasette.allowed(action="my-doc-view", resource=MyDocResource(doc_id), actor=request.actor):
    raise Forbidden("You don't have access to this document")
```

---

## Step 2 — Load the dialog's assets (opt-in, on your pages only)

`datasette-acl-share` does **not** register site-wide assets. You include the
bundle from your own asset hooks, gated to your pages, so the dialog's JS/CSS
loads only where you use it.

```python
from datasette_acl_share import datasette_share_assets   # note: NOT datasette_acl_share_assets

def _is_my_page(request):
    return request is not None and request.path.startswith("/my-docs")

@hookimpl
def extra_js_urls(datasette, request):
    if not _is_my_page(request):
        return []
    return datasette_share_assets(datasette)["js"]

@hookimpl
def extra_css_urls(datasette, request):
    if not _is_my_page(request):
        return []
    return datasette_share_assets(datasette)["css"]
```

`datasette_share_assets(datasette)` returns:

```python
{
  "js":  [{"url": "/-/static-plugins/datasette_acl_share/gen/main-….js", "module": True}],
  "css": ["/-/static-plugins/datasette_acl_share/gen/main-….css", …],
}
```

The JS entry is an ES module (`"module": True`); importing it calls
`customElements.define("datasette-acl-share-dialog", …)`. In datasette-vite dev
mode the `js` list instead points at the Vite dev server (and `css` is `[]`,
since Vite injects CSS via JS) — all handled for you by datasette-vite.

---

## Step 3 — Embed the element

Drop the custom element into your page template. It renders a **share-icon
button**; clicking opens a native modal `<dialog>` (close via ×, backdrop, or
Esc). The resource is fetched **lazily on first open**, so many buttons on a
page cost no network until used.

```html
<datasette-acl-share-dialog
  resource-type="my-doc"
  parent="{{ doc.id }}"
  resource-label="{{ doc.title }}"
  actor-json="{{ actor_json }}"
></datasette-acl-share-dialog>
```

Build `actor-json` server-side so the dialog can label the current actor as
"(you)":

```python
import json
actor = request.actor or {}
actor_json = json.dumps({"id": actor["id"], "kind": actor.get("kind", "user")}) if actor.get("id") else ""
```

### Attribute reference

The element is **light DOM** (`shadow: "none"`) and attributes are
**kebab-case** strings. Boolean-ish attributes (`open`, `disabled`) are "on"
when present and not the literal string `"false"`.

| Attribute | Required | Purpose |
|-----------|----------|---------|
| `resource-type` | ✅ | The acl resource type, e.g. `my-doc`. |
| `parent` | ✅ | Your object's id. |
| `child` | — | Child id for parent/child resource types. |
| `resource-label` | — | Human name shown in dialog copy (e.g. the doc title). |
| `actor-json` | — | JSON `{"id","kind"}` of the current actor, for the "(you)" label. |
| `api-base` | — | Override the acl API prefix (default `/-/acl/api`). |
| `features` | — | Comma list of `people,groups,public` to force which sections show. Missing/empty = enable everything available. |
| `open` | — | When present and not `"false"`, open the modal on mount instead of waiting for a trigger click. |
| `trigger-label` | — | Text shown next to the share icon on the trigger button. |
| `disabled` | — | When present and not `"false"`, disable the trigger (e.g. the current actor can't share this resource). |

### Event reference

The element dispatches `CustomEvent`s that **bubble** and are **composed**, so
you can listen on the element or anywhere up to `document`. `detail` carries the
affected principal:

| Event | `detail` | Fires when |
|-------|----------|-----------|
| `share-granted` | `{ principal, id, role }` | a new grant is added |
| `share-updated` | `{ principal, id, role }` | an existing principal's role changes |
| `share-revoked` | `{ principal, id }` | a principal is removed |
| `share-changed` | `{}` | **after any** of the above — the convenient "something changed, refresh me" signal |

`principal` is `"actor"` or `"group"`; `id` is the actor id or stringified group
id.

```js
document.querySelector("datasette-acl-share-dialog")
  .addEventListener("share-changed", () => {
    // e.g. refresh a "shared with N people" badge
  });
```

---

## Capabilities & the `features` attribute

The dialog shows three optional sections: **People** search, **Groups**, and
**general access** (public audiences). People requires
`datasette-user-profiles`; groups and public are intrinsic to acl.

You usually don't need to set `features` — the dialog enables what's available.
If you want to force a subset (e.g. hide People), pass them explicitly:
`features="groups,public"`.

To decide server-side, probe the capability endpoint this plugin ships:

```
GET /-/share/capabilities  →  {"people": true, "groups": true, "public": true}
```

or call `share_capabilities()` in Python. `people` reflects whether
user-profiles is installed; the others are always `true`.

---


## Web component tips

- **Light DOM / theming.** No shadow root, so your page CSS applies. The
  dialog's own styles use `datasette-acl-share-dialog__*`-prefixed selectors;
  override them from your stylesheet if needed.
- **Attributes are strings.** There are no rich-property bindings — everything
  goes through HTML attributes. For `open`/`disabled`, *presence* (not `"false"`)
  means on; to turn one off, remove the attribute or set it to `"false"`.
- **Reactivity after mount.** The element observes its attributes; changing
  `actor-json`, `disabled`, etc. from JS updates the UI. The resource itself is
  fetched lazily on first open and cached, so changing `parent` after the dialog
  has opened won't refetch — render a fresh element per resource instead.
- **Escape `actor-json` in templates.** It's JSON inside an HTML attribute; use
  your templating engine's attribute-safe output (Jinja autoescaping handles
  this). Don't hand-concatenate.
- **Many instances are cheap.** Each trigger fetches only when first opened, so
  a list page with one button per row makes zero share requests until a user
  clicks one.
- **Upgrade timing.** The element upgrades when the module defines it. Because
  the bundle loads as a `type="module"` script, markup present before the script
  runs still upgrades correctly — you don't need to order them.
- **Listen via bubbling.** Events are `composed: true` + `bubbles: true`, so a
  single delegated listener on a container or `document` catches them from any
  dialog on the page.

---

## Where the data comes from (the JSON API)

The dialog talks to datasette-acl under `/-/acl/api` (overridable via
`api-base`): it reads the resource's grants + roles, and writes
grant/revoke/update, plus group and actor pickers. The full contract is in
[`../datasette-acl/docs/json-api.md`](../../datasette-acl/docs/json-api.md).

Two things to know up front:

- **The read endpoint is manager-only (acl v1).** A non-manager who opens the
  dialog currently gets a `403` and an error message — they can't load a
  read-only roster. If that matters to you, see the design note
  [`viewer-roster.md`](./viewer-roster.md). In the meantime, gate your trigger
  with `disabled` so only managers see an enabled Share button (the demo does
  this via an `is_owner` check).
- **`revoke` returns the removed action names** (`{"ok", "removed": [...]}`); the
  dialog handles this for you.

---

## Minimal end-to-end skeleton

```python
import json
from datasette import hookimpl, Forbidden, Response
from datasette.permissions import Action, Resource
from datasette_acl_share import datasette_share_assets

DOCS = {"1": {"title": "Hello", "owner": "alice"}}

class DocResource(Resource):
    name = "my-doc"
    parent_class = None
    @classmethod
    async def resources_sql(cls, datasette, actor=None):
        return " UNION ALL ".join(f"SELECT '{i}' AS parent, NULL AS child" for i in DOCS)

@hookimpl
def register_actions(datasette):
    return [Action(name=f"my-doc-{a}", resource_class=DocResource) for a in ("view", "edit", "manage")]

@hookimpl
def datasette_acl_roles(datasette):
    from datasette_acl.roles import AclRole
    return [
        AclRole(resource_type="my-doc", name="Viewer",  actions=["my-doc-view"], rank=1),
        AclRole(resource_type="my-doc", name="Editor",  actions=["my-doc-view", "my-doc-edit"], rank=2),
        AclRole(resource_type="my-doc", name="Manager", actions=["my-doc-view", "my-doc-edit", "my-doc-manage"], rank=3, manage=True),
    ]

async def _seed(datasette):
    if getattr(datasette, "_seeded", False):
        return
    from datasette_acl.grants import grant, Principal
    for doc_id, doc in DOCS.items():
        await grant(datasette, "my-doc", doc_id, principal=Principal.actor(doc["owner"]), role="Manager", by_actor="seed")
    datasette._seeded = True

async def doc_page(request, datasette):
    await _seed(datasette)
    doc_id = request.url_vars["doc_id"]
    doc = DOCS.get(doc_id)
    if doc is None:
        return Response.html("Not found", status=404)
    if not await datasette.allowed(action="my-doc-view", resource=DocResource(doc_id), actor=request.actor):
        raise Forbidden("No access")
    actor = request.actor or {}
    actor_json = json.dumps({"id": actor["id"], "kind": actor.get("kind", "user")}) if actor.get("id") else ""
    is_owner = actor.get("id") == doc["owner"]
    html = f"""
      <h1>{doc['title']}</h1>
      <datasette-acl-share-dialog
        resource-type="my-doc" parent="{doc_id}" resource-label="{doc['title']}"
        actor-json='{actor_json}' {"" if is_owner else "disabled"}></datasette-acl-share-dialog>
    """
    return Response.html(html)

def _mine(request):
    return request is not None and request.path.startswith("/my-docs")

@hookimpl
def extra_js_urls(datasette, request):
    return datasette_share_assets(datasette)["js"] if _mine(request) else []

@hookimpl
def extra_css_urls(datasette, request):
    return datasette_share_assets(datasette)["css"] if _mine(request) else []

@hookimpl
def register_routes():
    return [(r"^/my-docs/(?P<doc_id>[^/]+)$", doc_page)]
```

(In a real plugin, render through templates rather than inline HTML so you
inherit Datasette's chrome — see the sample plugin + `tests/templates/`.)

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Dialog opens then shows an error / `403` | Caller isn't a manager of the resource — acl's read endpoint is manager-only (v1). Gate the trigger with `disabled`, or see `viewer-roster.md`. |
| Share button doesn't appear at all | Assets not loaded on this page — check your `extra_js_urls`/`extra_css_urls` gating matches the URL. |
| Element shows as raw markup, never upgrades | The bundle didn't load as a module, or the build is missing — run `just frontend`; confirm the `js` URL 200s. |
| People search empty / no avatars | `datasette-user-profiles` not installed (expected fallback), or you set `features` without `people`. |
| Groups list empty | No groups exist, or dynamic-group membership hasn't been computed yet (acl computes it lazily per-actor on that actor's requests). |
| `can_manage` false for the owner | The owner's Manager grant wasn't seeded, or your manage role's actions overlap the non-manage roles (no manage-only action). |
| Attribute change ignored | The resource is fetched once on first open and cached; re-render a fresh element instead of mutating `resource-type`/`parent` after opening. |

## Integration checklist

- [ ] `Resource` subclass with `name` + `resources_sql`.
- [ ] `register_actions` binding actions to the resource class.
- [ ] `datasette_acl_roles` with exactly one `manage=True` role (manage-only action).
- [ ] Seed owner/initial grants via `datasette_acl.grants.grant` (lazily).
- [ ] Pages gated with `datasette.allowed(action=…, resource=…, actor=…)`.
- [ ] Assets loaded via `datasette_share_assets`, gated to your pages.
- [ ] `<datasette-acl-share-dialog>` embedded with `resource-type` + `parent`
      (and `actor-json`, `resource-label`).
- [ ] Trigger `disabled` for non-managers (until read-only roster lands).
- [ ] (Optional) listen for `share-changed` to refresh your UI.

## See also

- [`../tests/sample_plugins/sample_resources.py`](../tests/sample_plugins/sample_resources.py) — the worked reference implementation.
- [`../CLAUDE.md`](../CLAUDE.md) — component contract + repo internals.
- [`viewer-roster.md`](./viewer-roster.md) — the manager-only read limitation and the plan to lift it.
- [`../../datasette-acl/docs/json-api.md`](../../datasette-acl/docs/json-api.md) — the underlying acl JSON API.
