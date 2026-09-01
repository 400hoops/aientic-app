import { expect, test } from "./test.js";

import { ADMIN, sidebar, signIn } from "./helpers.js";

const NORMAL = { username: "e2e-user", password: "e2e-password" };

test.describe("admin is admin-only", () => {
  test("a normal account can't reach admin or the sampler", async ({ page, request }) => {
    // Signs out halfway through, so it works on its own copy of the session
    // rather than the shared one every other spec is using.
    await page.goto("/new");
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await request.post("/api/admin/users", {
      headers: { cookie },
      data: { ...NORMAL, role: "user" },
    });

    await sidebar(page).getByRole("button", { name: new RegExp(ADMIN.username) }).click();
    await page.getByRole("menu").getByText("Sign out", { exact: true }).click();

    await signIn(page, NORMAL);

    // Typing the URL lands back on the chat.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/(new|chat\/)/);

    // And the account menu doesn't offer it.
    await sidebar(page).getByRole("button", { name: new RegExp(NORMAL.username) }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByText("Settings", { exact: true })).toBeVisible();
    await expect(menu.getByText("Admin", { exact: true })).toHaveCount(0);

    // Nor does the server, whatever the browser thinks. page.request, not
    // the bare request fixture: this has to ask *as the signed-in user*, so
    // that a 403 means "you aren't an admin" rather than "who are you".
    const refused = await page.request.get("/api/admin/endpoints");
    expect(refused.status()).toBe(403);
  });
});
