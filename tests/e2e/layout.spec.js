import { expect, test } from "./test.js";

import { ask } from "./helpers.js";

/**
 * Nothing pushes the column wider than the window.
 *
 * The transcript is a stack of flex columns, and a flex item will not shrink
 * below the width of its own content — so one run of characters with no
 * space in it sets the minimum width for everything above it. A hash, a
 * stack frame, a long URL: all ordinary in a chat, and all with no break
 * opportunity in them. Both the bubble you typed and the answer that came
 * back used to blow out on one, and at 320px the answer was more than five
 * times the width of the screen.
 *
 * Measured rather than eyeballed: the check is that no element is wider than
 * the box it is drawn in.
 */
const overflowing = (page) =>
  page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1)
      out.push(`the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
    for (const el of document.querySelectorAll("*")) {
      // A box that cannot scroll but holds something wider than itself.
      if (
        el.clientWidth > 0 &&
        el.scrollWidth > el.clientWidth + 1 &&
        getComputedStyle(el).overflowX === "visible"
      )
        out.push(
          `${el.tagName}.${String(el.className).split(/\s+/)[0]} holds ` +
            `${el.scrollWidth}px in ${el.clientWidth}px`
        );
    }
    return [...new Set(out)];
  });

test.describe("long unbroken text", () => {
  test.describe.configure({ timeout: 90_000 });

  test("does not widen the conversation at any size", async ({ page }) => {
    await page.goto("/new");

    // One from each direction: a word you typed, and an answer that came
    // back carrying an id and a URL with no spaces in them.
    await ask(page, "Supercalifragilistic" + "expialidocious".repeat(6));
    await ask(page, "Show me. UNBREAKABLE");

    for (const [width, height] of [
      [1280, 800],
      [768, 900],
      [390, 844],
      [320, 700],
    ]) {
      await page.setViewportSize({ width, height });
      // Let the reflow settle before measuring it.
      await page.waitForTimeout(300);
      expect(
        await overflowing(page),
        `at ${width}px wide`
      ).toEqual([]);
    }
  });

  test("a code block still scrolls rather than wrapping", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/new");
    await ask(page, "Explain it properly. HUGE");

    // The wrapping rule that fixes prose must not reach code: a wrapped line
    // changes what the code says, and the block is already a scroller.
    const block = page.locator(".answer pre").first();
    await expect(block).toBeVisible();
    expect(
      await block.evaluate((el) => ({
        wrap: getComputedStyle(el).overflowWrap,
        whiteSpace: getComputedStyle(el).whiteSpace,
        overflowX: getComputedStyle(el).overflowX,
      }))
    ).toEqual({ wrap: "normal", whiteSpace: "pre", overflowX: "auto" });
  });
});
