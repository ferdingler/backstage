import type { NextConfig } from "next";

// Host and agent pages/routes are named `*.private.ts(x)`. Only the local
// build (BACKSTAGE_BUILD=local, set by server.mjs and `npm run build:local`)
// compiles them. Any other build is public-only: those routes do not exist.
const local = process.env.BACKSTAGE_BUILD === "local";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  pageExtensions: local ? ["private.tsx", "private.ts", "tsx", "ts"] : ["tsx", "ts"],
  env: { BACKSTAGE_BUILD: local ? "local" : "public" },
};
export default config;
