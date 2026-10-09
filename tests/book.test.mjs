import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateBook, pageForWord } from '../src/lib/reader/book.ts';

test('book pages cover all words exactly once including a long paragraph', () => {
  const pages = paginateBook([], 10001);
  assert.equal(pages[0].startWord, 0);
  assert.equal(pages.at(-1).endWord, 10001);
  pages.forEach((page, index) => {
    assert.ok(page.endWord > page.startWord);
    assert.ok(page.endWord - page.startWord <= 180);
    if (index) assert.equal(page.startWord, pages[index - 1].endWord);
  });
});
test('book page boundary prefers a whole paragraph and keeps heading with body', () => {
  const pages = paginateBook([
    { startWord: 0, wordCount: 140, kind: 'paragraph' },
    { startWord: 140, wordCount: 4, kind: 'heading' },
    { startWord: 144, wordCount: 170, kind: 'paragraph' },
  ], 314);
  assert.equal(pages[0].endWord, 140);
});
test('last word, end of document and empty document resolve to a valid page', () => {
  assert.deepEqual(paginateBook([], 0), []);
  assert.equal(pageForWord([], 0), 0);
  const pages = paginateBook([], 400);
  assert.equal(pageForWord(pages, 179), 0);
  assert.equal(pageForWord(pages, 180), 1);
  assert.equal(pageForWord(pages, 400), 2);
});
test('a chain of heading and subheading stays with its body', () => {
  const pages = paginateBook([
    { startWord: 0, wordCount: 140, kind: 'paragraph' },
    { startWord: 140, wordCount: 4, kind: 'heading' },
    { startWord: 144, wordCount: 4, kind: 'subheading' },
    { startWord: 148, wordCount: 170, kind: 'paragraph' },
  ], 318);
  assert.equal(pages[0].endWord, 140);
});
