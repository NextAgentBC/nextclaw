import { defineConfig } from "vitest/config";

// Standalone test runner — uses tsconfig.build.json so we don't need the
// openclaw monorepo's `tsconfig.package-boundary.base.json` to be present.
// Inside the monorepo, the root vitest config takes precedence anyway; this
// file is for running unit tests against a checkout of just this package.
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "es2022",
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts", "**/node_modules/**", "dist/**"],
    environment: "node",
    testTimeout: 10000,
  },
});
