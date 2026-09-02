import { expect, test } from "./test.js";

import { ask, sidebar } from "./helpers.js";

/**
 * An artifact is a whole thing the model produced, shown as a card and opened
 * in its own panel instead of being dumped into the transcript.
 *
 * The security assertion is the one that matters most here: the preview runs
 * model-written HTML, so the frame must be sandboxed *without*
 * allow-same-origin. With that token the frame shares this app's origin and
 * could read the session cookie and call the API as the signed-in user, so a
 * regression there is not a cosmetic one.
 */
test.describe("artifacts", () => {
  test("a page comes back as a card, opens in a sandboxed panel, and is listed", async ({
    page,
  }) => {
    await page.goto("/new");
    await ask(page, "Write me a page. ARTIFACT");

    // The card, not two hundred lines of markup.
    const card = page.getByRole("button", { name: /Kettle timer/ });
    await expect(card).toBeVisible();
    await expect(page.getByText("<!doctype html>")).toHaveCount(0);

    await card.click();
    const panel = page.locator("aside").last();
    await expect(panel.getByText("Kettle timer").first()).toBeVisible();

    const frame = panel.locator("iframe");
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    // And the page really did render inside it.
    await expect(frame.contentFrame().getByRole("heading", { name: "Kettle timer" }))
      .toBeVisible();

    // Code tab shows the source.
    await panel.getByRole("button", { name: "Code" }).click();
    await expect(panel.getByText("<!doctype html>")).toBeVisible();

    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel.locator("iframe")).toHaveCount(0);

    // And it's in the list, which is derived from the conversations rather
    // than stored, so it can't disagree with the answer it came from.
    const listed = await page.request.get("/api/artifacts");
    expect(listed.ok()).toBeTruthy();
    const { artifacts } = await listed.json();
    expect(artifacts.some((a) => a.title === "Kettle timer" && a.kind === "html")).toBe(
      true
    );

    // The sidebar entry opens the same list.
    await sidebar(page).getByRole("button", { name: "Artifacts" }).click();
    const dialog = page.getByRole("dialog", { name: "Artifacts" });
    await expect(dialog.getByText("Kettle timer").first()).toBeVisible();
  });
});
