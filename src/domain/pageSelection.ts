/**
 * Sorts and de-duplicates physical page numbers, then compresses adjacent pages.
 */
export function formatPageNumbersToRanges(pages: number[]): string {
  if (pages.length === 0) return '';

  const sorted = Array.from(new Set(pages)).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === end + 1) {
      end = sorted[index];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[index];
      end = sorted[index];
    }
  }

  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

/** Returns the ascending complement of a selection inside a physical document. */
export function invertPageSelection(selectedPages: Iterable<number>, totalPages: number): number[] {
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error('totalPages must be a positive integer');
  }

  const selected = new Set(selectedPages);
  const inverted: number[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (!selected.has(pageNumber)) inverted.push(pageNumber);
  }
  return inverted;
}

/**
 * A small Map-backed LRU. `get` refreshes recency; `peek` is render-safe and does not.
 */
export class LruCache<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  public constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('LRU capacity must be a positive integer');
    }
  }

  public get size(): number {
    return this.entries.size;
  }

  public has(key: Key): boolean {
    return this.entries.has(key);
  }

  public peek(key: Key): Value | undefined {
    return this.entries.get(key);
  }

  public get(key: Key): Value | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as Value;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  public set(key: Key, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.capacity) return;

    const oldestKey = this.entries.keys().next().value as Key | undefined;
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  public delete(key: Key): boolean {
    return this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
  }

  /** Oldest-to-newest keys, primarily useful for diagnostics and tests. */
  public keys(): Key[] {
    return Array.from(this.entries.keys());
  }
}
