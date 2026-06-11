"""Python side of the ``<datasette-acl-share-dialog>`` share dialog.

Ships :func:`datasette_share_assets` (opt-in asset helper for hosts) and the
``GET /-/share/capabilities`` probe. See the README for embedding details.
"""

from datasette import hookimpl, Response
from datasette_vite import vite_js_urls, vite_css_urls

# Vite manifest key for the bundle entrypoint; importing the bundle registers
# the custom element.
ENTRYPOINT = "src/main.ts"
PLUGIN_PACKAGE = "datasette_acl_share"

# Optional backend that lights up People search + avatars.
PROFILES_PLUGIN = "datasette-user-profiles"


def datasette_share_assets(datasette):
    """Return ``{"js": [...], "css": [...]}`` for the built bundle.

    Hosts return these from their own ``extra_js_urls`` / ``extra_css_urls``
    hooks (gated on their pages) so the dialog loads only where used — the
    plugin deliberately registers no site-wide assets. In datasette-vite dev
    mode the URLs point at the dev server and ``css`` is empty (Vite injects
    CSS via JS).
    """
    return {
        "js": vite_js_urls(
            datasette=datasette,
            entrypoint=ENTRYPOINT,
            plugin_package=PLUGIN_PACKAGE,
        ),
        "css": vite_css_urls(
            datasette=datasette,
            entrypoint=ENTRYPOINT,
            plugin_package=PLUGIN_PACKAGE,
        ),
    }


def share_capabilities(datasette=None):
    """Report which dialog sections the installed backends can support.

    ``people`` requires datasette-user-profiles; ``groups`` and ``public`` are
    intrinsic to datasette-acl. Never raises — a missing plugin just yields
    ``false``.
    """
    try:
        from datasette.plugins import get_plugins

        installed = {p.get("name") for p in get_plugins()}
    except Exception:
        installed = set()
    return {
        "people": PROFILES_PLUGIN in installed,
        "groups": True,
        "public": True,
    }


async def capabilities_view(request, datasette):
    """GET /-/share/capabilities → the capability probe as JSON (read-only)."""
    return Response.json(share_capabilities(datasette))


@hookimpl
def register_routes():
    return [
        ("^/-/share/capabilities$", capabilities_view),
    ]
