import { access } from "node:fs/promises";

await Promise.all([
  access(new URL("../apps/web/package.json", import.meta.url)),
  access(new URL("../apps/web/src/app/page.tsx", import.meta.url)),
  access(new URL("../apps/web/tsconfig.json", import.meta.url)),
]);
