import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireDevBuildLock } from './dev-build-lock';

const temporaryDirectories: string[] = [];

function lockPathInTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'voyager-dev-lock-'));
  temporaryDirectories.push(directory);
  return join(directory, 'dist', '.voyager-build-lock');
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('dev build lock', () => {
  it('keeps a second build waiting until the first releases the lock', async () => {
    const lockPath = lockPathInTemporaryDirectory();
    const first = await acquireDevBuildLock(lockPath, { pollMs: 5 });
    const waitedFor: number[] = [];
    let secondAcquired = false;
    const second = acquireDevBuildLock(lockPath, {
      pollMs: 5,
      onWait: (pid) => waitedFor.push(pid),
    }).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);
    expect(waitedFor).toEqual([process.pid]);

    first.release();
    (await second).release();
    expect(secondAcquired).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock left by a build process that no longer exists', async () => {
    const lockPath = lockPathInTemporaryDirectory();
    const lock = await acquireDevBuildLock(lockPath);
    lock.release();
    writeFileSync(lockPath, `${deadPid()}\n`);

    const takeover = await acquireDevBuildLock(lockPath, { pollMs: 5 });

    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    takeover.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not remove a lock that another build has since taken', async () => {
    const lockPath = lockPathInTemporaryDirectory();
    const lock = await acquireDevBuildLock(lockPath);
    writeFileSync(lockPath, `${process.ppid}\n`);

    lock.release();

    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.ppid));
  });
});
