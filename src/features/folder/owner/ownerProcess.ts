import type { FolderData } from '@/core/types/folder';

import { applyFolderOp } from './applyFolderOp';
import { type OpOutcome, parseFolderOpBody, rejected } from './folderOps';
import type { FolderSitePolicy } from './folderOwnerPolicy';
import type {
  ClientRecord,
  FolderOwnerMeta,
  FolderOwnerStorageArea,
  ReadyState,
} from './folderOwnerState';

/** A drained body that failed the envelope checks: processed as `rejected: invalid_payload`. */
export const INVALID_BODY = Symbol('invalid pending body');

export interface Processed {
  data: FolderData | null;
  meta: FolderOwnerMeta;
  outcomes: Record<number, OpOutcome>;
  /** A bulk op already wrote `preBulk` for this commit. */
  preBulkWritten?: boolean;
}

/** What the drain and collection steps share with the turn that runs them. */
export interface OwnerTurnContext {
  area: FolderOwnerStorageArea;
  now: () => number;
  /** Commits `next` over `state`; the durable state, or `null` when nothing is known durable. */
  settle(key: string, state: ReadyState, next: Processed): Promise<ReadyState | null>;
  /** Best effort removal of a client's pending keys at or below `applied`. */
  removePending(clientId: string, seqs: number[], applied: number): Promise<void>;
}

export const seqRange = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => from + index);

/** A revived client resumes at its tombstone's watermark; outcomes were dropped at retirement. */
export function revive(meta: FolderOwnerMeta, clientId: string, now: number): FolderOwnerMeta {
  const tombstone = meta.retired[clientId];
  const retired = { ...meta.retired };
  delete retired[clientId];
  const client: ClientRecord = {
    applied: tombstone.applied,
    acked: tombstone.applied,
    outcomes: {},
    lastSeenAt: now,
  };
  return { ...meta, retired, clients: { ...meta.clients, [clientId]: client } };
}

/** Drops outcomes the client has delivered and records the contact. */
export function acknowledge(client: ClientRecord, ackedThrough: number, at: number): ClientRecord {
  const acked = Math.max(client.acked, Math.min(ackedThrough, client.applied));
  const outcomes = Object.fromEntries(
    Object.entries(client.outcomes).filter(([seq]) => Number(seq) > acked),
  );
  return { ...client, acked, outcomes, lastSeenAt: at };
}

export function withClient(
  meta: FolderOwnerMeta,
  clientId: string,
  client: ClientRecord,
): FolderOwnerMeta {
  return { ...meta, clients: { ...meta.clients, [clientId]: client } };
}

/**
 * The exactly-once rule (§6.3): a seq at or below the watermark is a duplicate
 * and returns its stored outcome; the next seq is applied and advances the
 * watermark whatever its outcome, so a retry can never apply it again.
 * `contact` is the client's own request; a drain passes `null` and keeps
 * every outcome for the client to collect (addendum P0 §2).
 */
export function processOps(
  state: ReadyState,
  meta: FolderOwnerMeta,
  clientId: string,
  ops: ReadonlyArray<{ seq: number; body: unknown }>,
  policy: FolderSitePolicy,
  now: number,
  contact: { ackedThrough: number } | null,
): Processed {
  const client: ClientRecord = { ...meta.clients[clientId] };
  const stored = { ...client.outcomes };
  const outcomes: Record<number, OpOutcome> = {};
  let data = state.data;
  for (const op of ops) {
    if (op.seq <= client.applied) {
      outcomes[op.seq] = stored[op.seq] ?? { kind: 'expired' };
      continue;
    }
    const body = op.body === INVALID_BODY ? null : parseFolderOpBody(op.body);
    const result = body
      ? applyFolderOp(data ?? { folders: [], folderContents: {} }, body, policy, now)
      : { data, outcome: rejected('invalid_payload') };
    if (result.outcome.kind === 'saved') data = result.data;
    client.applied = op.seq;
    stored[op.seq] = result.outcome;
    outcomes[op.seq] = result.outcome;
  }
  client.outcomes = stored;
  const final = contact ? acknowledge(client, contact.ackedThrough, now) : client;
  return { data, meta: withClient(meta, clientId, final), outcomes };
}
