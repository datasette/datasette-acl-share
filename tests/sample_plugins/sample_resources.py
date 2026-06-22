"""The sample plugin: many resource types, many instances, varied ACL shapes.

This is the demo `just dev` serves. It registers several acl resource types
whose role registries deliberately span the spectrum, seeds a handful of
*instances* of each across the gotham cast with different sharing shapes, then
serves ONE ``/sample-resources`` page that embeds
``<datasette-acl-share-dialog>`` against every instance. The point is to see, on
a single page, lots of different "documents" — playlists, projects, pastes,
channels — each shared with different people, groups and public audiences, so
switching actors in the debug bar visibly recolours the whole page (your role on
each, and which dialogs you can open).

The resource types (one ``sample_resource_specs`` module each):

- ``playlist``  — the canonical Viewer / Editor / Manager triple built with
  acl's :func:`datasette_acl.roles.standard_roles` factory. The "standard" path.
- ``project``  — hand-rolled roles whose manage-capable role is named
  **Maintainer** (no role called "Manager" or "Owner" anywhere). Proves the
  dialog detects "who can manage" from the ``manage`` flag, not the role name.
- ``paste``    — the "simple" shape: just **Viewer** + **Owner** (a literal
  ``Owner`` role, no Editor tier) plus a public audience. Owner-and-public only.
- ``channel``  — the odd, maximal one: five cumulative tiers with **two**
  manage-capable roles (Moderator and Owner), exercising last-manager counting,
  owner-first ordering and the role dropdown with a deep registry.

Each type passes a different ``features`` attribute to show section gating
(people-only, people+public, or everything), and each carries a few instances —
including some with a *single* manager, so the dialog's orphan guard (you can't
remove/downgrade the last manager) is exercised too.

The resource-type specs live in the ``sample_resource_specs`` package next to
this file (one module per type) — add a module there to add a resource type;
no change here is needed. Each spec is a dict:

  type        acl resource_type name (and Resource.name).
  label       human heading for the gallery section.
  description plain-English line on what the resource *is*.
  blurb       one line on what's *special* about this registry's permissions.
  features  the dialog's `features` attribute (which sections to show), or
            None to show everything.
  actions   [(action_name, description)] — registered via register_actions.
  roles     [(name, [actions], rank, manage, description)] — the registry.
            A "standard" key instead means: build it with standard_roles().
  instances [{id, title, blurb, grants}]. grants is
            [{role + one of actor|group|public}], seeded so the resource opens
            onto a realistic roster.

Grants are seeded lazily on first request (acl's tables must exist first). On
the page each instance is tagged with the current actor's highest role (or "no
access"), and its share trigger is enabled only when the actor can manage it
(acl's read endpoint is manager-only). Log in as **Clark** via the debug bar —
he manages at least one instance of every type — to drive the whole gallery.

Loaded via ``--plugins-dir tests/sample_plugins``. It reuses gotham's
actors/groups and the same asset-injection discipline, gated to
``/sample-resources`` pages.
"""

import json
import os
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


# --- Resource classes, built from the specs --------------------------------


def _make_resource_class(spec):
    """A parent-only Resource subclass exposing this spec's instances."""
    instance_ids = [inst["id"] for inst in spec["instances"]]

    class _SampleResource(Resource):
        name = spec["type"]
        parent_class = None

        @classmethod
        async def resources_sql(cls, datasette, actor=None):
            # Two columns (parent, child); one row per instance of this type.
            return " UNION ALL ".join(
                f"SELECT '{instance_id}' AS parent, NULL AS child"
                for instance_id in instance_ids
            )

    _SampleResource.__name__ = f"Resource_{spec['type']}"
    return _SampleResource


_RESOURCE_CLASSES = {spec["type"]: _make_resource_class(spec) for spec in RESOURCE_SPECS}


def _roles_for_spec(spec):
    """Resolve a spec to a list of AclRole, using standard_roles() when asked."""
    from datasette_acl.roles import AclRole, standard_roles

    if "standard" in spec:
        return standard_roles(spec["type"], **spec["standard"])
    return [
        AclRole(
            resource_type=spec["type"],
            name=name,
            actions=actions,
            rank=rank,
            manage=manage,
            description=description,
        )
        for (name, actions, rank, manage, description) in spec["roles"]
    ]


# --- acl hooks -------------------------------------------------------------


@hookimpl
def register_actions(datasette):
    return [
        Action(
            name=name,
            description=description,
            resource_class=_RESOURCE_CLASSES[spec["type"]],
        )
        for spec in RESOURCE_SPECS
        for (name, description) in spec["actions"]
    ]


@hookimpl
def datasette_acl_roles(datasette):
    roles = []
    for spec in RESOURCE_SPECS:
        roles.extend(_roles_for_spec(spec))
    return roles


# --- seeding ---------------------------------------------------------------


async def _resolve_group_id(db, name):
    """Group id by name, creating the row if absent."""
    await db.execute_write("INSERT OR IGNORE INTO acl_groups (name) VALUES (?)", [name])
    return (
        await db.execute("SELECT id FROM acl_groups WHERE name = ?", [name])
    ).single_value()


async def _ensure_seed_grants(datasette):
    """Seed every instance's grants. Lazy: acl's tables must exist first."""
    if getattr(datasette, "_sample_resources_seeded", False):
        return
    from datasette_acl.grants import grant, Principal

    db = datasette.get_internal_database()
    for spec in RESOURCE_SPECS:
        for instance in spec["instances"]:
            for share in instance["grants"]:
                if "group" in share:
                    principal = Principal.group(await _resolve_group_id(db, share["group"]))
                elif "public" in share:
                    principal = Principal.public(share["public"])
                else:
                    principal = Principal.actor(share["actor"])
                await grant(
                    datasette,
                    spec["type"],
                    instance["id"],
                    principal=principal,
                    role=share["role"],
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
    resource = _RESOURCE_CLASSES[spec["type"]](instance_id)
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


def _sharing_label(features):
    """Human-readable "what can this be shared with" from the features attr."""
    names = {
        "people": "named people",
        "groups": "groups",
        "public": "public audiences",
    }
    parts = [p.strip() for p in features.split(",")] if features else list(names)
    labels = [names.get(p, p) for p in parts]
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + " and " + labels[-1]


async def gallery_page(request, datasette):
    from datasette_acl.utils import can_manage

    await _ensure_seed_grants(datasette)

    actor = request.actor or {}
    actor_json = ""
    if actor.get("id"):
        actor_json = json.dumps({"id": actor["id"], "kind": actor.get("kind", "user")})

    sections = []
    for spec in RESOURCE_SPECS:
        # Roles, lowest-rank first, with the manage flag + description so the
        # page can lay out the permissions model once per type.
        roles = [
            {"name": r.name, "manage": bool(r.manage), "description": r.description}
            for r in sorted(_roles_for_spec(spec), key=lambda r: r.rank)
        ]
        instances = []
        for instance in spec["instances"]:
            instances.append(
                {
                    "id": instance["id"],
                    "title": instance["title"],
                    "blurb": instance.get("blurb", ""),
                    "role": await _highest_role_for_actor(
                        datasette, spec, instance["id"], request.actor
                    ),
                    "can_manage": await can_manage(
                        datasette, request.actor, spec["type"], instance["id"]
                    ),
                }
            )
        sections.append(
            {
                "type": spec["type"],
                "label": spec["label"],
                "description": spec["description"],
                "blurb": spec["blurb"],
                "features": spec["features"],
                "sharing": _sharing_label(spec["features"]),
                "roles": roles,
                "instances": instances,
            }
        )

    return Response.html(
        await datasette.render_template(
            "sample_resources.html",
            {"sections": sections, "actor_json": actor_json},
            request=request,
        )
    )


@hookimpl
def register_routes():
    return [(r"^/sample-resources$", gallery_page)]
