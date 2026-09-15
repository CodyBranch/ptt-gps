import { describe, expect, it } from 'vitest';
import { blockingChanges } from '../src/deploy/manager.js';

/**
 * Porcelain parsing, which is fiddlier than it looks: the status columns are
 * fixed-width and an unstaged change leads with a space, so anything that
 * tidies the text before splitting it corrupts exactly one line.
 */
describe('which local changes block a deploy', () => {
  it('lets event data through - a live box is dirty by design', () => {
    const porcelain = [
      ' M events/reference/legacy-course-roles.json',
      ' M events/test-gans-creek.json',
      '?? events/courses/picc2026_men.kml',
      '?? events/philadelphia-cycling-classic-2026.json',
    ].join('\n');

    expect(blockingChanges(porcelain)).toEqual([]);
  });

  it('does not lose the leading space on the first line', () => {
    // The original bug: trimming the output shifted this one path by a
    // character, so it alone was reported as blocking while its neighbours
    // passed - which reads like a problem with the file rather than the parser.
    const first = blockingChanges(' M events/a.json\n M events/b.json');
    expect(first).toEqual([]);

    const staged = blockingChanges('M  events/a.json\nMM events/b.json');
    expect(staged).toEqual([]);
  });

  it('still blocks on code', () => {
    const porcelain = [' M server/src/index.ts', ' M events/a.json', '?? deploy/scratch.ps1'].join('\n');
    expect(blockingChanges(porcelain)).toEqual([' M server/src/index.ts', '?? deploy/scratch.ps1']);
  });

  it('reads a rename by where the file ended up', () => {
    expect(blockingChanges('R  events/old.json -> events/new.json')).toEqual([]);
    expect(blockingChanges('R  events/old.json -> server/src/moved.ts')).toEqual([
      'R  events/old.json -> server/src/moved.ts',
    ]);
  });

  it('survives CRLF and a trailing newline', () => {
    expect(blockingChanges(' M events/a.json\r\n M server/src/x.ts\r\n')).toEqual([' M server/src/x.ts']);
  });

  it('is empty for a clean tree', () => {
    expect(blockingChanges('')).toEqual([]);
    expect(blockingChanges('\n')).toEqual([]);
  });

  it('does not mistake a path that merely starts with the word events', () => {
    expect(blockingChanges(' M eventsomething/x.ts')).toEqual([' M eventsomething/x.ts']);
  });
});

describe('files the deploy writes itself', () => {
  const LF = String.fromCharCode(10);

  it('does not block on a lockfile a previous deploy rewrote', () => {
    // npm rewrites it while installing, so every deploy leaves it modified.
    // The repair that puts it back runs inside a deploy, so blocking on it
    // stopped the only thing that could clear it - on both the console and the
    // script, a hundred lines before the restore.
    expect(blockingChanges(' M package-lock.json')).toEqual([]);
    expect(blockingChanges([' M package-lock.json', ' M events/a.json'].join(LF))).toEqual([]);
  });

  it('still blocks on code sitting alongside a rewritten lockfile', () => {
    expect(blockingChanges([' M package-lock.json', ' M server/src/index.ts'].join(LF))).toEqual([
      ' M server/src/index.ts',
    ]);
  });

  it('does not excuse a file that merely ends in the same words', () => {
    expect(blockingChanges(' M my-package-lock.json')).toEqual([' M my-package-lock.json']);
    expect(blockingChanges(' M docs/package-lock.json.md')).toEqual([' M docs/package-lock.json.md']);
  });
});
