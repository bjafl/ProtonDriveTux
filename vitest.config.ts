import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: true,
    server: {
      deps: {
        // These packages ship ESM or TS source that jsdom can't load without
        // being transformed by Vite's pipeline first.
        inline: [
          "@tauri-apps/api",
          "@protontech/drive-sdk",
          "@protontech/crypto",
        ],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/drive.ts", "src/lib/paths.ts"],
      reporter: ["text", "json-summary"],
      // all: true,
    },
  },
});
