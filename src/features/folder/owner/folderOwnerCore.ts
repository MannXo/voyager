import type { FolderData } from '@/core/types/folder';

import { applyFolderOp } from './applyFolderOp';
import { canonicalJson } from './canonicalHash';
import { type OpOutcome, parseFolderOpBody, rejected } from './folderOps';
import { FOLDER_SITE_POLICIES, type FolderSitePolicy, siteOfFolderKey } from './folderOwnerPolicy';
import {
  type ClientRecord,
  type FolderOwnerMeta,
  type FolderOwnerStorageArea,
  type OwnerState,
  type ReadyState,
  commitOwnerState,
  pendingOpKey,
  resolveOwnerState,
} from './folderOwnerState';

export const MAX_BATCH_OPS = 256;
export const MAX_BATCH_BYTES = 32 * 1024 * 1024;
export const DRAIN_CHUNK = 32;
export const GC_INTERVAL_MS = 60 * 60 * 1000;
/** A client idle this long, with no held mark and no accepted op left, is retired. */
export const CLIENT_IDLE_MS = 60 * 60 * 1000;
/** A tombstone lives at least this long; clients re-open before publishing well inside it (addendum P0 §1). */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Pending keys a dropped tombstone clears on each side of its watermark: above
 * it, left by a writer that broke the one-key-per-set rule; at or below it,
 * left by a crash between a commit and the key's removal.
 */
const STRAY_SCAN = 256;

/** `gvFolderOwner:pending:<clientId>:<seq>`: written once by the client, deleted once by the owner. */
export interface PendingOpEntry {
  v: 1;
  key: string;
  epoch: string;
  clientId: string;
  seq: number;
  at: number;
  op: unknown;
}

/** A client whose drained ops wait for the user (§7.8). */
export interface HeldClient {
  clientId: string;
  from: number;
  reason: 'foreign_write' | 'epoch_changed';
}

interface OpenBase {
  epoch: string;
  rev: number;
  applied: number;
  held: HeldClient[];
  legacySync: boolean;
}

export type OpenReply =
  | ({ kind: 'ready'; data: FolderData; dataHash: string } & OpenBase)
  | ({ kind: 'empty' } & OpenBase)
  | ({ kind: 'invalid' } & OpenBase)
  /** A re-open of an id this epoch does not know: take the `unknown_client` path (§6.3). */
  | { kind: 'unknown_client'; epoch: string }
  | { kind: 'refused'; reason: 'read_failed' | 'not_owner' | 'write_failed' };

export type ApplyReply =
  | { kind: 'ok'; epoch: string; rev: number; applied: number; outcomes: Record<number, OpOutcome> }
  | { kind: 'seq_gap'; applied: number }
  | { kind: 'bad_batch' }
  | { kind: 'unknown_client'; epoch: string }
  | { kind: 'refused'; reason: 'read_failed' | 'invalid_state' | 'write_failed' | 'not_owner' };

export interface OpenRequest {
  key: string;
  clientId: string;
  ackedThrough: number;
  /** The epoch a client got from an earlier `open`; absent for a new client. */
  epoch?: string;
}

export interface ApplyRequest {
  key: string;
  clientId: string;
  epoch: string;
  ops: Array<{ seq: number; body: unknown }>;
  ackedThrough: number;
}

export interface FolderOwnerCoreOptions {
  area: FolderOwnerStorageArea;
  now?: () => number;
  newId?: () => string;
  /** The shared in-process write queue (P1); defaults to a private chain. */
  serialize?: <T>(turn: () => Promise<T>) => Promise<T>;
}

export interface FolderOwnerCore {
  open(request: OpenRequest): Promise<OpenReply>;
  apply(request: ApplyRequest): Promise<ApplyReply>;
  /** Startup and `open` drain of every registered or retired client's accepted ops for `key`. */
  drain(key: string): Promise<void>;
}

const INVALID_BODY = Symbol('invalid pending body');

/** A revived client resumes at its tombstone's watermark; outcomes were dropped at retirement. */
function revive(meta: FolderOwnerMeta, clientId: string, now: number): FolderOwnerMeta {
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

interface Processed {
  data: FolderData | null;
  meta: FolderOwnerMeta;
  outcomes: Record<number, OpOutcome>;
}

/**
 * The exactly-once rule (§6.3): a seq at or below the watermark is a duplicate
 * and returns its stored outcome; the next seq is applied and advances the
 * watermark whatever its outcome, so a retry can never apply it again.
 */
function processOps(
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
  // Only the client's own request acknowledges outcomes; a drain keeps them for it.
  const final = contact ? acknowledge(client, contact.ackedThrough, now) : client;
  return { data, meta: { ...meta, clients: { ...meta.clients, [clientId]: final } }, outcomes };
}

/** Drops outcomes the client has delivered and records the contact. */
function acknowledge(client: ClientRecord, ackedThrough: number, at: number): ClientRecord {
  const acked = Math.max(client.acked, Math.min(ackedThrough, client.applied));
  const outcomes = Object.fromEntries(
    Object.entries(client.outcomes).filter(([seq]) => Number(seq) > acked),
  );
  return { ...client, acked, outcomes, lastSeenAt: at };
}

function isPendingEntry(value: unknown, clientId: string, seq: number): value is PendingOpEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === 1 &&
    entry.clientId === clientId &&
    entry.seq === seq &&
    typeof entry.key === 'string' &&
    typeof entry.epoch === 'string' &&
    typeof entry.at === 'number'
  );
}

const seqRange = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => from + index);

const isContiguous = (ops: ReadonlyArray<{ seq: number }>): boolean =>
  ops.every((op, index) => Number.isInteger(op.seq) && op.seq === ops[0].seq + index);

export function createFolderOwnerCore(options: FolderOwnerCoreOptions): FolderOwnerCore {
  const { area } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  let queue: Promise<unknown> = Promise.resolve();
  const serialize =
    options.serialize ??
    (<T>(turn: () => Promise<T>): Promise<T> => {
      const next = queue.then(turn, turn);
      queue = next.catch(() => undefined);
      return next;
    });
  const lastGcAt = new Map<string, number>();

  const resolve = (key: string): Promise<OwnerState> => resolveOwnerState(area, key, now(), newId);

  /**
   * Commits `processed` and returns the durable state, or `null` when nothing
   * the turn decided is known to be durable. After an unknown outcome the
   * state is resolved again, so callers judge by the stored watermark only.
   */
  async function settle(
    key: string,
    state: ReadyState,
    next: Processed,
  ): Promise<ReadyState | null> {
    const result = await commitOwnerState(area, key, state, next, newId());
    if (result.kind === 'committed') return result.state;
    if (result.kind === 'failed') return null;
    const resolved = await resolve(key);
    return resolved.kind === 'ready' ? resolved : null;
  }

  /** Best effort: a key at or below the durable watermark is never needed again. */
  async function removePending(clientId: string, seqs: number[], applied: number): Promise<void> {
    const keys = seqs.filter((seq) => seq <= applied).map((seq) => pendingOpKey(clientId, seq));
    if (keys.length === 0) return;
    try {
      await area.remove(keys);
    } catch {
      // Left for a later drain or tombstone drop.
    }
  }

  /** Accepted ops of one client, from its watermark on, in chunks; stops at a held op. */
  async function drainClient(
    key: string,
    start: ReadyState,
    clientId: string,
    policy: FolderSitePolicy,
  ): Promise<ReadyState> {
    let state = start;
    for (;;) {
      const client = state.meta.clients[clientId];
      if (!client || client.held) return state;
      const seqs = seqRange(client.applied + 1, DRAIN_CHUNK);
      let found: Record<string, unknown>;
      try {
        found = await area.get(seqs.map((seq) => pendingOpKey(clientId, seq)));
      } catch {
        return state;
      }
      const ops: Array<{ seq: number; body: unknown }> = [];
      let held: ClientRecord['held'];
      for (const seq of seqs) {
        const entry = found[pendingOpKey(clientId, seq)];
        if (entry === undefined) break;
        if (isPendingEntry(entry, clientId, seq)) {
          if (entry.epoch !== state.meta.epoch) held = { from: seq, reason: 'epoch_changed' };
          else if ((state.meta.foreignAt ?? 0) > entry.at) {
            held = { from: seq, reason: 'foreign_write' };
          }
          if (held) break;
        }
        const valid = isPendingEntry(entry, clientId, seq) && entry.key === key;
        ops.push({ seq, body: valid ? entry.op : INVALID_BODY });
      }
      if (ops.length === 0 && !held) return state;
      const processed = processOps(state, state.meta, clientId, ops, policy, now(), null);
      if (held) {
        const heldClient = { ...processed.meta.clients[clientId], held };
        processed.meta = {
          ...processed.meta,
          clients: { ...processed.meta.clients, [clientId]: heldClient },
        };
      }
      const settled = await settle(key, state, processed);
      if (!settled) return state;
      state = settled;
      const applied = state.meta.clients[clientId]?.applied ?? 0;
      await removePending(
        clientId,
        ops.map((op) => op.seq),
        applied,
      );
      // A chunk the durable watermark does not cover stays in its pending keys for a later turn.
      if (held || ops.length < DRAIN_CHUNK || applied < ops[ops.length - 1].seq) return state;
    }
  }

  async function drainKey(key: string, start: ReadyState, policy: FolderSitePolicy) {
    let state = start;
    // A retired client's accepted op revives it under its own watermark (addendum P0 §1).
    const tombstones = Object.entries(state.meta.retired);
    if (tombstones.length > 0) {
      let found: Record<string, unknown> = {};
      try {
        found = await area.get(tombstones.map(([id, t]) => pendingOpKey(id, t.applied + 1)));
      } catch {
        return state;
      }
      for (const [id, tombstone] of tombstones) {
        if (found[pendingOpKey(id, tombstone.applied + 1)] === undefined) continue;
        const revived: Processed = {
          data: state.data,
          meta: revive(state.meta, id, now()),
          outcomes: {},
        };
        state = (await settle(key, state, revived)) ?? state;
      }
    }
    for (const clientId of Object.keys(state.meta.clients)) {
      state = await drainClient(key, state, clientId, policy);
    }
    return state;
  }

  /** Removes the pending keys around each dropped tombstone's watermark; `false` if any may remain. */
  async function removeStrays(dropped: Array<[string, { applied: number }]>): Promise<boolean> {
    const strays = dropped.flatMap(([id, { applied }]) => {
      const from = Math.max(1, applied - STRAY_SCAN + 1);
      return seqRange(from, applied + STRAY_SCAN - from + 1).map((seq) => pendingOpKey(id, seq));
    });
    try {
      await area.remove(strays);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retires idle clients (always leaving a tombstone) and drops tombstones past
   * their TTL. Neither step trusts one absent probe to mean "no later
   * publisher": a tombstone stays revivable, and a client re-opens before
   * publishing long before its tombstone can be dropped (addendum P0 §1).
   */
  async function collect(meta: FolderOwnerMeta, at: number): Promise<FolderOwnerMeta> {
    const idle = Object.entries(meta.clients).filter(
      ([, client]) => !client.held && at - client.lastSeenAt >= CLIENT_IDLE_MS,
    );
    const expired = Object.entries(meta.retired).filter(([, t]) => at - t.at >= TOMBSTONE_TTL_MS);
    if (idle.length === 0 && expired.length === 0) return meta;
    let found: Record<string, unknown>;
    try {
      found = await area.get(
        [...idle, ...expired].map(([id, entry]) => pendingOpKey(id, entry.applied + 1)),
      );
    } catch {
      return meta;
    }
    const clients = { ...meta.clients };
    const retired = { ...meta.retired };
    const dropped = expired.filter(
      ([id, t]) => found[pendingOpKey(id, t.applied + 1)] === undefined,
    );
    // A tombstone is dropped only once its strays are gone: it is their only cleanup owner.
    if (dropped.length > 0 && (await removeStrays(dropped))) {
      for (const [id] of dropped) delete retired[id];
    }
    for (const [id, client] of idle) {
      if (found[pendingOpKey(id, client.applied + 1)] !== undefined) continue;
      delete clients[id];
      retired[id] = { applied: client.applied, at };
    }
    return { ...meta, clients, retired };
  }

  const policyFor = (key: string): FolderSitePolicy | null => {
    const site = siteOfFolderKey(key);
    return site ? FOLDER_SITE_POLICIES[site] : null;
  };

  const heldClients = (meta: FolderOwnerMeta): HeldClient[] =>
    Object.entries(meta.clients).flatMap(([clientId, client]) =>
      client.held ? [{ clientId, ...client.held }] : [],
    );

  async function open(request: OpenRequest): Promise<OpenReply> {
    const policy = policyFor(request.key);
    if (!policy) return { kind: 'refused', reason: 'not_owner' };
    return serialize(async () => {
      const { key, clientId } = request;
      let state = await resolve(key);
      if (state.kind === 'read_failed' || state.kind === 'write_failed') {
        return { kind: 'refused', reason: state.kind };
      }
      if (state.kind === 'ready') state = await drainKey(key, state, policy);
      if (request.epoch !== undefined && request.epoch !== state.meta.epoch) {
        return { kind: 'unknown_client', epoch: state.meta.epoch };
      }

      const at = now();
      let meta = state.meta;
      if (!meta.clients[clientId]) {
        if (meta.retired[clientId]) meta = revive(meta, clientId, at);
        else if (request.epoch !== undefined) return { kind: 'unknown_client', epoch: meta.epoch };
        else {
          const client: ClientRecord = { applied: 0, acked: 0, outcomes: {}, lastSeenAt: at };
          meta = { ...meta, clients: { ...meta.clients, [clientId]: client } };
        }
      }
      const client = acknowledge(meta.clients[clientId], request.ackedThrough, at);
      meta = { ...meta, clients: { ...meta.clients, [clientId]: client } };
      if (at - (lastGcAt.get(key) ?? -Infinity) >= GC_INTERVAL_MS) {
        meta = await collect(meta, at);
        lastGcAt.set(key, at);
      }

      // Registration is a meta-only commit; an invalid K is never rewritten here.
      const base: ReadyState =
        state.kind === 'ready'
          ? state
          : { kind: 'ready', data: null, hash: state.meta.dataHash, meta: state.meta };
      const committed = await settle(key, base, { data: base.data, meta, outcomes: {} });
      if (!committed || !committed.meta.clients[clientId]) {
        return { kind: 'refused', reason: 'write_failed' };
      }
      const reply: OpenBase = {
        epoch: committed.meta.epoch,
        rev: committed.meta.rev,
        applied: committed.meta.clients[clientId].applied,
        held: heldClients(committed.meta),
        legacySync: false,
      };
      if (state.kind === 'invalid') return { kind: 'invalid', ...reply };
      return committed.data
        ? { kind: 'ready', data: committed.data, dataHash: committed.hash, ...reply }
        : { kind: 'empty', ...reply };
    });
  }

  async function apply(request: ApplyRequest): Promise<ApplyReply> {
    const policy = policyFor(request.key);
    if (!policy) return { kind: 'refused', reason: 'not_owner' };
    return serialize(async () => {
      const { key, clientId, ops } = request;
      const state = await resolve(key);
      if (state.kind === 'read_failed' || state.kind === 'write_failed') {
        return { kind: 'refused', reason: state.kind };
      }
      if (state.kind === 'invalid') return { kind: 'refused', reason: 'invalid_state' };
      if (request.epoch !== state.meta.epoch) {
        return { kind: 'unknown_client', epoch: state.meta.epoch };
      }
      let meta = state.meta;
      if (!meta.clients[clientId]) {
        if (!meta.retired[clientId]) return { kind: 'unknown_client', epoch: meta.epoch };
        meta = revive(meta, clientId, now());
      }
      if (
        ops.length === 0 ||
        ops.length > MAX_BATCH_OPS ||
        !isContiguous(ops) ||
        canonicalJson(ops).length > MAX_BATCH_BYTES
      ) {
        return { kind: 'bad_batch' };
      }
      // A live client's own ops apply onto the current value and clear a racing drain's hold.
      const client = meta.clients[clientId];
      if (ops[0].seq > client.applied + 1) return { kind: 'seq_gap', applied: client.applied };
      if (client.held) {
        const { held: _cleared, ...rest } = client;
        meta = { ...meta, clients: { ...meta.clients, [clientId]: rest } };
      }

      const processed = processOps(state, meta, clientId, ops, policy, now(), {
        ackedThrough: request.ackedThrough,
      });
      const lastSeq = ops[ops.length - 1].seq;
      const durable = await settle(key, state, processed);
      const stored = durable?.meta.clients[clientId];
      if (!durable || !stored || stored.applied < lastSeq) {
        return { kind: 'refused', reason: 'write_failed' };
      }
      await removePending(
        clientId,
        ops.map((op) => op.seq),
        stored.applied,
      );
      const outcomes: Record<number, OpOutcome> = {};
      for (const op of ops) {
        outcomes[op.seq] = processed.outcomes[op.seq] ??
          stored.outcomes[op.seq] ?? { kind: 'expired' };
      }
      return {
        kind: 'ok',
        epoch: durable.meta.epoch,
        rev: durable.meta.rev,
        applied: stored.applied,
        outcomes,
      };
    });
  }

  async function drain(key: string): Promise<void> {
    const policy = policyFor(key);
    if (!policy) return;
    await serialize(async () => {
      const state = await resolve(key);
      if (state.kind === 'ready') await drainKey(key, state, policy);
    });
  }

  return { open, apply, drain };
}
