"""datasette-share — the reusable ``<datasette-share-dialog>`` share dialog.

This module is the Python side of the plugin. It ships:

- :func:`datasette_share_assets` — an **opt-in** asset helper that returns the
  built JS/CSS URLs (via ``datasette-vite``'s manifest) so a host plugin can
  include the bundle *only on its own pages* rather than site-wide. Hosts call
  it from their own ``extra_js_urls`` / ``extra_css_urls`` hooks (or splice the
  URLs into a template). See the README "Embedding" section.

- :func:`share_capabilities` + a ``GET /-/share/capabilities`` endpoint — a
  capability probe reporting which optional backends are installed
  (``people`` → datasette-user-profiles, ``agents`` → datasette-agent). Hosts
  can use it to set the element's ``features`` attribute without guessing.
  ``groups`` and ``public`` are intrinsic to datasette-acl and always reported
  true. The probe degrades gracefully: when profiles / agent are absent the
  corresponding flag is simply ``false``.

CSRF (datasette 1.0a30): core replaced token-based ``asgi-csrf`` with the
header-based ``CrossOriginProtectionMiddleware`` (Sec-Fetch-Site + Origin).
Same-origin ``fetch()`` writes from the dialog are accepted automatically with
no token, so this plugin (and the acl JSON API it talks to) carry no CSRF token
plumbing. The element still accepts a ``csrftoken`` attribute and forwards it as
``x-csrftoken`` for forward/back compat with older asgi-csrf deployments; core
ignores it. The ``GET /-/share/capabilities`` endpoint is read-only and needs no
token. See the README "CSRF" section.
"""

from datasette import hookimpl, Response
from datasette_vite import vite_js_urls, vite_css_urls

# The Vite manifest key for the bundle entrypoint (see frontend/vite.config.ts:
# rollupOptions.input.main -> "src/main.ts"). Importing it registers the
# <datasette-share-dialog> custom element.
ENTRYPOINT = "src/main.ts"
PLUGIN_PACKAGE = "datasette_share"

# Distribution names of the optional backends that light up dialog features.
PROFILES_PLUGIN = "datasette-user-profiles"
AGENT_PLUGIN = "datasette-agent"


def datasette_share_assets(datasette):
    """Return the built bundle's asset URLs for opt-in inclusion by a host.

    Returns a dict with two keys suitable for Datasette's asset hooks::

        {
          "js":  [{"url": "/-/static-plugins/datasette_share/gen/main-….js",
                   "module": True}],
          "css": ["/-/static-plugins/datasette_share/gen/main-….css", …],
        }

    A host plugin includes the bundle *only on its own pages* by returning these
    from its own ``extra_js_urls`` / ``extra_css_urls`` hooks (gated on the
    relevant page), instead of datasette-share registering a site-wide
    ``extra_js_urls`` — keeping the dialog off every other Datasette page
    (decision: plan §7, opt-in by default).

    In datasette-vite dev mode (``plugins.datasette-vite.dev_paths`` /
    ``dev_ports`` keyed on ``datasette_share``) the ``js`` list includes the Vite
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


def _installed_plugin_names():
    """The set of installed Datasette plugin distribution names.

    Imported lazily so importing this module never fails if Datasette's plugin
    machinery is unavailable (it always is at runtime, but keep it defensive).
    """
    try:
        from datasette.plugins import get_plugins

        return {p.get("name") for p in get_plugins()}
    except Exception:
        return set()


def share_capabilities(datasette=None):
    """Report which dialog sections the installed backends can support.

    ``people`` requires datasette-user-profiles (search + avatars); ``agents``
    requires datasette-agent (agent identities). ``groups`` and ``public``
    (general-access wildcards) are intrinsic to datasette-acl and reported true.

    Degrades gracefully: a missing optional plugin simply yields ``false`` for
    its flag rather than raising — so a host that probes before profiles/agent
    are installed gets a usable (people/agents-off) capability set.
    """
    installed = _installed_plugin_names()
    return {
        "people": PROFILES_PLUGIN in installed,
        "agents": AGENT_PLUGIN in installed,
        "groups": True,
        "public": True,
    }


async def capabilities_view(request, datasette):
    """GET /-/share/capabilities → the capability probe as JSON.

    Read-only; no CSRF token required (datasette 1.0a30 same-origin GETs).
    """
    return Response.json(share_capabilities(datasette))


@hookimpl
def register_routes():
    return [
        ("^/-/share/capabilities$", capabilities_view),
    ]
