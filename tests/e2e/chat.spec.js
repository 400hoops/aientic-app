import { expect, test } from "./test.js";

import { ask, sidebar, uniqueTitle } from "./helpers.js";

test.describe("a conversation", () => {
  test("signs in, answers, and keeps the chat in the sidebar", async ({ page }) => {
    await page.goto('/new');

    const title = uniqueTitle("What does this do?");
    await ask(page, title);
    await expect(page.getByText("Short answer.")).toBeVisible();

    // The chat is named after the question and shows up under Today.
    await expect(sidebar(page).getByText("Today", { exact: true })).toBeVisible();
    await expect(
      sidebar(page).locator(`[role="button"][aria-label="${title}"]`)
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

  /**
   * Your own message, acted on after it lands.
   *
   * The composer draws a turn immediately rather than waiting for the round
   * trip, and that local echo used to keep its placeholder id for the life
   * of the conversation on screen. Deleting or editing your own message
   * therefore addressed /messages/local, came back 404, and did nothing —
   * with the buttons right there, enabled, doing nothing at all.
   */
  test("your own message can be deleted once it has landed", async ({ page }) => {
    await page.goto("/new");
    await ask(page, uniqueTitle("Delete me"));

    const ids = () =>
      page.locator("[data-message-id]").evaluateAll((els) =>
        els.map((el) => el.dataset.messageId)
      );
    // No placeholder survives the stream: every message is addressable.
    expect(await ids()).not.toContain("local");

    const question = page.locator("[data-message-id]").first();
    await question.hover();
    await question.getByRole("button", { name: "Delete" }).click();

    // The question and the answer under it both go.
    await expect(page.locator("[data-message-id]")).toHaveCount(0);
  });
});

test.describe("private chats", () => {
  /**
   * The way out.
   *
   * The header toggle was hidden as soon as a conversation existed — and a
   * private chat is a conversation from the moment it opens, so the button
   * vanished on the way in and the only exit was the sidebar. Its own
   * "Leave the private chat" title was unreachable.
   */
  test("the header toggle gets you out again", async ({ page }) => {
    await page.goto("/new");
    const toggle = page.getByRole("button", { name: "Private chat" });
    await toggle.click();
    await expect(page).toHaveURL(/\/private/);

    await ask(page, "Said in private");
    // Still offered while the private chat is in progress.
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page).not.toHaveURL(/\/private/);
    // And the transcript does not follow you out.
    await expect(page.getByText("Said in private")).toHaveCount(0);
  });

  /**
   * Deleting the message you actually pointed at.
   *
   * A private chat is never written down, so its turns keep the placeholder
   * id the composer drew them with — and that id used to be one shared
   * constant. Every question in the conversation answered to the same name,
   * and the delete looks up the first match, so removing the second question
   * removed the first one instead.
   */
  test("deleting one message in a private chat removes that one", async ({ page }) => {
    await page.goto("/new");
    await page.getByRole("button", { name: "Private chat" }).click();
    await expect(page).toHaveURL(/\/private/);

    await ask(page, "First private question");
    await ask(page, "Second private question");
    await expect(page.locator("[data-message-id]")).toHaveCount(4);

    // Delete the second question. Its own answer goes with it; the first
    // exchange must be untouched.
    const second = page.locator("[data-message-id]").nth(2);
    await second.hover();
    await second.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("First private question")).toBeVisible();
    await expect(page.getByText("Second private question")).toHaveCount(0);
  });
});

test.describe("the queue", () => {
  // Draining the queue is three turns end to end, and the wait for it is
  // itself 30s — the same as the default budget for the whole test, so the
  // test could never actually spend that allowance: it died as a bare
  // "test timeout" instead of a legible assertion failure.
  test.describe.configure({ timeout: 90_000 });

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
