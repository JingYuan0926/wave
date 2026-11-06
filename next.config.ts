import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A fixed value lets the build remove the mock branches and their chunks.
  env: {
    NEXT_PUBLIC_WAVE_MOCK: process.env.NEXT_PUBLIC_WAVE_MOCK === "1" ? "1" : "0",
  },
  // These packages load wasm and workers at run time, so the bundler must leave them alone.
  serverExternalPackages: ["snarkjs", "circomlibjs", "ffjavascript"],
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
