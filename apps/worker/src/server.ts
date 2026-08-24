import { buildWorker } from "./app";

const port = Number(process.env.WORKER_PORT ?? 4001);
const app = buildWorker();
await app.listen({ port, host: "0.0.0.0" });
