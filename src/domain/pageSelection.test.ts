import { describe, expect, it } from 'vitest';
import { formatPageNumbersToRanges, invertPageSelection, LruCache } from './pageSelection';

describe('formatPageNumbersToRanges', () => {
  it('compresses a large contiguous document into one range', () => {
    const pages = Array.from({ length: 500 }, (_, index) => index + 1);
    expect(formatPageNumbersToRanges(pages)).toBe('1-500');
  });

  it('sorts, de-duplicates and compresses mixed pages', () => {
    expect(formatPageNumbersToRanges([500, 3, 1, 8, 2, 7, 3, 5, 9, 499])).toBe(
      '1-3, 5, 7-9, 499-500',
    );
  });

  it('represents an empty selection explicitly as an empty expression', () => {
    expect(formatPageNumbersToRanges([])).toBe('');
  });
});

describe('invertPageSelection', () => {
  it('returns the sorted complement for a large document', () => {
    const inverted = invertPageSelection([500, 1, 4, 2, 2], 500);
    expect(inverted).toHaveLength(496);
    expect(inverted.slice(0, 4)).toEqual([3, 5, 6, 7]);
    expect(inverted.at(-1)).toBe(499);
    expect(formatPageNumbersToRanges(inverted)).toBe('3, 5-499');
  });

  it('supports empty and full selections', () => {
    expect(invertPageSelection([], 3)).toEqual([1, 2, 3]);
    expect(invertPageSelection([1, 2, 3], 3)).toEqual([]);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used value and refreshes recency on get', () => {
    const cache = new LruCache<number, string>(2);
    cache.set(1, 'one');
    cache.set(2, 'two');
    expect(cache.get(1)).toBe('one');
    cache.set(3, 'three');

    expect(cache.has(2)).toBe(false);
    expect(cache.keys()).toEqual([1, 3]);
    expect(cache.size).toBe(2);
  });

  it('peek does not refresh recency and clear releases all entries', () => {
    const cache = new LruCache<number, string>(2);
    cache.set(1, 'one');
    cache.set(2, 'two');
    expect(cache.peek(1)).toBe('one');
    cache.set(3, 'three');
    expect(cache.has(1)).toBe(false);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
  });
});
