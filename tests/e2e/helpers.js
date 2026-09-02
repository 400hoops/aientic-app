import { expect } from "@playwright/test";

export const ADMIN = { username: "e2e-admin", password: "e2e-password" };
export const AUTH_FILE = "tests/.auth/admin.json";

/**
 * Sign in through the form.
 *
 * Most specs don't call this: they start already signed in, from the state
 * auth.setup.js saves. Signing in on every spec would be nine logins a run,
 * and the server rate-limits ten in five minutes — the suite would start
 * failing on its own success.
 */
export async function signIn(page, who = ADMIN) {
  await page.goto("/");
  const fields = page.locator("input");
  await fields.nth(0).fill(who.username);
  await fields.nth(1).fill(who.password);
  await page.keyboard.press("Enter");
  await expect(sidebar(page).getByRole("button", { name: "New chat" })).toBeVisible();
}

/**
 * The desktop sidebar.
 *
 * There are two in the DOM — the docked column and the phone drawer, both
 * always mounted so the drawer has something to animate from — so every
 * sidebar query has to say which one it means.
 */
export const sidebar = (page) => page.locator("aside").first();

/** Send a turn and wait for the answer to finish streaming. */
export async function ask(page, text) {
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Regenerate" }).last()).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * A title no earlier run can have used.
 *
 * The e2e data directory persists between runs, so "Worth keeping around."
 * is three chats by the third run — and a spec that grabs the first row
 * matching its title gets one from a previous run, in whatever state that
 * run left it. Pinning one that is already pinned offers "Unpin", and the
 * spec waits thirty seconds for a menu item that isn't there.
 */
export const uniqueTitle = (what) => `${what} #${Date.now().toString(36)}`;

/** The sidebar row for a chat, by its title. */
export const chatRow = (page, title) =>
  sidebar(page).locator(`[role="button"][aria-label="${title}"]`).first();
