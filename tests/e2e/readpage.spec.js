import { expect, test } from "@playwright/test";

import {
  extractArticle,
  isPrivateAddress,
  normaliseUrl,
  pageTitle,
  readUrl,
} from "../../server/readpage.js";

/**
 * The link reader's rules, checked in Node rather than a browser.
 *
 * These are the assertions that matter most in the whole suite: this is the
 * one feature that makes the server fetch a URL somebody typed, and the app
 * usually runs on a home network full of things that answer without asking
 * who's calling.
 */
test.describe("what the link reader refuses", () => {
  test("every private range is private", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);

    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  test("IPv6 loopback, link-local and unique-local are private", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  test("only http(s) survives normalising", () => {
    expect(String(normaliseUrl("example.com/x"))).toBe("https://example.com/x");
    expect(normaliseUrl("javascript:alert(1)")).toBe(null);
    expect(normaliseUrl("file:///etc/passwd")).toBe(null);
    expect(normaliseUrl("  ")).toBe(null);
  });

  test("a link into this network is refused", async () => {
    // The flag the test rig sets is not set in this process.
    await expect(readUrl("http://127.0.0.1:9/secret")).rejects.toThrow(
      /inside this network/
    );
    await expect(readUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /inside this network/
    );
  });
});

test.describe("what it makes of a page", () => {
  const page = `<html><head><title>Kettles — The Daily</title></head><body>
    <nav>Home About</nav><header>The Daily</header>
    <article><h1>Kettles</h1><p>First paragraph about kettles.</p>
    <p>Second paragraph, with &amp; entities &mdash; and dashes.</p>
    <ul><li>One</li><li>Two</li></ul></article>
    <footer>&copy; 2026</footer><script>var tracking = 1;</script></body></html>`;

  test("keeps the article and drops the furniture", () => {
    const text = extractArticle(page);
    expect(text).toContain("First paragraph about kettles.");
    expect(text).toContain("& entities — and dashes.");
    expect(text).toContain("- One");
    // Navigation, footer and scripts are not the article.
    expect(text).not.toContain("About");
    expect(text).not.toContain("2026");
    expect(text).not.toContain("tracking");
    // Paragraphs stay paragraphs, so the model can quote one back.
    expect(text.split("\n\n").length).toBeGreaterThan(2);
  });

  test("takes the page's own title", () => {
    expect(pageTitle(page, new URL("https://daily.test/kettles"))).toBe(
      "Kettles — The Daily"
    );
  });
});
