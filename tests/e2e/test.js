import { test as base, expect } from "@playwright/test";

/**
 * The test fixture every spec uses.
 *
 * It cuts the browser off from the internet: the app pulls its webfonts from
 * Google, and on a machine that can't reach them (CI without egress, a
 * laptop on a plane) those requests hang long enough to hold up
 * DOMContentLoaded — so a navigation times out and a test fails for a reason
 * that has nothing to do with the app. Aborting them outright also keeps the
 * suite honest: nothing it asserts on can depend on a third party being up.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      return local ? route.continue() : route.abort();
    });
    await use(page);
  },
});

export { expect };
