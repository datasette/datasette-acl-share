"""project — hand-rolled roles with NO "Manager"/"Owner" names.

The manage-capable role is **Maintainer** (``manage=True``). This is the
flag-vs-name test case: the dialog must decide "who can manage" from the manage
flag, never the role name. People-only (``features="people"``) — no group or
public sections.
"""

from ._models import ActionDef, Grant, Instance, ResourceSpec, RoleDef

SPEC = ResourceSpec(
    type="project",
    label="Project",
    description=(
        "A software project workspace — code, issues and docs that a team "
        "reads, contributes to, and administers together."
    ),
    blurb=(
        "Hand-rolled roles with NO “Manager”/“Owner” names — the "
        "manage-capable role is “Maintainer”. The dialog must key off the "
        "manage flag, not the role name. People-only (no groups/public)."
    ),
    features="people",
    actions=[
        ActionDef(name="project-read", description="Read a project"),
        ActionDef(name="project-write", description="Write to a project"),
        ActionDef(name="project-admin", description="Administer a project (manage sharing)"),
    ],
    roles=[
        RoleDef(name="Reader", actions=["project-read"], rank=1, manage=False, description="Can read"),
        RoleDef(
            name="Contributor",
            actions=["project-read", "project-write"],
            rank=2,
            manage=False,
            description="Can read and write",
        ),
        RoleDef(
            name="Maintainer",
            actions=["project-read", "project-write", "project-admin"],
            rank=3,
            manage=True,
            description="Can read, write and administer access",
        ),
    ],
    instances=[
        Instance(
            id="apollo",
            title="Project Apollo",
            blurb="Clark maintains · Lois contributes · Bruce reads",
            grants=[
                Grant(actor="clark", role="Maintainer"),
                Grant(actor="lois", role="Contributor"),
                Grant(actor="bruce", role="Reader"),
            ],
        ),
        Instance(
            id="watchtower",
            title="Watchtower",
            blurb="A Gotham project — Bruce maintains, Selina contributes",
            grants=[
                Grant(actor="bruce", role="Maintainer"),
                Grant(actor="selina", role="Contributor"),
                Grant(actor="alfred", role="Reader"),
            ],
        ),
        Instance(
            id="whistleblower",
            title="Whistleblower Files",
            blurb="Single maintainer (Lois) — orphan guard blocks removing her",
            grants=[
                Grant(actor="lois", role="Maintainer"),
                Grant(actor="clark", role="Reader"),
            ],
        ),
    ],
)
