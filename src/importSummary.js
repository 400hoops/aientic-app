/**
 * What an import actually brought in, as a sentence.
 *
 * One zip of the export is chats and another is memories, so the same
 * upload button now has two possible outcomes and saying "imported 0 chats"
 * for a successful memory import is worse than saying nothing.
 */
export function importedSummary(result) {
  const parts = [];
  if (result.imported)
    parts.push(
      `${result.imported} chat${result.imported === 1 ? "" : "s"}` +
        (result.messages ? `, ${result.messages} messages` : "")
    );
  if (result.memories)
    parts.push(`${result.memories} memor${result.memories === 1 ? "y" : "ies"}`);
  return parts.length ? `Imported ${parts.join(" and ")}.` : "Nothing new in that file.";
}
