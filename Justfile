# datasette-acl-share — dev recipes
#
# First-time setup:
#   just frontend-install
#
# Static build (no HMR):
#   just frontend          # builds into datasette_acl_share/static/gen + manifest.json
#
# Live HMR workflow (two terminals):
#   Terminal 1:  just frontend-dev    # vite dev server on $DEV_PORT
#   Terminal 2:  just dev-with-hmr    # datasette pointed at the vite dev server
#
# `just dev` loads a sample plugin (tests/sample_plugins) + datasette-debug-gotham
# + datasette-user-profiles. Visit http://localhost:5171/sample-docs, "log in" as
# a character (Clark owns doc 1), open a doc, and exercise the share dialog.

# Single source of truth for the vite dev-server port. Consumed by both the
# vite config (via the DEV_PORT env var) and datasette-vite's dev_ports setting.
DEV_PORT := "5180"

frontend-install:
  npm --prefix frontend install

frontend:
  npm --prefix frontend run build

frontend-dev:
  DEV_PORT={{DEV_PORT}} npm --prefix frontend run dev

check-frontend:
  npm --prefix frontend run check

# NOTE: acl comes from the local checkout, not PyPI — the demo seeds grants
# with the explicit principal_type= kwarg (acl general-access-principals
# branch, unreleased as of 0.5a1). It is installed straight into the project
# venv and `uv run --no-sync` keeps it there (a `--with-editable` overlay
# won't do: the overlay re-resolves datasette-acl from the registry — the
# checkout still reports 0.5a1 — and shadows the venv). The project itself
# comes from `uv sync` (editable), so no `--with-editable .` either: its
# overlayed deps would drag registry acl back in. Drop all this once the
# branch ships in a tagged release.
dev *flags:
  uv sync
  uv pip install -q -e ../datasette-acl
  DATASETTE_SECRET=abc123 uv run \
    --no-sync \
    --prerelease=allow \
    --with-editable ../datasette-debug-gotham \
    --with-editable ../datasette-user-profiles \
    --with-editable ../datasette-debug-bar \
    --with 'datasette>=1a' \
    datasette \
    --root \
    --plugins-dir tests/sample_plugins \
    --template-dir tests/templates \
    -s permissions.profile_access.id '*' \
    -s plugins.datasette-acl.dynamic-groups.daily-planet.newsroom daily-planet \
    -s plugins.datasette-acl.dynamic-groups.gotham-gazette.newsroom gotham-gazette \
    tmp.db --create \
    -p 5171 \
    --internal internal.db \
    {{flags}}

# Same as `dev`, but points datasette-vite at the running vite dev server
# (run `just frontend-dev` in another terminal first).
dev-with-hmr *flags:
  just dev -s plugins.datasette-vite.dev_ports.datasette_acl_share {{DEV_PORT}} {{flags}}

# Screenshot the share dialog in each sharing shape → docs/screenshots/*.png.
# Drives a running `just dev` demo (start it in another terminal first).
shots:
  npm --prefix frontend exec -- playwright install chromium
  node frontend/scripts/screenshots.mjs
