import type { NextConfig } from "next";
import { parseWebApiConfig } from "./src/lib/api/config";

const api = parseWebApiConfig(process.env);

const nextConfig: NextConfig = {
  typedRoutes: true,
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [api.rewrite], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
