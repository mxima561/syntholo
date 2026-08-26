import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import { assertProductionBypassDisabled } from "./src/lib/auth/bypass";

loadEnvConfig(path.resolve(import.meta.dirname, "../.."));
assertProductionBypassDisabled();

const nextConfig: NextConfig = {
  typedRoutes: false,
  poweredByHeader: false,
  transpilePackages: ["@syntholo/auth", "@syntholo/db", "@syntholo/domain"],
};

export default nextConfig;
