# datasette-share

A reusable, Google-Docs-style **share dialog** for Datasette, shipped as a
framework-agnostic Svelte 5 custom element: `<datasette-share-dialog>`.

One component, embedded by every document plugin (paper, places, sheets, …). It
orchestrates three backends so consumers write almost no sharing code:

| Concern | Backend |
|---|---|
| read/write grants, roles, groups | [datasette-acl](https://github.com/datasette/datasette-acl) |
| search people, render avatars | datasette-user-profiles |
| list / share-with agents | [datasette-agent](https://github.com/datasette/datasette-agent) |

The dialog degrades gracefully: no profiles → no avatars/search; no agent → no
agents tab.

## Usage

Drop the tag anywhere — inside a Svelte/Preact app, or in plain server-rendered
HTML (custom elements are just DOM):

```html
<datasette-share-dialog
  resource-type="paper-doc"
  parent="mydb"
  child="42"
  resource-label="Q2 Planning"
></datasette-share-dialog>
```

The bundle is served via [datasette-vite](https://github.com/datasette/datasette-vite).
A Python asset helper (opt-in `extra_js_urls` / template injection) and a
capability probe arrive in a later task.

> Status: scaffold. This currently ships a stub element that renders its
> attributes so registration can be verified. The full dialog (people list,
> roles, avatars, add-box pickers, general access) is implemented across
> subsequent tasks.

## Layout

```
datasette_share/   Python package (built assets: static/gen + manifest.json)
frontend/          Svelte 5 + TS source (Vite custom-element build)
```

## Development

```sh
just frontend-install   # one-time npm install
just frontend           # production build (writes static/gen + manifest.json)

# Or with Vite HMR:
just frontend-dev       # terminal 1: vite dev server (port 5180)
just dev-with-hmr       # terminal 2: datasette pointed at the dev server
```

Built assets (`datasette_share/static/`, `manifest.json`) are gitignored and
produced by the build, matching the sibling Svelte plugins.
