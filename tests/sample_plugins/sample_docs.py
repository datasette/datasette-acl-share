"""A throwaway sample plugin for exercising the share dialog end-to-end.

Loaded via ``--plugins-dir tests/sample_plugins`` from ``just dev`` (NOT a
packaged plugin — it is dev/demo scaffolding only). It gives the dialog a real
resource to talk to:

- A DB-backed ``documents`` table (in an in-memory ``sample`` database) seeded
  with a few docs, each owned by a datasette-debug-gotham character.
- An acl resource type ``sample-doc`` (parent-only; ``parent`` = document id)
  with Viewer / Editor / Manager roles, registered via ``register_actions`` +
  ``datasette_acl_roles`` exactly as a real consumer plugin would.
- Each document's owner is granted the Manager role on it (in acl's internal
  DB), so logging in as that owner makes ``can_manage`` true and the dialog
  renders its full editing UI.
- Pages at ``/sample-docs`` (index) and ``/sample-docs/<id>`` (one doc), the
  latter embedding ``<datasette-acl-share-dialog>``. Both render through
  templates in ``tests/templates`` (loaded via ``--template-dir``) that extend
  Datasette's ``base.html`` — so we inherit the normal chrome, and the gotham
  debug-bar gives the actor switcher for free.

The dialog's JS/CSS are injected the documented way — via this plugin's
``extra_js_urls`` / ``extra_css_urls`` hooks, gated to ``/sample-docs`` pages so
the bundle doesn't load site-wide. A ``homepage_actions`` item links to the demo
from the instance action menu.

Pair with datasette-debug-gotham (actors / switcher) and datasette-user-profiles
(names + avatars + people search).
"""

import json

from datasette import hookimpl, Forbidden, Response
from datasette.permissions import Action, Resource

from datasette_acl_share import datasette_share_assets

# datasette-debug-gotham's demo actors (Clark Kent, Bruce Wayne, …). Imported
# softly so this plugin still loads if gotham is absent — the picker just goes
# empty and owners show as raw ids.
try:
    from datasette_debug_gotham import ACTORS as GOTHAM_ACTORS
except Exception:  # pragma: no cover - depends on dev env
    GOTHAM_ACTORS = {}


# --- the resource type -----------------------------------------------------


class SampleDocResource(Resource):
    """Parent-only resource: a document addressed by ``parent`` = its id."""

    name = "sample-doc"
    parent_class = None

    @classmethod
    async def resources_sql(cls, datasette, actor=None):
        # Two columns (parent, child); one row per known document.
        return " UNION ALL ".join(
            f"SELECT '{doc['id']}' AS parent, NULL AS child" for doc in DOCUMENTS
        )


# Three roles for the sample-doc type. Manager is the only ``manage=True`` role,
# so its exclusive action (``sample-doc-manage``) is what authorizes re-sharing.
ROLES = [
    ("Viewer", ["sample-doc-view"], 1, False, "Can view"),
    ("Editor", ["sample-doc-view", "sample-doc-edit"], 2, False, "Can view and edit"),
    (
        "Manager",
        ["sample-doc-view", "sample-doc-edit", "sample-doc-manage"],
        3,
        True,
        "Full control, including sharing",
    ),
]


# --- the demo documents ----------------------------------------------------

DOCUMENTS = [
    {
        "id": "1",
        "title": "Daily Planet — Front Page",
        "owner": "clark",
        "body": [
            "METROPOLIS — City officials confirmed this morning that the "
            "restored Hobbs Bay seawall held through the overnight storm "
            "surge, sparing the waterfront district a repeat of last spring's "
            "flooding.",
            "“We planned for the hundred-year event and we got it,” the chief "
            "engineer said at a sunrise briefing. Cleanup crews expect the "
            "promenade to reopen by the weekend.",
            "Continued on A4. Photos by the Daily Planet photo desk.",
        ],
    },
    {
        "id": "2",
        "title": "Wayne Enterprises Q2 Memo",
        "owner": "bruce",
        "body": [
            "To: Division leads\nFrom: Office of the CEO\nRe: Second-quarter "
            "priorities",
            "Applied Sciences will consolidate the clean-energy and transit "
            "programs under a single roadmap this quarter. Expect a combined "
            "budget review before the board meets in August.",
            "Please route headcount requests through Finance by the end of the "
            "month so we can close the quarter cleanly.",
        ],
    },
    {
        "id": "3",
        "title": "Rooftop Surveillance Notes",
        "owner": "selina",
        "body": [
            "11:40pm — Gallery skylight still propped on the east corner. Two "
            "guards, one patrol loop every nineteen minutes. Predictable.",
            "12:05am — Delivery van idling in the alley. Plates obscured. "
            "Worth a second look tomorrow night.",
            "Note to self: the Cartier exhibit closes Thursday. After that the "
            "cases go back to the vault.",
        ],
    },
]
_DOCS_BY_ID = {doc["id"]: doc for doc in DOCUMENTS}


def _owner_name(owner_id):
    return GOTHAM_ACTORS.get(owner_id, {}).get("name", owner_id)


# --- acl hooks -------------------------------------------------------------


@hookimpl
def register_actions(datasette):
    return [
        Action(
            name="sample-doc-view",
            description="View a sample doc",
            resource_class=SampleDocResource,
        ),
        Action(
            name="sample-doc-edit",
            description="Edit a sample doc",
            resource_class=SampleDocResource,
        ),
        Action(
            name="sample-doc-manage",
            description="Manage sharing for a sample doc",
            resource_class=SampleDocResource,
        ),
    ]


@hookimpl
def datasette_acl_roles(datasette):
    # AclRole is defined by datasette-acl; import lazily so this file imports
    # even when acl is not installed.
    from datasette_acl.roles import AclRole

    return [
        AclRole(
            resource_type="sample-doc",
            name=name,
            actions=actions,
            rank=rank,
            manage=manage,
            description=description,
        )
        for (name, actions, rank, manage, description) in ROLES
    ]


@hookimpl
def datasette_acl_valid_actors(datasette):
    """Feed the acl actors picker on an acl-only deployment (no user-profiles).

    When user-profiles IS installed the picker proxies to it instead and these
    are ignored; either way the gotham cast is searchable.
    """
    return [
        {"id": actor_id, "display": info.get("name", actor_id)}
        for actor_id, info in GOTHAM_ACTORS.items()
    ]


# --- seeding ---------------------------------------------------------------


@hookimpl
def startup(datasette):
    async def inner():
        db = datasette.add_memory_database("sample")
        await db.execute_write(
            "CREATE TABLE IF NOT EXISTS documents "
            "(id TEXT PRIMARY KEY, title TEXT, owner TEXT)"
        )
        for doc in DOCUMENTS:
            await db.execute_write(
                "INSERT OR REPLACE INTO documents (id, title, owner) VALUES (?, ?, ?)",
                [doc["id"], doc["title"], doc["owner"]],
            )

    return inner


async def _ensure_owner_grants(datasette):
    """Grant each document's owner the Manager role on it (idempotent).

    Done lazily on first request rather than in ``startup`` because it writes
    through acl's grant helper, which needs acl's own startup migrations to have
    already created the internal tables — and cross-plugin startup order isn't
    guaranteed.
    """
    if getattr(datasette, "_sample_docs_seeded", False):
        return
    from datasette_acl.grants import grant

    for doc in DOCUMENTS:
        await grant(
            datasette,
            "sample-doc",
            doc["id"],
            actor_id=doc["owner"],
            role="Manager",
            by_actor="sample-docs-startup",
        )
    datasette._sample_docs_seeded = True


# --- asset injection + menu ------------------------------------------------


def _is_sample_page(request):
    return request is not None and request.path.startswith("/sample-docs")


@hookimpl
def extra_js_urls(datasette, request):
    # Opt-in: load the dialog bundle only on the demo's own pages.
    if not _is_sample_page(request):
        return []
    return datasette_share_assets(datasette)["js"]


@hookimpl
def extra_css_urls(datasette, request):
    if not _is_sample_page(request):
        return []
    return datasette_share_assets(datasette)["css"]


@hookimpl
def homepage_actions(datasette, actor, request):
    return [
        {
            "href": datasette.urls.path("/sample-docs"),
            "label": "Sample documents",
            "description": "Demo documents for exercising the share dialog",
        }
    ]


# --- pages -----------------------------------------------------------------


async def index_page(request, datasette):
    await _ensure_owner_grants(datasette)
    # Only list documents the current actor may view (same gate as the doc
    # page), so the index reflects acl sharing rather than every document.
    documents = []
    for doc in DOCUMENTS:
        if await datasette.allowed(
            action="sample-doc-view",
            resource=SampleDocResource(doc["id"]),
            actor=request.actor,
        ):
            documents.append({**doc, "owner_name": _owner_name(doc["owner"])})
    return Response.html(
        await datasette.render_template(
            "sample_docs_index.html", {"documents": documents}, request=request
        )
    )


async def doc_page(request, datasette):
    await _ensure_owner_grants(datasette)
    doc = _DOCS_BY_ID.get(request.url_vars["doc_id"])
    if doc is None:
        return Response.html("Not found", status=404)

    # Gate viewing on the acl `sample-doc-view` action, so reading a document
    # actually reflects who's been shared in. The owner holds it via the seeded
    # Manager grant; everyone else needs an explicit grant (e.g. Viewer).
    if not await datasette.allowed(
        action="sample-doc-view",
        resource=SampleDocResource(doc["id"]),
        actor=request.actor,
    ):
        raise Forbidden("You don't have access to this document")

    actor = request.actor or {}
    actor_json = ""
    if actor.get("id"):
        actor_json = json.dumps({"id": actor["id"], "kind": actor.get("kind", "user")})

    context = {
        "doc": {**doc, "owner_name": _owner_name(doc["owner"])},
        "actor_json": actor_json,
        "is_owner": actor.get("id") == doc["owner"],
    }
    return Response.html(
        await datasette.render_template("sample_doc.html", context, request=request)
    )


@hookimpl
def register_routes():
    return [
        (r"^/sample-docs$", index_page),
        (r"^/sample-docs/(?P<doc_id>[^/]+)$", doc_page),
    ]
