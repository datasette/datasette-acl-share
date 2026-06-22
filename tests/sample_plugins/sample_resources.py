"""The sample plugin: many resource types, editable instances, varied ACL shapes.

This is the demo `just dev` serves. It registers several acl resource types
whose role registries deliberately span the spectrum, then serves one
``/sample-resources`` page that embeds ``<datasette-acl-share-dialog>`` against
every instance. The point is to see, on a single page, lots of different
"documents" — playlists, projects, pastes, channels — each shared with different
people, groups and public audiences, so switching actors in the debug bar
visibly recolours the whole page (your role on each, and which dialogs you can
open).

The resource types (one ``sample_resource_specs`` module each):

- ``playlist``  — the canonical Viewer / Editor / Manager triple built with
  acl's :func:`datasette_acl.roles.standard_roles` factory. The "standard" path.
- ``project``  — hand-rolled roles whose manage-capable role is named
  **Maintainer** (no role called "Manager" or "Owner" anywhere). Proves the
  dialog detects "who can manage" from the ``manage`` flag, not the role name.
- ``paste``    — the "simple" shape: just **Viewer** + **Owner** (a literal
  ``Owner`` role, no Editor tier) plus a public audience. Owner-and-public only.
- ``channel``  — the odd, maximal one: five cumulative tiers with **two**
  manage-capable roles (Moderator and Owner).

Instances are **real, editable rows**. They live in a ``sample_resource_instances``
table in Datasette's internal database — the same database acl runs each type's
``resources_sql`` against — so the page can create / edit / delete them and acl
sees the change immediately. On startup the table is created and the demo
instances from the specs are backfilled (``INSERT OR IGNORE``); their grants are
seeded lazily on first request (acl's tables must exist first). Creating an
instance grants its creator the type's top manage role; editing and deleting are
gated on ``can_manage`` (acl's read endpoint is manager-only anyway). The
internal db is in-memory under ``just dev``, so edits last for the process and
reset to the demo set on restart.

Each type's specs live in the ``sample_resource_specs`` package (one module per
type) — add a module there to add a resource type; no change here is needed.
Each spec is a typed ``ResourceSpec`` (see ``sample_resource_specs/_models.py``):

  type        acl resource_type name (and Resource.name).
  label       human heading for the gallery section.
  description plain-English line on what the resource *is*.
  blurb       one line on what's *special* about this registry's permissions.
  features  the dialog's `features` attribute (which sections to show), or
            None to show everything.
  actions   [ActionDef(name, description)] — registered via register_actions.
  roles     [RoleDef(name, actions, rank, manage, description)] — the registry.
            A ``standard=StandardRoles(...)`` instead means: build it with
            standard_roles().
  instances [Instance(id, title, blurb, grants)] — backfilled into the table.
            grants is [Grant(role + one of actor|group|public)], seeded so the
            resource opens onto a realistic roster.

Log in as **Clark** via the debug bar — he manages at least one instance of
every type — to drive the whole gallery.

Loaded via ``--plugins-dir tests/sample_plugins``. It reuses gotham's
actors/groups and the same asset-injection discipline, gated to
``/sample-resources`` pages.
"""

import json
import os
import re
import sys

from datasette import hookimpl, Response
from datasette.permissions import Action, Resource

from datasette_acl_share import datasette_share_assets

# ``--plugins-dir`` execs this file via spec_from_file_location without putting
# its directory on sys.path, so a plain ``import sample_resource_specs`` would
# fail. Add our own directory first, then import the spec package (a subdir,
# which the plugins-dir glob does NOT pick up — so its modules load once, here,
# rather than registering as empty plugins).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sample_resource_specs import RESOURCE_SPECS  # noqa: E402

_SPECS_BY_TYPE = {spec.type: spec for spec in RESOURCE_SPECS}
_INSTANCES_TABLE = "sample_resource_instances"


# --- Resource classes, built from the specs --------------------------------


def _make_resource_class(spec):
    """A parent-only Resource subclass enumerating this type's instances.

    ``resources_sql`` is run by acl against the internal database, which is
    exactly where the editable instances table lives — so adding/removing a row
    there immediately changes which resources of this type exist.
    """
    resource_type = spec.type

    class _SampleResource(Resource):
        name = resource_type
        parent_class = None

        @classmethod
        async def resources_sql(cls, datasette, actor=None):
            # Two columns (parent, child); one row per instance of this type.
            return (
                "SELECT id AS parent, NULL AS child "
                f"FROM {_INSTANCES_TABLE} WHERE type = '{resource_type}'"
            )

    _SampleResource.__name__ = f"Resource_{resource_type}"
    return _SampleResource


_RESOURCE_CLASSES = {spec.type: _make_resource_class(spec) for spec in RESOURCE_SPECS}


def _roles_for_spec(spec):
    """Resolve a spec to a list of AclRole, using standard_roles() when asked."""
    from datasette_acl.roles import AclRole, standard_roles

    if spec.standard is not None:
        s = spec.standard
        return standard_roles(spec.type, view=s.view, edit=s.edit, manage=s.manage)
    return [
        AclRole(
            resource_type=spec.type,
            name=r.name,
            actions=r.actions,
            rank=r.rank,
            manage=r.manage,
            description=r.description,
        )
        for r in spec.roles
    ]


def _top_manage_role(spec):
    """The type's highest-rank manage-capable role — granted to a new instance's
    creator so they can immediately manage sharing."""
    manage = [r for r in _roles_for_spec(spec) if r.manage]
    return max(manage, key=lambda r: r.rank).name if manage else None


# --- acl hooks -------------------------------------------------------------


@hookimpl
def register_actions(datasette):
    return [
        Action(
            name=action.name,
            description=action.description,
            resource_class=_RESOURCE_CLASSES[spec.type],
        )
        for spec in RESOURCE_SPECS
        for action in spec.actions
    ]


@hookimpl
def datasette_acl_roles(datasette):
    roles = []
    for spec in RESOURCE_SPECS:
        roles.extend(_roles_for_spec(spec))
    return roles


# --- the instances table: schema + backfill --------------------------------


async def _ensure_instances(datasette):
    """Create the instances table and backfill the demo rows. Idempotent."""
    db = datasette.get_internal_database()
    await db.execute_write(
        f"""CREATE TABLE IF NOT EXISTS {_INSTANCES_TABLE} (
            type TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            blurb TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (type, id)
        )"""
    )
    for spec in RESOURCE_SPECS:
        for inst in spec.instances:
            await db.execute_write(
                f"INSERT OR IGNORE INTO {_INSTANCES_TABLE} (type, id, title, blurb) "
                "VALUES (?, ?, ?, ?)",
                [spec.type, inst.id, inst.title, inst.blurb],
            )


@hookimpl
def startup(datasette):
    # Create the instances table + backfill before any request, so acl's
    # resources_sql (which SELECTs from it) always has a table to read.
    async def inner():
        await _ensure_instances(datasette)

    return inner


# --- grant seeding ---------------------------------------------------------


async def _resolve_group_id(db, name):
    """Group id by name, creating the row if absent."""
    await db.execute_write("INSERT OR IGNORE INTO acl_groups (name) VALUES (?)", [name])
    return (
        await db.execute("SELECT id FROM acl_groups WHERE name = ?", [name])
    ).single_value()


async def _ensure_seed_grants(datasette):
    """Seed every demo instance's grants. Lazy: acl's tables must exist first."""
    if getattr(datasette, "_sample_resources_seeded", False):
        return
    from datasette_acl.grants import grant, Principal

    db = datasette.get_internal_database()
    for spec in RESOURCE_SPECS:
        for instance in spec.instances:
            for share in instance.grants:
                if share.group is not None:
                    principal = Principal.group(await _resolve_group_id(db, share.group))
                elif share.public is not None:
                    principal = Principal.public(share.public)
                else:
                    principal = Principal.actor(share.actor)
                await grant(
                    datasette,
                    spec.type,
                    instance.id,
                    principal=principal,
                    role=share.role,
                    by_actor="sample-resources-seed",
                )
    datasette._sample_resources_seeded = True


async def _highest_role_for_actor(datasette, spec, instance_id, actor):
    """The actor's highest role on an instance, for the page's badge.

    Resolved the same way acl does it: collect the actions the actor is
    ``allowed`` on this resource, then map that set to the best-fit role via
    ``role_for_actions``. Returns the role name, or ``None`` for no access.
    """
    from datasette_acl.roles import role_for_actions

    roles = _roles_for_spec(spec)
    resource = _RESOURCE_CLASSES[spec.type](instance_id)
    granted = set()
    for action in {a for role in roles for a in role.actions}:
        if await datasette.allowed(action=action, resource=resource, actor=actor):
            granted.add(action)
    role = role_for_actions(roles, granted)
    return role.name if role else None


# --- asset injection + menu ------------------------------------------------


def _is_sample_page(request):
    return request is not None and request.path.startswith("/sample-resources")


@hookimpl
def extra_js_urls(datasette, request):
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
            "href": datasette.urls.path("/sample-resources"),
            "label": "Sample resources (ACL gallery)",
            "description": "Share dialog against varied acl role registries",
        }
    ]


# --- page ------------------------------------------------------------------


async def gallery_page(request, datasette):
    from datasette_acl.utils import can_manage

    await _ensure_instances(datasette)
    await _ensure_seed_grants(datasette)

    db = datasette.get_internal_database()
    actor = request.actor or {}
    actor_json = ""
    if actor.get("id"):
        actor_json = json.dumps({"id": actor["id"], "kind": actor.get("kind", "user")})

    sections = []
    for spec in RESOURCE_SPECS:
        rows = await db.execute(
            f"SELECT id, title, blurb FROM {_INSTANCES_TABLE} "
            "WHERE type = ? ORDER BY rowid",
            [spec.type],
        )
        instances = []
        for row in rows.rows:
            instances.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "blurb": row["blurb"],
                    "role": await _highest_role_for_actor(
                        datasette, spec, row["id"], request.actor
                    ),
                    "can_manage": await can_manage(
                        datasette, request.actor, spec.type, row["id"]
                    ),
                }
            )
        sections.append(
            {
                "type": spec.type,
                "label": spec.label,
                "description": spec.description,
                "features": spec.features,
                "instances": instances,
            }
        )

    return Response.html(
        await datasette.render_template(
            "sample_resources.html",
            {
                "sections": sections,
                "actor_json": actor_json,
                "actor_id": actor.get("id", ""),
                "types": [
                    {"type": s.type, "label": s.label} for s in RESOURCE_SPECS
                ],
            },
            request=request,
        )
    )


# --- create / edit / delete ------------------------------------------------


def _slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug or "untitled"


async def _unique_id(db, resource_type, base):
    """A slug unique within this type, suffixing -2, -3, … on collision."""
    candidate, n = base, 1
    while (
        await db.execute(
            f"SELECT 1 FROM {_INSTANCES_TABLE} WHERE type = ? AND id = ?",
            [resource_type, candidate],
        )
    ).rows:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def _redirect():
    return Response.redirect("/sample-resources")


async def create_instance(request, datasette):
    from datasette_acl.grants import grant, Principal

    await _ensure_instances(datasette)
    actor = request.actor or {}
    post = await request.post_vars()
    resource_type = post.get("type", "")
    spec = _SPECS_BY_TYPE.get(resource_type)
    title = (post.get("title") or "").strip()
    # Only signed-in actors can create, and only known types.
    if not actor.get("id") or spec is None or not title:
        return _redirect()

    db = datasette.get_internal_database()
    instance_id = await _unique_id(db, resource_type, _slugify(title))
    await db.execute_write(
        f"INSERT INTO {_INSTANCES_TABLE} (type, id, title, blurb) VALUES (?, ?, ?, ?)",
        [resource_type, instance_id, title, (post.get("blurb") or "").strip()],
    )
    # Give the creator the type's top manage role so they can share it.
    role = _top_manage_role(spec)
    if role:
        await grant(
            datasette,
            resource_type,
            instance_id,
            principal=Principal.actor(actor["id"]),
            role=role,
            by_actor=actor["id"],
        )
    return _redirect()


async def _require_manage(request, datasette, resource_type, instance_id):
    """True if the request's actor may edit/delete this instance."""
    from datasette_acl.utils import can_manage

    if resource_type not in _SPECS_BY_TYPE:
        return False
    return await can_manage(datasette, request.actor, resource_type, instance_id)


async def edit_instance(request, datasette):
    await _ensure_instances(datasette)
    post = await request.post_vars()
    resource_type, instance_id = post.get("type", ""), post.get("id", "")
    if not await _require_manage(request, datasette, resource_type, instance_id):
        return _redirect()
    db = datasette.get_internal_database()
    await db.execute_write(
        f"UPDATE {_INSTANCES_TABLE} SET title = ?, blurb = ? WHERE type = ? AND id = ?",
        [
            (post.get("title") or "").strip() or instance_id,
            (post.get("blurb") or "").strip(),
            resource_type,
            instance_id,
        ],
    )
    return _redirect()


async def delete_instance(request, datasette):
    await _ensure_instances(datasette)
    post = await request.post_vars()
    resource_type, instance_id = post.get("type", ""), post.get("id", "")
    if not await _require_manage(request, datasette, resource_type, instance_id):
        return _redirect()
    db = datasette.get_internal_database()
    # Drop the row and its acl grants together (resource addressed parent-only).
    await db.execute_write(
        f"DELETE FROM acl WHERE resource_id IN (SELECT id FROM acl_resources "
        "WHERE resource_type = ? AND parent = ? AND child IS NULL)",
        [resource_type, instance_id],
    )
    await db.execute_write(
        "DELETE FROM acl_resources WHERE resource_type = ? AND parent = ? "
        "AND child IS NULL",
        [resource_type, instance_id],
    )
    await db.execute_write(
        f"DELETE FROM {_INSTANCES_TABLE} WHERE type = ? AND id = ?",
        [resource_type, instance_id],
    )
    return _redirect()


@hookimpl
def register_routes():
    return [
        (r"^/sample-resources$", gallery_page),
        (r"^/sample-resources/create$", create_instance),
        (r"^/sample-resources/edit$", edit_instance),
        (r"^/sample-resources/delete$", delete_instance),
    ]
