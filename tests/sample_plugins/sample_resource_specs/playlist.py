"""playlist — the canonical Viewer / Editor / Manager triple.

Built with acl's ``standard_roles()`` factory (the ``standard`` field), so this
is the path most consumer plugins take. People + groups + public.
"""

from ._models import ActionDef, Grant, Instance, ResourceSpec, StandardRoles

SPEC = ResourceSpec(
    type="playlist",
    label="Playlist",
    description=(
        "A shared music playlist — a curated list of tracks one person owns "
        "and others can play or add to."
    ),
    blurb=(
        "Standard Viewer / Editor / Manager triple, built with acl's "
        "standard_roles() factory — the path most plugins take."
    ),
    features=None,  # people + groups + public
    standard=StandardRoles(
        view="playlist-view",
        edit="playlist-edit",
        manage="playlist-manage",
    ),
    actions=[
        ActionDef(name="playlist-view", description="View a playlist"),
        ActionDef(name="playlist-edit", description="Edit a playlist"),
        ActionDef(name="playlist-manage", description="Manage sharing for a playlist"),
    ],
    instances=[
        Instance(
            id="summer-mix",
            title="Summer Road-Trip Mix",
            blurb="Clark manages · whole Daily Planet edits · any signed-in viewer",
            grants=[
                Grant(actor="clark", role="Manager"),
                Grant(group="daily-planet", role="Editor"),
                Grant(public="authenticated", role="Viewer"),
            ],
        ),
        Instance(
            id="gotham-after-dark",
            title="Gotham After Dark",
            blurb="A Gotham-Gazette playlist — Bruce manages, Selina edits",
            grants=[
                Grant(actor="bruce", role="Manager"),
                Grant(actor="selina", role="Editor"),
                Grant(group="gotham-gazette", role="Viewer"),
            ],
        ),
        Instance(
            id="office-party",
            title="Office Party",
            blurb="Public — Lois manages, everyone (incl. anon) can view",
            grants=[
                Grant(actor="lois", role="Manager"),
                Grant(public="everyone", role="Viewer"),
            ],
        ),
    ],
)
