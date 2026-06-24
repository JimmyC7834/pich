import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    runes: true,
    // Treat any tag containing a dash as a custom element (vscode-* web components).
    customElement: false,
  },
};
