import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vitest/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: true,
    server: {
      deps: {
        // These packages ship ESM or TS source that jsdom can't load without
        // being transformed by Vite's pipeline first.
        inline: ["@tauri-apps/api", "@protontech/drive-sdk", "@protontech/crypto"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/drive.ts", "src/lib/paths.ts"],
      reporter: ["text", "json-summary"],
      all: true,
    },
  } satisfies UserConfig["test"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,

  // @protontech packages distribute TypeScript source directly.
  // Force esbuild to pre-bundle them (don't exclude) and treat .ts extensions as TypeScript.
  optimizeDeps: {
    include: ["@protontech/crypto", "@protontech/drive-sdk"],
    esbuildOptions: {
      loader: { ".ts": "ts" },
    },
  },

  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
