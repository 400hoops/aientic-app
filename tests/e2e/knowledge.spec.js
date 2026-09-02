import { expect, test } from "./test.js";

import { ask } from "./helpers.js";

/**
 * Retrieval, end to end: put a document in the library, ask a question whose
 * answer is only in that document, and check the passage reached the model.
 *
 * The stub upstream answers with what it was given, so "the model saw it" is
 * an assertion rather than an impression.
 */
const HANDBOOK = [
  "Descaling the office kettle",
  "",
  "The descaling procedure runs every ninety days, on the first Monday.",
  "",
  "Use citric acid. Never use vinegar: it leaves a smell in the element that takes weeks to clear, and it voids the warranty.",
  "",
  "The spare filter lives in the second drawer, behind the teabags.",
].join("\n");

test.describe("knowledge", () => {
  test("a question is answered from a document in the library", async ({ page, request }) => {
    await page.goto("/new");

    // Put the handbook in the library through the API — the UI for it is
    // Settings, which has its own coverage.
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const added = await request.post("/api/knowledge", {
      headers: { cookie },
      data: { title: "Kettle handbook", text: HANDBOOK },
    });
    expect(added.ok()).toBeTruthy();

    await page.reload();

    // Retrieval is off until asked for, so the button has to be pressed.
    const library = page.locator('button[title*="documents"]').first();
    await expect(library).toBeVisible();
    await library.click();

    await ask(page, "which acid should I use to descale it?");

    // The stub echoes what it was handed: a passage means retrieval ran.
    await expect(page.getByText(/citric acid/i).first()).toBeVisible();
    // And the answer names where it came from.
    await expect(page.getByText("Sources")).toBeVisible();
    await expect(page.getByText("Kettle handbook").first()).toBeVisible();
  });

  test("what a question retrieves can be inspected without a model", async ({
    page,
    request,
  }) => {
    await page.goto("/new");
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const hits = await request.get("/api/knowledge/search?q=where is the spare filter", {
      headers: { cookie },
    });
    const { results } = await hits.json();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("second drawer");

    // A question about nothing in the library retrieves nothing, rather
    // than the least-bad passage.
    const empty = await request.get("/api/knowledge/search?q=aviation licensing", {
      headers: { cookie },
    });
    expect((await empty.json()).results).toHaveLength(0);
  });
});
