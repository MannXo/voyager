import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getCatalogRevision } from '../lib/catalogRevision';

const roots: string[] = [];
function temporaryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-catalog-revision-'));
  roots.push(root);
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'pipe' });
  return root;
}
function commit(root: string, date: string): void {
  writeFileSync(join(root, 'site.json'), date);
  execFileSync('git', ['add', 'site.json'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'update selectors',
    ],
    {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('catalog source order', () => {
  it('rebuilding old source cannot gain freshness and clock skew cannot hide a newer selector fix', () => {
    const root = temporaryRepo();
    commit(root, '2026-10-03T10:00:00Z');
    const previous = getCatalogRevision(root);
    expect(getCatalogRevision(root)).toBe(previous);
    commit(root, '2026-10-02T10:00:00Z');
    expect(getCatalogRevision(root)).toBeGreaterThan(previous);
    execFileSync('git', ['checkout', '--detach', 'HEAD~1'], { cwd: root, stdio: 'pipe' });
    expect(getCatalogRevision(root)).toBe(previous);
  });

  it('a shallow build cannot publish a misleading truncated freshness stamp', () => {
    const root = temporaryRepo();
    commit(root, '2026-10-03T10:00:00Z');
    commit(root, '2026-10-03T11:00:00Z');
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', `file://${root}`, shallow], { stdio: 'pipe' });
    expect(() => getCatalogRevision(shallow)).toThrow('full Git history');
  });
});
