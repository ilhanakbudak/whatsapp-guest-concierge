/**
 * Boots the compiled output and exercises a couple of endpoints.
 *
 * This exists because the test suite runs through vitest's transpiler, which is
 * more forgiving about CommonJS interop than real ESM is. A named import from a
 * CJS dependency can pass every test and still crash on boot in production, so
 * CI runs the actual artifact.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PORT = process.env.SMOKE_PORT ?? "4321";
const BASE = `http://127.0.0.1:${PORT}`;
// Its own file inside data/, and only this file is removed afterwards —
// deleting the whole directory would destroy a developer's local database.
const DB = "./data/smoke-ci.db";

const server = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, PORT, DEMO_MODE: "true", DATABASE_PATH: DB, LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (d) => (output += d));
server.stderr.on("data", (d) => (output += d));

const cleanup = async () => {
  server.kill("SIGTERM");
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(`${DB}${suffix}`, { force: true });
  }
};

const fail = async (message) => {
  console.error(`smoke: ${message}`);
  if (output.trim()) console.error(`--- server output ---\n${output}`);
  await cleanup();
  process.exit(1);
};

// Boot can take a moment; poll rather than guessing a sleep duration.
let ready = null;
for (let attempt = 0; attempt < 50; attempt++) {
  if (server.exitCode !== null) await fail(`server exited early with code ${server.exitCode}`);
  try {
    const res = await fetch(`${BASE}/health/ready`);
    if (res.ok) {
      ready = await res.json();
      break;
    }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 200));
}

if (!ready) await fail("server never became ready");
if (ready.status !== "ok") await fail(`unexpected readiness payload: ${JSON.stringify(ready)}`);

// An unsigned Twilio webhook must be rejected. If this ever returns 200, the
// bot is open to anyone who finds the URL.
const unsigned = await fetch(`${BASE}/webhooks/twilio/inbound`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ From: "whatsapp:+447700900123", Body: "hi", MessageSid: "SM1" }),
});

if (unsigned.status !== 403) {
  await fail(`unsigned webhook returned ${unsigned.status}, expected 403`);
}

console.log(`smoke: ok (provider=${ready.llm.provider}, model=${ready.llm.model})`);
await cleanup();
process.exit(0);
