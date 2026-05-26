import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Everything this plugin ships is a custom element (<datasette-share-dialog>),
    // so compile in customElement mode globally. This also keeps svelte-check happy
    // with <svelte:options customElement="..."> declarations.
    customElement: true,
  },
};
