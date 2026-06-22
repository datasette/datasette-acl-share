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
# + datasette-user-profiles. Visit http://localhost:5171/sample-resources, "log in"
# as a character (start as Clark — he manages one of every type), and exercise the
# share dialog against each instance.

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

dev *flags:
  DATASETTE_SECRET=abc123 uv run \
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
