import { expect, test } from "./test.js";



/** A few hundred words, the way an article arrives on the clipboard. */
const ARTICLE = Array.from(
  { length: 12 },
  (_, i) => `Section ${i + 1}. ` + "A sentence from the article. ".repeat(10)
).join("\n\n");

test.describe("reading a pasted article", () => {
  test("a long paste becomes an attachment, not composer contents", async ({ page }) => {
    await page.goto('/new');

    const composer = page.locator("textarea").first();
    await composer.click();
    await page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      document.querySelector("textarea").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      );
    }, ARTICLE);

    // The composer stays empty and usable; the article is a named chip.
    await expect(composer).toHaveValue("");
    await expect(page.getByText(/words$/).first()).toBeVisible();

    await composer.fill("Summarise this.");
    await page.keyboard.press("Enter");

    // The stub answers differently when it was handed a document, which is
    // how we know the article actually reached the model.
    await expect(page.getByText("I read the document.")).toBeVisible({ timeout: 15_000 });
  });

  test("a short paste is still just typing", async ({ page }) => {
    await page.goto('/new');
    const composer = page.locator("textarea").first();
    await composer.click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "one short pasted line");
      document.querySelector("textarea").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      );
    });
    // Not intercepted: the browser's own paste puts it in the box.
    await expect(page.getByText(/words$/)).toHaveCount(0);
  });
});
