"""channel — the maximal/odd one: five tiers with TWO manage-capable roles.

Guest / Member / Editor / Moderator / Owner, where both **Moderator** and
**Owner** carry ``manage=True``. Exercises last-manager counting (two managers
present, so removing one is allowed), owner-first ordering and a deep role
dropdown. People + groups + public.
"""

SPEC = {
    "type": "channel",
    "label": "Channel",
    "description": (
        "A team chat channel — an ongoing conversation with guests, members, "
        "editors, moderators and an owner."
    ),
    "blurb": (
        "The maximal/odd one: five cumulative tiers with TWO manage-capable "
        "roles (Moderator and Owner). Exercises last-manager counting, "
        "owner-first ordering and a deep role dropdown."
    ),
    "features": None,
    "actions": [
        ("channel-view", "View a channel"),
        ("channel-post", "Post in a channel"),
        ("channel-edit", "Edit others' posts in a channel"),
        ("channel-moderate", "Moderate a channel (manage sharing)"),
        ("channel-admin", "Administer a channel (manage sharing)"),
    ],
    "roles": [
        ("Guest", ["channel-view"], 1, False, "Can read"),
        ("Member", ["channel-view", "channel-post"], 2, False, "Can read and post"),
        (
            "Editor",
            ["channel-view", "channel-post", "channel-edit"],
            3,
            False,
            "Can read, post and edit others' posts",
        ),
        (
            "Moderator",
            ["channel-view", "channel-post", "channel-edit", "channel-moderate"],
            4,
            True,
            "Can moderate and manage sharing",
        ),
        (
            "Owner",
            [
                "channel-view",
                "channel-post",
                "channel-edit",
                "channel-moderate",
                "channel-admin",
            ],
            5,
            True,
            "Full control",
        ),
    ],
    "instances": [
        {
            "id": "newsroom-chat",
            "title": "#newsroom",
            "blurb": "Two managers — Clark (Owner) + Lois (Moderator); orphan guard lets either go",
            "grants": [
                {"actor": "clark", "role": "Owner"},
                {"actor": "lois", "role": "Moderator"},
                {"actor": "jimmy", "role": "Member"},
                {"group": "gotham-gazette", "role": "Guest"},
            ],
        },
        {
            "id": "gotham-desk",
            "title": "#gotham-desk",
            "blurb": "Bruce owns · Alfred moderates · Selina edits · Daily Planet guests",
            "grants": [
                {"actor": "bruce", "role": "Owner"},
                {"actor": "alfred", "role": "Moderator"},
                {"actor": "selina", "role": "Editor"},
                {"group": "daily-planet", "role": "Guest"},
            ],
        },
        {
            "id": "announcements",
            "title": "#announcements",
            "blurb": "Single owner (Clark) · everyone guests — orphan guard pins Clark",
            "grants": [
                {"actor": "clark", "role": "Owner"},
                {"public": "everyone", "role": "Guest"},
            ],
        },
    ],
}
