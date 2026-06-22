"""playlist — the canonical Viewer / Editor / Manager triple.

Built with acl's ``standard_roles()`` factory (signalled by the ``standard``
key), so this is the path most consumer plugins take. People + groups + public.
"""

SPEC = {
    "type": "playlist",
    "label": "Playlist",
    "description": (
        "A shared music playlist — a curated list of tracks one person owns "
        "and others can play or add to."
    ),
    "blurb": (
        "Standard Viewer / Editor / Manager triple, built with acl's "
        "standard_roles() factory — the path most plugins take."
    ),
    "features": None,  # people + groups + public
    "standard": {
        "view": "playlist-view",
        "edit": "playlist-edit",
        "manage": "playlist-manage",
    },
    "actions": [
        ("playlist-view", "View a playlist"),
        ("playlist-edit", "Edit a playlist"),
        ("playlist-manage", "Manage sharing for a playlist"),
    ],
    "instances": [
        {
            "id": "summer-mix",
            "title": "Summer Road-Trip Mix",
            "blurb": "Clark manages · whole Daily Planet edits · any signed-in viewer",
            "grants": [
                {"actor": "clark", "role": "Manager"},
                {"group": "daily-planet", "role": "Editor"},
                {"public": "authenticated", "role": "Viewer"},
            ],
        },
        {
            "id": "gotham-after-dark",
            "title": "Gotham After Dark",
            "blurb": "A Gotham-Gazette playlist — Bruce manages, Selina edits",
            "grants": [
                {"actor": "bruce", "role": "Manager"},
                {"actor": "selina", "role": "Editor"},
                {"group": "gotham-gazette", "role": "Viewer"},
            ],
        },
        {
            "id": "office-party",
            "title": "Office Party",
            "blurb": "Public — Lois manages, everyone (incl. anon) can view",
            "grants": [
                {"actor": "lois", "role": "Manager"},
                {"public": "everyone", "role": "Viewer"},
            ],
        },
    ],
}
