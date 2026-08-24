import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAiService } from "../src/ai.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = path.join(scriptDirectory, "..", "ai-evals", "memory-summary-fixtures.json");

function argumentValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function validateFixtures(fixtures) {
  if (!Array.isArray(fixtures) || !fixtures.length) throw new Error("AI evaluation fixtures must be a non-empty array");
  const ids = new Set();
  for (const fixture of fixtures) {
    if (!fixture?.id || ids.has(fixture.id)) throw new Error(`Invalid or duplicate fixture id: ${fixture?.id || "<missing>"}`);
    ids.add(fixture.id);
    if (!fixture.input || typeof fixture.input !== "object") throw new Error(`${fixture.id}: missing input`);
    if (!Array.isArray(fixture.input.activity_sequence)) throw new Error(`${fixture.id}: activity_sequence must be an array`);
    if (!Array.isArray(fixture.expect?.must_include) || !Array.isArray(fixture.expect?.must_not_include)) {
      throw new Error(`${fixture.id}: expected must_include and must_not_include arrays`);
    }
    const serialized = JSON.stringify(fixture.input);
    if (/https?:\/\/|(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/)/i.test(serialized)) {
      throw new Error(`${fixture.id}: fixture contains a URL or local path`);
    }
  }
  return fixtures;
}

function outputText(output) {
  return [output?.title, output?.description, output?.summary, output?.prior_context, output?.important_context, output?.non_obvious]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function evaluateFixture(fixture, output) {
  const text = outputText(output);
  const checks = [];
  checks.push({ name: "status", pass: output?.status === "generated", detail: output?.status || "missing" });
  for (const field of ["title", "description", "summary", "prior_context", "important_context"]) {
    checks.push({ name: `field:${field}`, pass: typeof output?.[field] === "string" && output[field].trim().length > 0, detail: typeof output?.[field] });
  }
  for (const phrase of fixture.expect.must_include) {
    checks.push({ name: `include:${phrase}`, pass: text.includes(phrase), detail: "metadata evidence" });
  }
  for (const phrase of fixture.expect.must_not_include) {
    checks.push({ name: `exclude:${phrase}`, pass: !text.includes(phrase), detail: "privacy boundary" });
  }
  checks.push({ name: "no-url", pass: !/https?:\/\//i.test(text), detail: "generated text" });
  checks.push({ name: "no-local-path", pass: !/(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|\/private\/)/i.test(text), detail: "generated text" });
  checks.push({ name: "work-theme-title", pass: typeof output?.title === "string" && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(output.title.trim()) && !/^(?:Wei\s*[·:：-]\s*)?(?:VS Code|Chrome|WPS|Weixin|系统空闲)$/i.test(output.title.trim()), detail: output?.title || "missing" });
  const passed = checks.filter((check) => check.pass).length;
  return { id: fixture.id, status: output?.status || "missing", score: Number((passed / checks.length).toFixed(3)), passed, total: checks.length, checks };
}

async function main() {
  const fixturePath = path.resolve(argumentValue("--input", defaultFixturePath));
  const fixtures = validateFixtures(await readJson(fixturePath));
  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify({ mode: "dry-run", fixture_path: fixturePath, fixtures: fixtures.length, ids: fixtures.map((fixture) => fixture.id) }, null, 2));
    return;
  }

  let outputs;
  if (hasFlag("--live")) {
    const service = createAiService();
    outputs = [];
    for (const fixture of fixtures) {
      outputs.push({ id: fixture.id, output: await service.summarizeMemory(fixture.input) });
    }
    const outputPath = argumentValue("--output");
    if (outputPath) await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(outputs, null, 2)}\n`);
  } else {
    const outputPath = argumentValue("--outputs");
    if (!outputPath) throw new Error("Use --dry-run, --live, or provide --outputs <json>");
    outputs = await readJson(path.resolve(outputPath));
  }

  const outputMap = new Map((Array.isArray(outputs) ? outputs : []).map((item) => [item.id, item.output || item]));
  const results = fixtures.map((fixture) => evaluateFixture(fixture, outputMap.get(fixture.id)));
  const failed = results.filter((result) => result.checks.some((check) => !check.pass));
  const report = { mode: hasFlag("--live") ? "live" : "outputs", fixture_path: fixturePath, evaluated: results.length, passed: results.length - failed.length, failed: failed.length, results };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`AI evaluation failed: ${error.message}`);
  process.exitCode = 1;
});
