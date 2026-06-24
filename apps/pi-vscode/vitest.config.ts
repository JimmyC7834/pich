import { defineConfig } from "vitest/config";

// VSCode-side tests live in src/; the merged-in pi extension's tests live in
// bridge/test/. Scope discovery to both so vitest never picks up the CommonJS
// copies tsc emits into out/ (which can't be imported by vitest).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "bridge/test/**/*.test.ts"],
  },
});
