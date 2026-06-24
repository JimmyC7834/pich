import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: {
    outDir: "../hub-dist-vscode", emptyOutDir: true,
    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } },
  },
});
