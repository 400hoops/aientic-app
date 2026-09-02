import { readFileSync } from "node:fs";

import { expect, test } from "./test.js";

import { convertMemories, parseUpload } from "../../server/claudeImport.js";

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

/**
 * Reading a Claude data export, which arrives as several numbered zips.
 *
 * Node-level: this is all parsing, and the interesting cases are what a real
 * export contains rather than what a browser does with the result.
 */
test.describe("the Claude export", () => {
  test("keeps what was said and drops the machinery around it", () => {
    const { conversations } = parseUpload(fixture("conversations000.zip"), "u1");
    expect(conversations).toHaveLength(2);

    const chat = conversations.find((c) => c.title === "Dog named Hazel");
    const answer = chat.messages[1];
    expect(answer.role).toBe("assistant");
    // The reply itself, and only the reply: a memory tool call used to come
    // through as a screen of JSON above it.
    expect(answer.content).toBe("Nice, Hazel! What kind of dog is she?");
    expect(answer.content).not.toContain("memory_write");
    // And the export's own note to the reader isn't part of what was said.
    expect(answer.content).not.toContain("not supported on your current device");

    // Titles and times survive.
    expect(chat.messages[0].content).toBe("I have a dog named hazel");
    expect(chat.createdAt).toBe(Date.parse("2026-09-02T06:54:00Z"));
  });

  test("reads the memories zip into memories", () => {
    const { conversations, memories } = parseUpload(fixture("memories000.zip"), "u1");
    expect(conversations).toHaveLength(0);
    expect(memories).toEqual([
      "has a dog named Hazel, a Maltese",
      "favourite food is crepes",
    ]);
  });

  test("drops the filing and keeps the fact", () => {
    // Front matter is about the file; [stated] is where Claude got it from.
    // Neither is something you'd want read back to you.
    expect(
      convertMemories({
        memory_files: [
          {
            content:
              "---\nname: pets\ndescription: notes\n---\n\n- [inferred] likes long walks\n- [stated] likes long walks\n",
          },
        ],
      })
    ).toEqual(["likes long walks"]);
  });

  test("says which zip you gave it when it's the wrong one", () => {
    expect(() => parseUpload(fixture("feedback000.zip"), "u1")).toThrow(
      /feedback you left/
    );
  });
});
