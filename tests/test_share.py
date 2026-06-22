"""Python tests for the datasette-acl-share asset helper + capability probe.

Run: ``uv run pytest`` (or ``uv run --with pytest pytest``).

Note on the capability probe: datasette-user-profiles IS installed in the dev
env (it backs the `just dev` demo), so the probe reports ``people: true`` here.
The absent-profiles degrade path (``people: false``, acl intrinsics still true)
is exercised by monkeypatching the plugin list (``test_capabilities_*``).
"""

import json

import pytest
from datasette.app import Datasette

from datasette_acl_share import (
    datasette_share_assets,
    share_capabilities,
)


@pytest.mark.asyncio
async def test_plugin_is_installed():
    datasette = Datasette(memory=True)
    response = await datasette.client.get("/-/plugins.json")
    assert response.status_code == 200
    names = {p["name"] for p in response.json()}
    assert "datasette-acl-share" in names


# --- asset helper --------------------------------------------------------


def _write_manifest(tmp_path, manifest):
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))


def test_assets_prod_mode(monkeypatch, tmp_path):
    """datasette_share_assets resolves hashed JS + CSS from the vite manifest,
    pointing at /-/static-plugins/datasette_acl_share/… (mirrors datasette-vite's
    own prod-mode assertions)."""
    manifest = {
        "src/main.ts": {
            "file": "static/gen/main-abc123.js",
            "src": "src/main.ts",
            "isEntry": True,
            "css": ["static/gen/main-def456.css"],
        }
    }
    _write_manifest(tmp_path, manifest)

    # Point the package's __file__-derived manifest dir at the temp manifest by
    # patching the helpers' default resolution: datasette-vite loads the
    # manifest next to the package, so we override the package dir via a shim.
    import datasette_acl_share

    monkeypatch.setattr(datasette_acl_share, "ENTRYPOINT", "src/main.ts")

    datasette = Datasette(memory=True)

    # datasette-vite resolves manifest_dir from the package __file__ by default;
    # call its url helpers directly through our helper but with the temp dir by
    # monkeypatching the wrapped functions to inject manifest_dir.
    from datasette_vite import vite_js_urls, vite_css_urls

    def js(datasette, entrypoint, plugin_package):
        return vite_js_urls(
            datasette=datasette,
            entrypoint=entrypoint,
            plugin_package=plugin_package,
            manifest_dir=tmp_path,
        )

    def css(datasette, entrypoint, plugin_package):
        return vite_css_urls(
            datasette=datasette,
            entrypoint=entrypoint,
            plugin_package=plugin_package,
            manifest_dir=tmp_path,
        )

    monkeypatch.setattr(datasette_acl_share, "vite_js_urls", js)
    monkeypatch.setattr(datasette_acl_share, "vite_css_urls", css)

    assets = datasette_share_assets(datasette)
    assert assets["js"] == [
        {
            "url": "/-/static-plugins/datasette_acl_share/gen/main-abc123.js",
            "module": True,
        }
    ]
    assert assets["css"] == [
        "/-/static-plugins/datasette_acl_share/gen/main-def456.css"
    ]


def test_assets_real_manifest():
    """Against the package's actual built manifest (frontend build runs before
    pytest in CI / the task), the helper returns a static-plugins JS URL and a
    list (possibly empty) of CSS URLs."""
    datasette = Datasette(memory=True)
    assets = datasette_share_assets(datasette)
    assert isinstance(assets["js"], list)
    assert len(assets["js"]) == 1
    entry = assets["js"][0]
    assert entry["module"] is True
    assert entry["url"].startswith("/-/static-plugins/datasette_acl_share/")
    assert entry["url"].endswith(".js")
    assert isinstance(assets["css"], list)


def test_assets_dev_mode():
    """With a datasette-vite dev_path set for datasette_acl_share, the helper yields
    the Vite client + dev-server entry and no CSS (Vite injects it via JS)."""
    datasette = Datasette(
        memory=True,
        metadata={
            "plugins": {
                "datasette-vite": {
                    "dev_paths": {"datasette_acl_share": "http://localhost:5180/"}
                }
            }
        },
    )
    assets = datasette_share_assets(datasette)
    assert assets["js"] == [
        {"url": "http://localhost:5180/@vite/client", "module": True},
        {"url": "http://localhost:5180/src/main.ts", "module": True},
    ]
    assert assets["css"] == []


# --- capability probe ----------------------------------------------------


def test_capabilities_degrade_gracefully(monkeypatch):
    """profiles absent → people false, groups/public (intrinsic to acl) true.
    Profiles is a dev dep here, so simulate its absence via the plugin list."""
    import datasette.plugins

    monkeypatch.setattr(
        datasette.plugins,
        "get_plugins",
        lambda: [{"name": "datasette-acl-share"}],
    )
    caps = share_capabilities()
    assert caps == {
        "people": False,
        "groups": True,
        "public": True,
    }


def test_capabilities_reflect_installed_plugins(monkeypatch):
    """When profiles reports installed, the people flag flips on."""
    import datasette.plugins

    monkeypatch.setattr(
        datasette.plugins,
        "get_plugins",
        lambda: [
            {"name": "datasette-acl-share"},
            {"name": "datasette-user-profiles"},
        ],
    )
    caps = share_capabilities()
    assert caps == {
        "people": True,
        "groups": True,
        "public": True,
    }


@pytest.mark.asyncio
async def test_capabilities_endpoint():
    """GET /-/share/capabilities returns the probe as JSON (read-only)."""
    datasette = Datasette(memory=True)
    response = await datasette.client.get("/-/share/capabilities")
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"people", "groups", "public"}
    # people reflects whether profiles is actually installed (it is, as a dev
    # dep); acl intrinsics are always true.
    from datasette.plugins import get_plugins

    profiles_installed = any(
        p.get("name") == "datasette-user-profiles" for p in get_plugins()
    )
    assert data["people"] is profiles_installed
    assert data["groups"] is True
    assert data["public"] is True
