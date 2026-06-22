"""channel — the maximal/odd one: five tiers with TWO manage-capable roles.

Guest / Member / Editor / Moderator / Owner, where both **Moderator** and
**Owner** carry ``manage=True``. Exercises last-manager counting (two managers
present, so removing one is allowed), owner-first ordering and a deep role
dropdown. People + groups + public.
"""

from ._models import ActionDef, Grant, Instance, ResourceSpec, RoleDef

SPEC = ResourceSpec(
    type="channel",
    label="Channel",
    description=(
        "A team chat channel — an ongoing conversation with guests, members, "
        "editors, moderators and an owner."
    ),
    blurb=(
        "The maximal/odd one: five cumulative tiers with TWO manage-capable "
        "roles (Moderator and Owner). Exercises last-manager counting, "
        "owner-first ordering and a deep role dropdown."
    ),
    features=None,
    actions=[
        ActionDef(name="channel-view", description="View a channel"),
        ActionDef(name="channel-post", description="Post in a channel"),
        ActionDef(name="channel-edit", description="Edit others' posts in a channel"),
        ActionDef(name="channel-moderate", description="Moderate a channel (manage sharing)"),
        ActionDef(name="channel-admin", description="Administer a channel (manage sharing)"),
    ],
    roles=[
        RoleDef(name="Guest", actions=["channel-view"], rank=1, manage=False, description="Can read"),
        RoleDef(
            name="Member",
            actions=["channel-view", "channel-post"],
            rank=2,
            manage=False,
            description="Can read and post",
        ),
        RoleDef(
            name="Editor",
            actions=["channel-view", "channel-post", "channel-edit"],
            rank=3,
            manage=False,
            description="Can read, post and edit others' posts",
        ),
        RoleDef(
            name="Moderator",
            actions=["channel-view", "channel-post", "channel-edit", "channel-moderate"],
            rank=4,
            manage=True,
            description="Can moderate and manage sharing",
        ),
        RoleDef(
            name="Owner",
            actions=[
                "channel-view",
                "channel-post",
                "channel-edit",
                "channel-moderate",
                "channel-admin",
            ],
            rank=5,
            manage=True,
            description="Full control",
        ),
    ],
    instances=[
        Instance(
            id="newsroom-chat",
            title="#newsroom",
            blurb="Two managers — Clark (Owner) + Lois (Moderator); orphan guard lets either go",
            grants=[
                Grant(actor="clark", role="Owner"),
                Grant(actor="lois", role="Moderator"),
                Grant(actor="jimmy", role="Member"),
                Grant(group="gotham-gazette", role="Guest"),
            ],
        ),
        Instance(
            id="gotham-desk",
            title="#gotham-desk",
            blurb="Bruce owns · Alfred moderates · Selina edits · Daily Planet guests",
            grants=[
                Grant(actor="bruce", role="Owner"),
                Grant(actor="alfred", role="Moderator"),
                Grant(actor="selina", role="Editor"),
                Grant(group="daily-planet", role="Guest"),
            ],
        ),
        Instance(
            id="announcements",
            title="#announcements",
            blurb="Single owner (Clark) · everyone guests — orphan guard pins Clark",
            grants=[
                Grant(actor="clark", role="Owner"),
                Grant(public="everyone", role="Guest"),
            ],
        ),
    ],
)
