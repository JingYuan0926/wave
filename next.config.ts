import type { NextConfig } from "next";

// The phone wallet UI runs in the Vite dev server. The rewrites keep it on this origin, so it
// shares localStorage, passkeys and /api with the Next pages.
const walletUi = (process.env.WAVE_WALLET_UI ?? "http://localhost:5174").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // A fixed value lets the build remove the mock branches and their chunks.
  env: {
    NEXT_PUBLIC_WAVE_MOCK: process.env.NEXT_PUBLIC_WAVE_MOCK === "1" ? "1" : "0",
  },
  // These packages load wasm and workers at run time, so the bundler must leave them alone.
  serverExternalPackages: ["snarkjs", "circomlibjs", "ffjavascript"],
  async rewrites() {
    return {
      // The phone wallet is the home page. This rule runs before the file for / in app/.
      beforeFiles: [{ source: "/", destination: `${walletUi}/wallet/` }],
      // Vite serves the page only at /wallet/, with the slash. Next removes the slash from the
      // browser URL, so the first rule adds it back for Vite.
      afterFiles: [
        { source: "/wallet", destination: `${walletUi}/wallet/` },
        { source: "/wallet/:path*", destination: `${walletUi}/wallet/:path*` },
      ],
      fallback: [],
    };
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
