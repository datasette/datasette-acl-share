"""paste — the "simple" shape: Viewer + Owner only, plus a public audience.

A two-role registry with a literal ``Owner`` role (``manage=True``) and no
Editor tier. Sharing is owner-and-public only (``features="people,public"`` —
no groups).
"""

SPEC = {
    "type": "paste",
    "label": "Paste",
    "description": (
        "A code or text paste — a single snippet shared by link, like a gist. "
        "One owner; everyone else just reads it."
    ),
    "blurb": (
        "The “simple” shape: just Viewer + Owner (a literal Owner role, no "
        "Editor tier) plus a public audience. Owner-and-public sharing only."
    ),
    "features": "people,public",
    "actions": [
        ("paste-view", "View a paste"),
        ("paste-manage", "Manage sharing for a paste"),
    ],
    "roles": [
        ("Viewer", ["paste-view"], 1, False, "Can view"),
        ("Owner", ["paste-view", "paste-manage"], 2, True, "Full control"),
    ],
    "instances": [
        {
            "id": "kryptonite-notes",
            "title": "Kryptonite Field Notes",
            "blurb": "Clark owns · everyone (incl. anon) can view",
            "grants": [
                {"actor": "clark", "role": "Owner"},
                {"public": "everyone", "role": "Viewer"},
            ],
        },
        {
            "id": "batcomputer-snippet",
            "title": "Batcomputer Snippet",
            "blurb": "Bruce owns · a few named people view",
            "grants": [
                {"actor": "bruce", "role": "Owner"},
                {"actor": "alfred", "role": "Viewer"},
                {"actor": "selina", "role": "Viewer"},
            ],
        },
        {
            "id": "press-release-draft",
            "title": "Press Release Draft",
            "blurb": "Single owner (Jimmy) · any signed-in actor views",
            "grants": [
                {"actor": "jimmy", "role": "Owner"},
                {"public": "authenticated", "role": "Viewer"},
            ],
        },
    ],
}
