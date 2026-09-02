import { expect, test } from "./test.js";

import { ADMIN, sidebar } from "./helpers.js";

/**
 * The panel is one long page of text boxes, and text boxes are exactly what
 * a re-render breaks: when a section is declared inside the dialog's own
 * render body it becomes a new component type every keystroke, React rebuilds
 * the subtree, and the input you were typing into is destroyed after one
 * letter. It's invisible in a unit test and obvious in a browser, so it's
 * tested here.
 */
test.describe("settings", () => {
  test("a text box keeps focus while you type a whole word", async ({ page }) => {
    await page.goto("/new");
    await sidebar(page)
      .getByRole("button", { name: new RegExp(ADMIN.username, "i") })
      .click();
    await page.getByRole("menu").getByText("Settings", { exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // A memory line: an empty box that isn't the account form, so nothing is
    // saved by typing into it.
    const box = dialog.getByPlaceholder(/dog's name is Beans/i);
    await box.click();
    // pressSequentially, not fill: fill sets the value in one shot and would
    // pass even with the bug. This types letter by letter, the way a person
    // does, so losing focus loses the rest of the word.
    await box.pressSequentially("Remember the milk", { delay: 20 });
    await expect(box).toHaveValue("Remember the milk");
    await expect(box).toBeFocused();
  });
});
