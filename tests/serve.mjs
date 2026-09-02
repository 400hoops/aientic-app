/**
 * The whole app, wired to a fake model server, for the end-to-end tests.
 *
 * Playwright's webServer runs this: a stub upstream on one port, the real
 * Aientic server on another, and a data directory under the OS temp dir that
 * is wiped on every run. Nothing here touches a developer's own data.json,
 * and the tests get an app that answers in milliseconds.
 *
 * The account and the model endpoint are seeded through the API rather than
 * through the UI, so a failure in, say, the login form can't take every
 * other test down with it. Signing in is its own test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startStubModel } from "./stub-model.mjs";

export const APP_PORT = Number(process.env.AIENTIC_E2E_PORT || 4187);
export const STUB_PORT = Number(process.env.AIENTIC_E2E_STUB_PORT || 4188);
export const ADMIN = { username: "e2e-admin", password: "e2e-password" };

const dataDir = path.join(os.tmpdir(), "aientic-e2e-data");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

process.env.AIENTIC_DATA_DIR = dataDir;
process.env.AIENTIC_PORT = String(APP_PORT);
// The page the link-reading test reads is served by the stub, on loopback —
// which the reader refuses by default, correctly. The rig opts in; the
// refusal itself is covered in tests/e2e/readpage.spec.js, which runs in
// this file's *other* process, where the flag is not set.
process.env.AIENTIC_ALLOW_PRIVATE_FETCH = "1";

await startStubModel(STUB_PORT);
await import("../server/index.js");

const api = async (route, body, cookie) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return res;
};

// Wait for the listener, then seed.
await new Promise((r) => setTimeout(r, 300));
const setup = await api("/auth/setup", ADMIN);
const cookie = setup.headers.get("set-cookie")?.split(";")[0];
await api(
  "/admin/endpoints",
  {
    label: "Stub",
    note: "A fake model that answers instantly",
    baseUrl: `http://127.0.0.1:${STUB_PORT}`,
    modelParam: "stub-model",
    vision: true,
  },
  cookie
);

console.log(`[e2e] ready on http://127.0.0.1:${APP_PORT} (data: ${dataDir})`);
