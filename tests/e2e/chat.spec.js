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

test.describe("the queue", () => {
  test("messages typed mid-answer are queued and sent in order", async ({ page }) => {
    await page.goto("/new");
    const composer = page.locator("textarea").first();

    // A long answer, so there's time to type behind it.
    await composer.click();
    await composer.fill("Give me the LONG one");
    await page.keyboard.press("Enter");

    await expect(composer).toHaveAttribute("placeholder", /Queue/i);
    await composer.fill("second question");
    await page.keyboard.press("Enter");
    await composer.fill("third question");
    await page.keyboard.press("Enter");
    // One chip per waiting message. Counted by their remove buttons rather
    // than by the word "Queued", which is one shared label beside them.
    const queued = page.getByRole("button", { name: "Remove from the queue" });
    await expect(queued).toHaveCount(2);

    // Both drain, in the order they were typed, once the answer lands.
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    const turns = await page.locator("[data-message-id]").allTextContents();
    const asked = turns.filter((t) => /question|LONG/.test(t));
    expect(asked[0]).toContain("LONG");
    expect(asked[1]).toContain("second");
    expect(asked[2]).toContain("third");
  });

  test("stopping hands the queue back to the composer", async ({ page }) => {
    await page.goto("/new");
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("Give me the LONG one");
    await page.keyboard.press("Enter");

    await composer.fill("this should come back");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Queued")).toHaveCount(1);

    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(page.getByText("Queued")).toHaveCount(0);
    await expect(composer).toHaveValue(/this should come back/);
  });
});
