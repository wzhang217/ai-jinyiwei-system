const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const response = await fetch(`http://${host}:${port}/health/ready`);
if (!response.ok) throw new Error(`health endpoint returned ${response.status}`);
const body = await response.json();
if (!body.ok || Number(body.schema_version) !== Number(body.expected_schema_version)) {
  throw new Error(`service is not ready: ${JSON.stringify(body)}`);
}
console.log(JSON.stringify(body));
