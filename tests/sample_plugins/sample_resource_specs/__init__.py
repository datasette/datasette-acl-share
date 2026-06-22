"""Resource-type specs for the ``sample_resources`` demo plugin.

Pure data — one module per acl resource type, each exporting a ``SPEC``, a
typed :class:`~._models.ResourceSpec`. ``sample_resources.py`` (the actual
Datasette plugin) imports :data:`RESOURCE_SPECS` from here and does all the
plumbing. This lives in a subdirectory on purpose: ``--plugins-dir`` only globs
top-level ``*.py``, so these modules are NOT auto-registered as (empty) plugins
— they're loaded once, via the orchestrator's import.

Add a resource type by dropping a ``<name>.py`` here that builds a
``ResourceSpec`` and appending it below. See ``_models.py`` for the field shape
and any existing spec for an example.
"""

from . import playlist, project, paste, channel

# Order here is the gallery's display order.
RESOURCE_SPECS = [
    playlist.SPEC,
    project.SPEC,
    paste.SPEC,
    channel.SPEC,
]
