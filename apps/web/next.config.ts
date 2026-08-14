import type { NextConfig } from "next";
import { parseWebApiConfig } from "./src/lib/api/config";
import {
  parseWebBuildIdentity,
  resolveWebDeploymentId,
} from "./src/lib/config/build";

const api = parseWebApiConfig(process.env);
const releaseSha = parseWebBuildIdentity(process.env);

const nextConfig: NextConfig = {
  deploymentId: resolveWebDeploymentId(process.env, releaseSha),
  env: { NEXT_PUBLIC_RELEASE_SHA: releaseSha },
  generateBuildId: async () => releaseSha,
  output: "standalone",
  typedRoutes: true,
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [api.rewrite], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
