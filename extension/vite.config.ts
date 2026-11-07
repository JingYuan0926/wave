import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DEV_PORT = 5174; // 5173 is the local explorer.

export default defineConfig(({ command }) => ({
  // Next serves the dev UI at /wallet, on its own origin. The relative build path stays for the
  // extension: the built files load from chrome-extension://
  base: command === "serve" ? "/wallet/" : "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@" is the repo root, so the UI reuses lib/ and does not copy it.
    alias: { "@": repo },
    dedupe: ["react", "react-dom", "viem", "ox"],
  },
  // Only named public values go in the bundle. Never add a secret or a whole env object here.
  define: {
    "process.env.NEXT_PUBLIC_WAVE_MOCK": JSON.stringify(process.env.NEXT_PUBLIC_WAVE_MOCK === "1" ? "1" : "0"),
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // Live reload connects to Vite directly. The Next rewrites carry only normal requests.
    hmr: { clientPort: DEV_PORT },
    // The tunnel can reach this server through Next, so allow only the folders that the UI reads.
    fs: { allow: [here, join(repo, "lib"), join(repo, "node_modules")] },
  },
  build: { outDir: "dist", emptyOutDir: true },
}));
