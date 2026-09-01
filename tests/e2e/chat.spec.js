import { expect, test } from "./test.js";

import { ask, sidebar } from "./helpers.js";

test.describe("a conversation", () => {
  test("signs in, answers, and keeps the chat in the sidebar", async ({ page }) => {
    await page.goto('/new');

    await ask(page, "What does this do?");
    await expect(page.getByText("Short answer.")).toBeVisible();

    // The chat is named after the question and shows up under Today.
    await expect(sidebar(page).getByText("Today", { exact: true })).toBeVisible();
    await expect(
      sidebar(page).locator('[role="button"][aria-label="What does this do?"]')
    ).toBeVisible();

    // The answer says which model produced it.
    await expect(page.locator(".ui-label", { hasText: "Stub" }).first()).toBeVisible();
  });

  test("the question rises to the top of the screen when sent", async ({ page }) => {
    await page.goto('/new');
    await ask(page, "Where does this land?");

    const offset = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll("[data-message-id]")];
      const question = bubbles.find((b) => b.textContent.includes("Where does this land?"));
      const scroller = question.closest(".overflow-y-scroll");
      return Math.round(
        question.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      );
    });
    // Pinned just under the top edge, not left wherever the transcript ended.
    expect(offset).toBeLessThan(60);
    expect(offset).toBeGreaterThan(0);
  });

  test("a failed turn explains itself and can be retried", async ({ page }) => {
    await page.goto('/new');
    await ask(page, "This one will break next.");

    let broken = true;
    await page.route("**/api/conversations/*/stream", (route) =>
      broken
        ? route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: "The model server is not answering." }),
          })
        : route.continue()
    );

    await page.getByRole("button", { name: "Regenerate" }).last().click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The model server is not answering.");

    broken = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Short answer.").first()).toBeVisible();
  });
});
