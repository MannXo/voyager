import type { FolderData } from '@/core/types/folder';

import type { OpOutcome } from './folderOps';

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
