import fs from "node:fs";
import path from "node:path";

import { test as setup } from "./test.js";

import { ADMIN, AUTH_FILE, signIn } from "./helpers.js";

/**
 * Sign in once per run and keep the session for every other spec.
 *
 * This is also the test of the login form itself — if it stops working,
 * nothing downstream even starts.
 */
setup("sign in", async ({ page }) => {
  await signIn(page, ADMIN);
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
