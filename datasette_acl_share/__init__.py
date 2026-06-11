"""datasette-acl-share — the reusable ``<datasette-acl-share-dialog>`` share dialog.

This module is the Python side of the plugin. It ships:

- :func:`datasette_share_assets` — an **opt-in** asset helper that returns the
  built JS/CSS URLs (via ``datasette-vite``'s manifest) so a host plugin can
  include the bundle *only on its own pages* rather than site-wide. Hosts call
  it from their own ``extra_js_urls`` / ``extra_css_urls`` hooks (or splice the
  URLs into a template). See the README "Embedding" section.

- :func:`share_capabilities` + a ``GET /-/share/capabilities`` endpoint — a
  capability probe reporting which optional backends are installed
  (``people`` → datasette-user-profiles). Hosts can use it to set the element's
  ``features`` attribute without guessing. ``groups`` and ``public`` are
  intrinsic to datasette-acl and always reported true. The probe degrades
  gracefully: when profiles is absent the ``people`` flag is simply ``false``.

"""

from datasette import hookimpl, Response
from datasette_vite import vite_js_urls, vite_css_urls

# The Vite manifest key for the bundle entrypoint (see frontend/vite.config.ts:
# rollupOptions.input.main -> "src/main.ts"). Importing it registers the
# <datasette-acl-share-dialog> custom element.
ENTRYPOINT = "src/main.ts"
PLUGIN_PACKAGE = "datasette_acl_share"

# Distribution name of the optional backend that lights up dialog features.
PROFILES_PLUGIN = "datasette-user-profiles"


def datasette_share_assets(datasette):
    """Return the built bundle's asset URLs for opt-in inclusion by a host.

    Returns a dict with two keys suitable for Datasette's asset hooks::

        {
          "js":  [{"url": "/-/static-plugins/datasette_acl_share/gen/main-….js",
                   "module": True}],
          "css": ["/-/static-plugins/datasette_acl_share/gen/main-….css", …],
        }

    A host plugin includes the bundle *only on its own pages* by returning these
    from its own ``extra_js_urls`` / ``extra_css_urls`` hooks (gated on the
    relevant page), instead of datasette-acl-share registering a site-wide
    ``extra_js_urls`` — keeping the dialog off every other Datasette page
    (decision: plan §7, opt-in by default).

    In datasette-vite dev mode (``plugins.datasette-vite.dev_paths`` /
    ``dev_ports`` keyed on ``datasette_acl_share``) the ``js`` list includes the Vite
    client and points at the dev server; ``css`` is ``[]`` (Vite injects CSS via
    JS). Both behaviours come straight from datasette-vite.
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

    ``people`` requires datasette-user-profiles (search + avatars). ``groups``
    and ``public`` (general-access wildcards) are intrinsic to datasette-acl and
    reported true.

    Degrades gracefully: a missing optional plugin simply yields ``false`` for
    its flag rather than raising — so a host that probes before profiles is
    installed gets a usable (people-off) capability set.
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
