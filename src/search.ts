// AND-of-terms substring matching, shared by the notes list search and the
// reference project's search. The query is split on whitespace and every
// resulting term must appear *somewhere* in the haystack (not necessarily
// adjacent or in the same order) -- matching a single literal substring of
// the whole query missed cases like searching "Chrome ひらがな" for a page
// titled "Google Chrome標準の検索機能でひらがなとカタカナが同時にマッチ
// する": both words are there, just not next to each other. This is how
// Scrapbox's own search (and most multi-word search boxes) behaves.
export function matchQuery(haystack: string, query: string): boolean {
  const terms = query
    .trim()
    .split(/[\s　]+/) // 　 = full-width space, common from Japanese IME
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  if (terms.length === 0) return true;
  const h = haystack.toLowerCase();
  return terms.every((t) => h.includes(t));
}
