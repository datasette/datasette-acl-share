"""Python tests for the datasette-acl-share asset helper + capability probe.

Run: ``uv run pytest`` (or ``uv run --with pytest pytest``).

Note on the capability probe: in this venv datasette-user-profiles and
datasette-agent are NOT installed, so the probe must degrade gracefully and
report ``people: false`` / ``agents: false`` while still reporting the intrinsic
acl features (``groups`` / ``public``) true. That graceful path is exercised
below (``test_capabilities_*``).
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


def test_capabilities_degrade_gracefully():
    """profiles / agent are NOT installed in this venv → people/agents false,
    groups/public (intrinsic to acl) true. Probe must not raise."""
    caps = share_capabilities()
    assert caps == {
        "people": False,
        "agents": False,
        "groups": True,
        "public": True,
    }


def test_capabilities_reflect_installed_plugins(monkeypatch):
    """When profiles + agent report installed, the corresponding flags flip."""
    import datasette_acl_share

    monkeypatch.setattr(
        datasette_acl_share,
        "_installed_plugin_names",
        lambda: {
            "datasette-acl-share",
            "datasette-user-profiles",
            "datasette-agent",
        },
    )
    caps = share_capabilities()
    assert caps == {
        "people": True,
        "agents": True,
        "groups": True,
        "public": True,
    }


def test_capabilities_partial(monkeypatch):
    """profiles installed, agent absent → people true, agents false."""
    import datasette_acl_share

    monkeypatch.setattr(
        datasette_acl_share,
        "_installed_plugin_names",
        lambda: {"datasette-acl-share", "datasette-user-profiles"},
    )
    caps = share_capabilities()
    assert caps["people"] is True
    assert caps["agents"] is False
    assert caps["groups"] is True
    assert caps["public"] is True


@pytest.mark.asyncio
async def test_capabilities_endpoint():
    """GET /-/share/capabilities returns the probe as JSON (read-only, no CSRF
    token needed under 1.0a30)."""
    datasette = Datasette(memory=True)
    response = await datasette.client.get("/-/share/capabilities")
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"people", "agents", "groups", "public"}
    # profiles / agent absent here → graceful false; acl intrinsics true.
    assert data["people"] is False
    assert data["agents"] is False
    assert data["groups"] is True
    assert data["public"] is True
