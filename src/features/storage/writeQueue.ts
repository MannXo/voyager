/**
 * An in-process chain of storage turns. Each turn starts after the previous
 * one settles, whether it resolved or threw, so two owners that share a
 * queue never interleave their read-change-write turns. Nothing about the
 * queue is persisted: what survives a worker restart is storage itself.
 */
export type Serialize = <T>(turn: () => Promise<T>) => Promise<T>;

export function createWriteQueue(): Serialize {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(turn: () => Promise<T>): Promise<T> => {
    const next = queue.then(turn, turn);
    queue = next.catch(() => undefined);
    return next;
  };
}

/** The background's one queue, shared by the prompt-library and folder owners. */
export const backgroundWriteQueue: Serialize = createWriteQueue();
