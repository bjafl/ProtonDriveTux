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
      include: ["src/lib/**/*.{ts,tsx}", "src/hooks/**/*.ts"],
      exclude: [
        // Tauri IPC wrappers — require live Tauri runtime
        "src/lib/ipcApi.ts",
        "src/lib/tauriFetch.ts",
        "src/lib/paths.ts",
        "src/lib/config.ts",
        // SDK and crypto integrations — require live API / SDK
        "src/lib/drive.ts",
        "src/lib/auth.ts",
        "src/lib/accountProvider.ts",
        "src/lib/httpClient.ts",
        "src/lib/cryptoModule.ts",
        "src/lib/srpModule.ts",
        // Hooks that require a live Tauri context
        "src/hooks/useFileStates.ts",
        "src/hooks/useHumanVerification.ts",
        "src/hooks/useSyncStatus.ts",
        "src/hooks/useTauriEventListener.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
