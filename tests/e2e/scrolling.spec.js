import { expect, test } from "./test.js";

import { ask, padTranscript, scrollState, transcript } from "./helpers.js";

/**
 * How the view behaves while an answer arrives.
 *
 * This is the part of the app people feel rather than see, and the part that
 * has broken twice: once when the auto-follow fought every attempt to scroll
 * away mid-stream, and once when the pin-to-top re-aligned on every token.
 * Both were invisible to every other test in this suite, because nothing else
 * looks at where the viewport is.
 *
 * The rule underneath all of it: the app drives the scroll only while the
 * reader hasn't taken over, and any deliberate gesture hands control back.
 *
 * A window short enough that a handful of turns overflows it — the behaviour
 * only exists on a scroller with somewhere to go.
 */
test.use({ viewport: { width: 1000, height: 700 } });

test.describe("following an answer", () => {
  test("a new answer is followed as it streams", async ({ page }) => {
    await page.goto("/new");
    await padTranscript(page);

    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("Give me the LONG one");
    await page.keyboard.press("Enter");

    // Mid-stream, twice: the transcript is growing and the view is staying
    // with its end rather than being left behind by it.
    await page.waitForTimeout(150);
    const early = await scrollState(page);
    expect(early.gap).toBeLessThan(24);

    // Not by total height: the spacer that pins a question to the top gives
    // back exactly as much room as the answer takes, so scrollHeight barely
    // moves while a reply streams. The answer itself is the thing growing.
    const lengthOfAnswer = () =>
      page.locator("[data-message-id]").last().evaluate((el) => el.textContent.length);
    const grewFrom = await lengthOfAnswer();

    await page.waitForTimeout(400);
    const later = await scrollState(page);
    expect(await lengthOfAnswer()).toBeGreaterThan(grewFrom);
    expect(later.gap).toBeLessThan(24);

    await expect(page.getByRole("button", { name: "Regenerate" }).last()).toBeVisible({
      timeout: 20_000,
    });
    expect((await scrollState(page)).gap).toBeLessThan(24);
  });

  test("scrolling up mid-stream is not undone, and coming back resumes", async ({
    page,
  }) => {
    await page.goto("/new");
    await padTranscript(page);

    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("Give me the LONG one");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    // A wheel gesture is what a person does; it's also what the code listens
    // for to decide the reader has taken over.
    await transcript(page).hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);

    const movedAway = await scrollState(page);
    expect(movedAway.gap, "the wheel actually moved the view").toBeGreaterThan(100);

    // The answer keeps arriving. The view must stay where it was put — this
    // is the regression that made reading back during a reply impossible.
    await page.waitForTimeout(700);
    const held = await scrollState(page);
    expect(Math.abs(held.top - movedAway.top)).toBeLessThan(10);

    // Returning to the end opts back in, for the rest of the same answer.
    await transcript(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.getByRole("button", { name: "Regenerate" }).last()).toBeVisible({
      timeout: 20_000,
    });
    expect((await scrollState(page)).gap).toBeLessThan(24);
  });

  test("a growing answer never jumps the view backward", async ({ page }) => {
    await page.goto("/new");
    await padTranscript(page);

    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("Give me the LONG one");
    await page.keyboard.press("Enter");

    // Sampled through the stream. Following the end of a growing transcript
    // means scrollTop only ever climbs; a backward step is the view being
    // thrown somewhere, which is what layout-jumping looks like from here.
    const tops = [];
    for (let i = 0; i < 8; i++) {
      tops.push((await scrollState(page)).top);
      await page.waitForTimeout(120);
    }
    await expect(page.getByRole("button", { name: "Regenerate" }).last()).toBeVisible({
      timeout: 20_000,
    });

    // Slack, because the spacer that pins a question to the top is measured
    // off live boxes and gives back a few pixels as it settles. What this is
    // looking for is the view being thrown — that moves it by hundreds.
    const backward = tops.filter((top, i) => i > 0 && top < tops[i - 1] - 24);
    expect(backward, `scrollTop went backward: ${tops.join(", ")}`).toEqual([]);
  });

  test("content that renders after the text does not throw the view", async ({
    page,
  }) => {
    await page.goto("/new");
    await padTranscript(page);

    // An artifact is the case in this app: the answer streams as a fenced
    // block and then becomes a card of a different height once the message
    // is parsed, changing the transcript's height under the viewport.
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("Draft me a page. ARTIFACT");
    await page.keyboard.press("Enter");

    await page.waitForTimeout(200);
    expect((await scrollState(page)).gap).toBeLessThan(24);

    await expect(page.getByRole("button", { name: /Kettle timer/ })).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(400); // the card has taken its final height
    expect((await scrollState(page)).gap).toBeLessThan(24);
  });
});

test.describe("coming back to a conversation", () => {
  test("a refresh returns to where you were reading", async ({ page }) => {
    await page.goto("/new");
    await ask(page, "Somewhere to come back to");
    await padTranscript(page, 9);

    // Deliberately away from the end: the end is the default, so restoring to
    // it would prove nothing.
    //
    // By wheel, not by assigning scrollTop. Only a real gesture counts as the
    // reader taking over — a programmatic scroll leaves the auto-follow on,
    // and it pulls the view straight back to the end, correctly.
    await transcript(page).hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    const before = await scrollState(page);
    expect(before.gap).toBeGreaterThan(300);

    await page.reload();
    await page.waitForSelector("textarea");
    // The position is re-applied for a beat while the page reaches its final
    // height, so this waits past that rather than racing it.
    await page.waitForTimeout(1200);

    const after = await scrollState(page);
    expect(
      Math.abs(after.top - before.top),
      `came back to ${after.top}, was at ${before.top}`
    ).toBeLessThan(60);
  });

  test("a conversation with no remembered position opens at its end", async ({
    page,
  }) => {
    await page.goto("/new");
    await ask(page, "Opened fresh, should land at the end");
    await padTranscript(page);

    // Left at the end, so nothing is remembered — the end is where a chat
    // should open, and the restore must not fight that.
    await transcript(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(300);

    await page.reload();
    await page.waitForSelector("textarea");
    await page.waitForTimeout(1200);
    expect((await scrollState(page)).gap).toBeLessThan(24);
  });
});
