import { expect, test } from "./test.js";

import { ask, chatRow, sidebar, uniqueTitle } from "./helpers.js";

test.describe("history", () => {
  test("searches inside messages, not just titles", async ({ page }) => {
    await page.goto('/new');
    await ask(page, "A question about hydroponics.");

    await page.locator('input[placeholder="Search chats"]').first().fill("short answer");
    // The match is in the *answer*, so a title-only search would find nothing.
    const result = sidebar(page).locator('[role="button"][aria-label]').first();
    await expect(result).toBeVisible();
    await expect(result).toContainText("Short answer", { ignoreCase: true });
  });

  test("pins a chat into its own section", async ({ page }) => {
    await page.goto('/new');
    const title = uniqueTitle("Worth keeping around.");
    await ask(page, title);

    const row = chatRow(page, title);
    await row.hover();
    await row.getByRole("button", { name: "More" }).click();
    await page.getByRole("menu").getByText("Pin", { exact: true }).click();

    await expect(sidebar(page).getByText("Pinned", { exact: true })).toBeVisible();
  });

  test("a private chat is never written down", async ({ page }) => {
    await page.goto('/new');
    // Count only once the history has actually arrived — the list is
    // fetched, so counting on first paint counts zero and passes for the
    // wrong reason.
    const rows = sidebar(page).locator('[role="button"][aria-label]');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();

    await page.getByRole("button", { name: "Private chat" }).first().click();
    await expect(page.getByText("not saved anywhere")).toBeVisible();

    const composer = page.locator("textarea").first();
    await composer.fill("Something I would rather not keep.");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Short answer.")).toBeVisible({ timeout: 15_000 });

    // No new row, and nothing to come back to.
    expect(await rows.count()).toBe(before);
    await page.reload();
    await expect(page.getByText("Something I would rather not keep.")).toHaveCount(0);
  });
});
