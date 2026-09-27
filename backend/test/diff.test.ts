import { diffLines, summarize } from '../src/cms/diff';

/**
 * Unit-level (no server, no database) because the diff is a pure function and
 * the property that matters — reconstruct either side from the ops — is one you
 * can only assert exhaustively against a plain function.
 */
describe('diffLines', () => {
  const reconstruct = (lines: ReturnType<typeof diffLines>, side: 'before' | 'after'): string[] =>
    lines.filter((l) => (side === 'before' ? l.op !== 'add' : l.op !== 'remove')).map((l) => l.text);

  /** Mirrors the module's own line splitting so the round-trip is exact. */
  const asLines = (text: string): string[] => {
    const parts = text.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };

  it('reports nothing changed for identical text', () => {
    const lines = diffLines('# A\n\ntext\n', '# A\n\ntext\n');
    expect(summarize(lines)).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it('isolates an inserted line between unchanged ones', () => {
    const lines = diffLines('řádek 1\nřádek 2\n', 'řádek 1\npřidaný\nřádek 2\n');
    expect(summarize(lines)).toEqual({ added: 1, removed: 0, unchanged: 2 });
    expect(lines.filter((l) => l.op === 'add')).toEqual([
      { op: 'add', text: 'přidaný', before: null, after: 2 },
    ]);
  });

  it('separates a deletion from a following insertion', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(summarize(lines)).toEqual({ added: 0, removed: 1, unchanged: 2 });
    expect(lines.find((l) => l.op === 'remove')?.before).toBe(2);
  });

  it('renders an edited line as remove+add rather than a mutated equal', () => {
    const lines = diffLines('# Obsah\n\nStará věta.\n', '# Obsah\n\nNová věta.\n');
    expect(summarize(lines)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it('treats a missing final newline as a line ending, not an empty line', () => {
    expect(diffLines('a\n', 'a')).toEqual(diffLines('a', 'a'));
  });

  it('handles wholly different documents', () => {
    const lines = diffLines('x\ny\n', 'p\nq\nr\n');
    expect(summarize(lines)).toEqual({ added: 3, removed: 2, unchanged: 0 });
  });

  it('reconstructs both sides from the ops, which is the property the UI relies on', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['a', 'a'],
      ['a', 'b'],
      ['', 'a\n'],
      ['a\n', ''],
      ['a\nb\nc\n', 'b\nc\nd\n'],
      ['a\nb\nc\n', 'c\nb\na\n'],
      ['# H\n\np1\n\np2\n', '# H\n\np2\n\np1 revised\n'],
      ['same\n', 'same\n\n\n'],
    ];
    for (const [before, after] of cases) {
      const lines = diffLines(before, after);
      expect(reconstruct(lines, 'before')).toEqual(asLines(before));
      expect(reconstruct(lines, 'after')).toEqual(asLines(after));
    }
  });

  it('keeps line numbers monotonic on each side', () => {
    const lines = diffLines('1\n2\n3\n4\n', '2\n1\n3\n5\n4\n');
    for (const side of ['before', 'after'] as const) {
      const seen = lines.map((l) => l[side]).filter((v): v is number => v !== null);
      expect(seen).toEqual([...seen].sort((x, y) => x - y));
    }
  });
});
