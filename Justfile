# datasette-acl-share — dev recipes
#
# First-time setup:
#   just frontend-install
#
# Static build (no HMR):
#   just frontend          # builds into datasette_acl_share/static/gen + manifest.json
#
# Live HMR workflow (two terminals):
#   Terminal 1:  just frontend-dev    # vite dev server on :5180
#   Terminal 2:  just dev-with-hmr    # datasette pointed at the vite dev server

frontend-install:
  npm --prefix frontend install

frontend:
  npm --prefix frontend run build

frontend-dev:
  npm --prefix frontend run dev

check-frontend:
  npm --prefix frontend run check

dev:
  DATASETTE_SECRET=abc123 uv run \
    --prerelease=allow \
    --with-editable . \
    --with 'datasette>=1a' \
    datasette \
    --root \
    tmp.db --create \
    -p 5171 \
    --internal internal.db

dev-with-hmr *flags:
  DATASETTE_SECRET=abc123 uv run \
    --prerelease=allow \
    --with-editable . \
    --with 'datasette>=1a' \
    datasette \
    --root \
    -s plugins.datasette-vite.dev_paths.datasette_acl_share 'http://localhost:5180/-/static-plugins/datasette_acl_share/' \
    tmp.db --create \
    -p 5171 \
    --internal internal.db \
    {{flags}}
