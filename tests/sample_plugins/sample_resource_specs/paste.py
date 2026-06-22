"""paste — the "simple" shape: Viewer + Owner only, plus a public audience.

A two-role registry with a literal ``Owner`` role (``manage=True``) and no
Editor tier. Sharing is owner-and-public only (``features="people,public"`` —
no groups).
"""

from ._models import ActionDef, Grant, Instance, ResourceSpec, RoleDef

SPEC = ResourceSpec(
    type="paste",
    label="Paste",
    description=(
        "A code or text paste — a single snippet shared by link, like a gist. "
        "One owner; everyone else just reads it."
    ),
    blurb=(
        "The “simple” shape: just Viewer + Owner (a literal Owner role, no "
        "Editor tier) plus a public audience. Owner-and-public sharing only."
    ),
    features="people,public",
    actions=[
        ActionDef(name="paste-view", description="View a paste"),
        ActionDef(name="paste-manage", description="Manage sharing for a paste"),
    ],
    roles=[
        RoleDef(name="Viewer", actions=["paste-view"], rank=1, manage=False, description="Can view"),
        RoleDef(
            name="Owner",
            actions=["paste-view", "paste-manage"],
            rank=2,
            manage=True,
            description="Full control",
        ),
    ],
    instances=[
        Instance(
            id="kryptonite-notes",
            title="Kryptonite Field Notes",
            blurb="Clark owns · everyone (incl. anon) can view",
            grants=[
                Grant(actor="clark", role="Owner"),
                Grant(public="everyone", role="Viewer"),
            ],
        ),
        Instance(
            id="batcomputer-snippet",
            title="Batcomputer Snippet",
            blurb="Bruce owns · a few named people view",
            grants=[
                Grant(actor="bruce", role="Owner"),
                Grant(actor="alfred", role="Viewer"),
                Grant(actor="selina", role="Viewer"),
            ],
        ),
        Instance(
            id="press-release-draft",
            title="Press Release Draft",
            blurb="Single owner (Jimmy) · any signed-in actor views",
            grants=[
                Grant(actor="jimmy", role="Owner"),
                Grant(public="authenticated", role="Viewer"),
            ],
        ),
    ],
)
