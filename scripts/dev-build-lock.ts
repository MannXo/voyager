import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Cross-process lock that serializes Chrome dev builds sharing one outDir.
 *
 * Two overlapping builds into `dist_chrome_dev` break the self-reloading dev
 * extension: Chrome reloads on the first build's marker while the second is
 * still writing, or the second build prunes the generation Chrome just loaded.
 * Holding this lock from buildStart until the marker is written makes the
 * second build start from the first one's committed output.
 */
export interface DevBuildLock {
  release(): void;
}

export interface AcquireDevBuildLockOptions {
  readonly pollMs?: number;
  readonly onWait?: (holderPid: number) => void;
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryCreateLock(lockPath: string): boolean {
  // link() creates the lock with its pid already written, so a waiter never
  // sees an empty lock file, and it fails if the lock exists.
  const pendingPath = `${lockPath}.${process.pid}`;
  writeFileSync(pendingPath, `${process.pid}\n`);
  try {
    linkSync(pendingPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(pendingPath, { force: true });
  }
}

/**
 * Wait until no live process holds `lockPath`, then take it. A lock left by a
 * dead process (nodemon kills in-flight builds) is taken over.
 */
export async function acquireDevBuildLock(
  lockPath: string,
  { pollMs = 200, onWait }: AcquireDevBuildLockOptions = {},
): Promise<DevBuildLock> {
  mkdirSync(dirname(lockPath), { recursive: true });
  let announcedHolder: number | null = null;
  while (!tryCreateLock(lockPath)) {
    const holder = readHolderPid(lockPath);
    if (holder === null || !isProcessAlive(holder)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (holder !== announcedHolder) {
      announcedHolder = holder;
      onWait?.(holder);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      if (readHolderPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
    },
  };
}
