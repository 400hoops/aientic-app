import { expect, test } from "./test.js";

import { ADMIN, sidebar, signIn } from "./helpers.js";

const NORMAL = { username: "e2e-user", password: "e2e-password" };

test.describe("admin is admin-only", () => {
  test("a normal account can't reach admin or the sampler", async ({
    page,
    browser,
  }) => {
    // The admin half, on the shared session.
    await page.goto("/new");
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await page.request.post("/api/admin/users", {
      headers: { cookie },
      data: { ...NORMAL, role: "user" },
    });

    // The normal-account half, in a context of its own with no cookies in
    // it. It used to sign the shared session *out* and back in as the other
    // account — which worked for this spec and broke every spec that ran
    // after it, because signing out invalidates the token server-side and
    // the saved storage state still carries it. A second context costs one
    // extra sign-in and leaves the shared one alone.
    const context = await browser.newContext({ storageState: undefined });
    const theirPage = await context.newPage();
    await signIn(theirPage, NORMAL);

    // Typing the URL lands back on the chat.
    await theirPage.goto("/admin");
    await expect(theirPage).toHaveURL(/\/(new|chat\/)/);

    // And the account menu doesn't offer it.
    await sidebar(theirPage)
      .getByRole("button", { name: new RegExp(NORMAL.username, "i") })
      .click();
    const menu = theirPage.getByRole("menu");
    await expect(menu.getByText("Settings", { exact: true })).toBeVisible();
    await expect(menu.getByText("Admin", { exact: true })).toHaveCount(0);

    // Nor does the server, whatever the browser thinks. theirPage.request,
    // not the bare request fixture: this has to ask *as the signed-in user*,
    // so that a 403 means "you aren't an admin" rather than "who are you".
    const refused = await theirPage.request.get("/api/admin/endpoints");
    expect(refused.status()).toBe(403);

    await context.close();

    // The shared session is still the admin's, for whatever runs next.
    await expect(
      sidebar(page).getByRole("button", { name: new RegExp(ADMIN.username, "i") })
    ).toBeVisible();
  });
});
