"""project — hand-rolled roles with NO "Manager"/"Owner" names.

The manage-capable role is **Maintainer** (``manage=True``). This is the
flag-vs-name test case: the dialog must decide "who can manage" from the manage
flag, never the role name. People-only (``features="people"``) — no group or
public sections.
"""

SPEC = {
    "type": "project",
    "label": "Project",
    "description": (
        "A software project workspace — code, issues and docs that a team "
        "reads, contributes to, and administers together."
    ),
    "blurb": (
        "Hand-rolled roles with NO “Manager”/“Owner” names — the "
        "manage-capable role is “Maintainer”. The dialog must key off the "
        "manage flag, not the role name. People-only (no groups/public)."
    ),
    "features": "people",
    "actions": [
        ("project-read", "Read a project"),
        ("project-write", "Write to a project"),
        ("project-admin", "Administer a project (manage sharing)"),
    ],
    "roles": [
        ("Reader", ["project-read"], 1, False, "Can read"),
        ("Contributor", ["project-read", "project-write"], 2, False, "Can read and write"),
        (
            "Maintainer",
            ["project-read", "project-write", "project-admin"],
            3,
            True,
            "Can read, write and administer access",
        ),
    ],
    "instances": [
        {
            "id": "apollo",
            "title": "Project Apollo",
            "blurb": "Clark maintains · Lois contributes · Bruce reads",
            "grants": [
                {"actor": "clark", "role": "Maintainer"},
                {"actor": "lois", "role": "Contributor"},
                {"actor": "bruce", "role": "Reader"},
            ],
        },
        {
            "id": "watchtower",
            "title": "Watchtower",
            "blurb": "A Gotham project — Bruce maintains, Selina contributes",
            "grants": [
                {"actor": "bruce", "role": "Maintainer"},
                {"actor": "selina", "role": "Contributor"},
                {"actor": "alfred", "role": "Reader"},
            ],
        },
        {
            "id": "whistleblower",
            "title": "Whistleblower Files",
            "blurb": "Single maintainer (Lois) — orphan guard blocks removing her",
            "grants": [
                {"actor": "lois", "role": "Maintainer"},
                {"actor": "clark", "role": "Reader"},
            ],
        },
    ],
}
