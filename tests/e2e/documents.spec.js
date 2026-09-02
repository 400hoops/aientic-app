import { expect, test } from "./test.js";

const STUB_PORT = Number(process.env.AIENTIC_E2E_STUB_PORT || 4188);



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

test.describe("reading a link", () => {
  test("a pasted URL is fetched, attached and answered", async ({ page }) => {
    await page.goto("/new");

    const composer = page.locator("textarea").first();
    await composer.click();
    // The stub serves a page on the same host, so the suite reads a real
    // page over a real HTTP request without leaving the machine.
    await page.evaluate((url) => {
      const data = new DataTransfer();
      data.setData("text/plain", url);
      document.querySelector("textarea").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      );
    }, `http://127.0.0.1:${STUB_PORT}/article`);

    // The chip names the page, not the URL — proof the page was parsed.
    await expect(page.getByText("The kettle question").first()).toBeVisible({
      timeout: 15_000,
    });

    await composer.fill("What's this about?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("The piece is about kettles.")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a link inside a sentence is left alone", async ({ page }) => {
    await page.goto("/new");
    const composer = page.locator("textarea").first();
    await composer.click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "have a look at https://example.com when you can");
      document.querySelector("textarea").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      );
    });
    await expect(page.getByText("Reading…")).toHaveCount(0);
  });
});
