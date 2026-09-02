import { expect, test } from "./test.js";

import { sidebar } from "./helpers.js";

/**
 * Typing a slash opens the skill list, filtered as you keep typing.
 *
 * The interesting part is the keyboard: while the menu is up, Enter picks a
 * skill instead of sending the message, and it has to go back to sending the
 * moment the menu closes.
 */
test.describe("the slash menu", () => {
  test("picks a skill by typing, and Enter attaches instead of sending", async ({
    page,
  }) => {
    await page.goto("/new");
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    for (const skill of [
      { name: "Weekly status", description: "Wins, blockers, next steps", instructions: "Be brief." },
      { name: "Proofread", description: "Fix the grammar", instructions: "Correct it." },
    ])
      expect(
        (await page.request.post("/api/skills", { headers: { cookie }, data: skill })).ok()
      ).toBeTruthy();

    await page.reload();
    const composer = page.locator("textarea").first();
    await composer.click();

    // A slash on its own lists everything.
    await composer.pressSequentially("/");
    const menu = page.getByRole("listbox", { name: "Skills" });
    await expect(menu.getByRole("option")).toHaveCount(2);

    // Typing filters it.
    await composer.pressSequentially("proof");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu.getByText("Proofread")).toBeVisible();

    // Enter picks rather than sends: the skill is attached, the slash text
    // is gone, and no message was sent.
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: /Detach Proofread/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);

    // And Enter sends again now the menu is closed.
    await composer.fill("Hello there");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Regenerate" }).last()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a slash in the middle of a sentence is just a slash", async ({ page }) => {
    await page.goto("/new");
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.pressSequentially("what is 3/4 of");
    await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);

    // Escape closes it and it stays closed while the same text stands.
    await composer.fill("");
    await composer.pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
    await composer.pressSequentially("p");
    await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
  });
});
