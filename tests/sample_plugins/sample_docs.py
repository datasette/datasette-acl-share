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
  renders its full editing UI. Some docs also carry preseeded ``shares`` —
  whole-newsroom group grants, single-newsroom, cross-newsroom, named-person,
  and signed-in-public — so the dialog opens onto a realistic roster.
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
    # --- preseeded sharing scenarios ---------------------------------------
    # Beyond the owner's Manager grant, each of these seeds extra grants via
    # the optional "shares" list, exercising a different access shape in the
    # dialog. Group names (daily-planet / gotham-gazette) are gotham's
    # newsroom dynamic-groups; see CLAUDE.md.
    {
        # Daily Planet only: the whole daily-planet newsroom can edit.
        "id": "4",
        "title": "Daily Planet — Newsroom Style Guide",
        "owner": "lois",
        "shares": [{"group": "daily-planet", "role": "Editor"}],
        "body": [
            "Datelines run in small caps. Always confirm a second source before "
            "a name appears above the fold — no exceptions, no matter the deadline.",
            "Avoid “alleged” as a hedge; attribute the claim to whoever made it. "
            "Photo credits go to the desk, never to an individual stringer.",
            "Questions to the copy chief. This guide is living — propose edits in "
            "the margins and they'll be folded in each Friday.",
        ],
    },
    {
        # Gotham Gazette only: the gotham-gazette newsroom can read it.
        "id": "5",
        "title": "Gotham Gazette — Crime Desk Briefing",
        "owner": "alfred",
        "shares": [{"group": "gotham-gazette", "role": "Viewer"}],
        "body": [
            "GOTHAM — Three warehouse fires along the Sprang River in a single "
            "month have the arson unit quietly revising its “coincidence” line.",
            "The pattern: after-hours, accelerant-assisted, and always a unit "
            "that changed hands in the last quarter. Follow the deeds, not the "
            "flames.",
            "Desk assignments for the week are below. Keep the working notes off "
            "shared drives until legal clears the corporate-records request.",
        ],
    },
    {
        # Crossover: a joint investigation both newsrooms can work on —
        # daily-planet edits, gotham-gazette reads along.
        "id": "6",
        "title": "Joint Investigation — Harbor Contracts",
        "owner": "lois",
        "shares": [
            {"group": "daily-planet", "role": "Editor"},
            {"group": "gotham-gazette", "role": "Viewer"},
        ],
        "body": [
            "Two cities, one shipping consortium, and a string of no-bid harbor "
            "contracts that surface in both Hobbs Bay and the Sprang River "
            "redevelopment. The Planet and the Gazette are pooling files.",
            "Shared timeline and the FOIA tracker live in this doc. Metropolis "
            "owns the seawall-contractor thread; Gotham owns the shell-company "
            "ownership map.",
            "Weekly sync Thursdays. Nothing publishes until both desks sign off "
            "— this is a coordinated drop, not a race.",
        ],
    },
    {
        # Two named people only: shared with Lois individually, NOT the whole
        # newsroom — so Jimmy (also daily-planet) can't see it.
        "id": "7",
        "title": "Confidential Source Notes — Hobbs Bay",
        "owner": "clark",
        "shares": [{"actor": "lois", "role": "Editor"}],
        "body": [
            "Source “Tideline” will only meet at the old ferry terminal, never by "
            "phone. Says the seawall sign-off skipped an inspection — has the "
            "paperwork to prove it but won't hand it over yet.",
            "Do not put the real name in any shared file. Lois has the contact "
            "sheet; nobody else on the desk gets it until we've corroborated.",
            "If this leaks before we're ready, the source walks and we lose the "
            "whole harbor thread.",
        ],
    },
    {
        # Public to anyone signed in: a press release. Uses the wildcard
        # `_signed_in` principal rather than a specific actor or group.
        "id": "8",
        "title": "Press Release — Hobbs Bay Seawall Reopening",
        "owner": "jimmy",
        "shares": [{"actor": "_signed_in", "role": "Viewer"}],
        "body": [
            "FOR IMMEDIATE RELEASE — The Hobbs Bay promenade reopens Saturday "
            "following overnight repairs that held through this week's storm "
            "surge, the city engineer's office announced.",
            "A ribbon-cutting is scheduled for 10 a.m. at the waterfront "
            "pavilion. Officials will take questions from credentialed press "
            "afterward.",
            "Media contact and high-resolution images are available on request. "
            "This release may be reproduced in full.",
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


async def _resolve_group_id(db, name):
    """Look up a group's id by name, creating the group row if it's missing.

    The newsroom groups normally exist already (acl creates them at startup
    from the ``dynamic-groups`` config), but create-if-absent keeps seeding
    robust even if that config isn't set — the grant lands either way, and
    membership lights up once the config is present.
    """
    await db.execute_write(
        "INSERT OR IGNORE INTO acl_groups (name) VALUES (?)", [name]
    )
    return (
        await db.execute("SELECT id FROM acl_groups WHERE name = ?", [name])
    ).single_value()


async def _ensure_seed_grants(datasette):
    """Seed each document's owner Manager grant plus any preseeded ``shares``.

    Done lazily on first request rather than in ``startup`` because it writes
    through acl's grant helper, which needs acl's own startup migrations to have
    already created the internal tables — and cross-plugin startup order isn't
    guaranteed.

    A doc's optional ``shares`` list holds dicts with a ``role`` plus exactly one
    of ``actor`` (an actor id, or a wildcard like ``_signed_in`` / ``*``) or
    ``group`` (a group name, resolved to its id).
    """
    if getattr(datasette, "_sample_docs_seeded", False):
        return
    from datasette_acl.grants import grant

    db = datasette.get_internal_database()
    for doc in DOCUMENTS:
        await grant(
            datasette,
            "sample-doc",
            doc["id"],
            actor_id=doc["owner"],
            role="Manager",
            by_actor="sample-docs-seed",
        )
        for share in doc.get("shares", []):
            if "group" in share:
                group_id = await _resolve_group_id(db, share["group"])
                await grant(
                    datasette,
                    "sample-doc",
                    doc["id"],
                    group_id=group_id,
                    role=share["role"],
                    by_actor="sample-docs-seed",
                )
            else:
                await grant(
                    datasette,
                    "sample-doc",
                    doc["id"],
                    actor_id=share["actor"],
                    role=share["role"],
                    by_actor="sample-docs-seed",
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
    await _ensure_seed_grants(datasette)
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
    await _ensure_seed_grants(datasette)
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
