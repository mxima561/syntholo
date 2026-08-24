import { loadEnvConfig } from "@next/env";
import path from "node:path";
import type { NextConfig } from "next";

loadEnvConfig(path.resolve(import.meta.dirname, "../.."));

const nextConfig: NextConfig = {
  typedRoutes: true,
  poweredByHeader: false,
  transpilePackages: ["@syntholo/db", "@syntholo/domain", "@syntholo/contracts"],
};

export default nextConfig;
