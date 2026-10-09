import type { TextBlock } from "./types.ts";

export type BookPage = { startWord: number; endWord: number };

// Stable word ranges preserve progress across screen sizes and voice changes.
export function paginateBook(blocks: TextBlock[], wordCount: number, capacity = 180): BookPage[] {
  if (wordCount <= 0) return [];
  const size = Math.max(20, Math.floor(capacity));
  const pages: BookPage[] = [];
  let start = 0;
  while (start < wordCount) {
    const limit = Math.min(start + size, wordCount);
    let end = limit;
    if (limit < wordCount) {
      const boundary = blocks.filter(block => block.startWord > start + size * 0.5 && block.startWord <= limit).at(-1);
      if (boundary) end = boundary.startWord;
      let heading: TextBlock | undefined;
      while ((heading = blocks.find(block => (block.kind === "heading" || block.kind === "subheading") && block.startWord < end && block.startWord + block.wordCount >= end))) {
        if (heading.startWord <= start) break;
        end = heading.startWord;
      }
    }
    pages.push({ startWord: start, endWord: end });
    start = end;
  }
  return pages;
}

export function pageForWord(pages: BookPage[], word: number): number {
  if (!pages.length) return 0;
  const index = pages.findIndex(page => word < page.endWord);
  return index < 0 ? pages.length - 1 : index;
}
