"""Typed models for the resource-type specs.

Each spec module builds a :class:`ResourceSpec` instead of a bare dict, so
``sample_resources.py`` gets attribute access (``spec.instances``,
``grant.group``) with real types instead of ``dict[str, Any]`` indexing — which
is what produced the type-checker noise. pydantic is a Datasette dependency, so
this adds nothing to install.
"""

from typing import Optional

from pydantic import BaseModel


class Grant(BaseModel):
    """A seeded grant: a role plus exactly one principal — an actor id, a group
    name, or a public-audience name (``everyone`` / ``authenticated``)."""

    role: str
    actor: Optional[str] = None
    group: Optional[str] = None
    public: Optional[str] = None


class Instance(BaseModel):
    """One resource instance, backfilled into the instances table."""

    id: str
    title: str
    blurb: str = ""
    grants: list[Grant] = []


class ActionDef(BaseModel):
    """An acl action registered for the resource type."""

    name: str
    description: str


class RoleDef(BaseModel):
    """A hand-rolled role in the type's registry (``manage`` marks who can share)."""

    name: str
    actions: list[str]
    rank: int
    manage: bool = False
    description: str = ""


class StandardRoles(BaseModel):
    """Action names for acl's ``standard_roles()`` factory (Viewer/Editor/Manager)."""

    view: str
    edit: str
    manage: str


class ResourceSpec(BaseModel):
    """A whole resource type: its registry, dialog features, and demo instances.

    Supply either ``roles`` (hand-rolled) or ``standard`` (build via
    ``standard_roles()``), not both.
    """

    type: str
    label: str
    description: str
    blurb: str = ""
    features: Optional[str] = None
    actions: list[ActionDef]
    roles: list[RoleDef] = []
    standard: Optional[StandardRoles] = None
    instances: list[Instance] = []
