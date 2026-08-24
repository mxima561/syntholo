import { buildApi } from "./app";

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApi();
await app.listen({ port, host: "0.0.0.0" });
