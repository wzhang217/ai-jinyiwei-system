import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const response = await fetch(`http://${host}:${port}/health/ready`);
if (!response.ok) throw new Error(`health endpoint returned ${response.status}`);
const body = await response.json();
if (!body.ok || Number(body.schema_version) !== Number(body.expected_schema_version)) {
  throw new Error(`service is not ready: ${JSON.stringify(body)}`);
}
const dbPath = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const minimumFreeBytes = Math.max(0, Number(process.env.DISK_MIN_FREE_BYTES) || 1_073_741_824);
const filesystem = statfsSync(dirname(dbPath));
const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
if (freeBytes < minimumFreeBytes) {
  throw new Error(`storage free space below threshold: ${freeBytes} < ${minimumFreeBytes}`);
}
console.log(JSON.stringify({ ...body, storage: { free_bytes: freeBytes, minimum_free_bytes: minimumFreeBytes } }));
