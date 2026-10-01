import { beforeEach, describe, expect, it } from 'vitest';

import { type ObservedTurn, TurnOwnership } from './turnOwnership';

const A = 'site:conv:a';
const B = 'site:conv:b';

let url: string | null;
let keyedHost: boolean;
let owners: TurnOwnership;

beforeEach(() => {
  document.body.innerHTML = '';
  url = A;
  seenRoute = undefined;
  keyedHost = true;
  owners = new TurnOwnership(
    () => keyedHost,
    () => url,
  );
  owners.begin();
});

/** The host inserts a turn element now, under whatever the URL names. */
function insert(parent: Node = document.body): HTMLElement {
  const element = document.createElement('div');
  parent.appendChild(element);
  owners.recordInsertions([element]);
  return element;
}

let seenRoute: string | null | undefined;

/** A refresh sees the URL and these turns; like NavigatorStars, it enters a route only when it changed. */
function refresh(turns: ObservedTurn[]): void {
  if (url !== seenRoute) owners.enterRoute(url);
  seenRoute = url;
  owners.observe(turns);
}

const keyedTurn = (key: string, element: Node, hash: string | null = null): ObservedTurn => ({
  token: key,
  element,
  hash,
});
const mountedTurn = (element: Node, hash: string): ObservedTurn => ({
  token: element,
  element,
  hash,
});

describe('turn ownership with host keys', () => {
  it('gives a conversation the turns inserted under it, including ones it grows', () => {
    const a1 = insert();
    refresh([keyedTurn('a1', a1)]);
    const a2 = insert();
    refresh([keyedTurn('a1', a1), keyedTurn('a2', a2)]);

    expect(owners.allows('a1', A)).toBe(true);
    expect(owners.allows('a2', A)).toBe(true);
  });

  it('gives a turn the URL it was inserted under, not the URL of the next refresh', () => {
    const d1 = insert();
    url = B;
    refresh([keyedTurn('d1', d1)]);

    expect(owners.allows('d1', B)).toBe(false);
    expect(owners.allows('d1', A)).toBe(true);
  });

  it("never lets a new chat's turns be starred, not even under the id it gets", () => {
    url = null;
    const draft = insert();
    refresh([keyedTurn('d1', draft)]);
    url = A;
    refresh([keyedTurn('d1', draft)]);
    const next = insert();
    refresh([keyedTurn('d1', draft), keyedTurn('a1', next)]);

    expect(owners.allows('d1', A)).toBe(false);
    expect(owners.allows('a1', A)).toBe(true);
  });

  it('keeps the owner of a renamed key, even once the URL names another conversation', () => {
    const item = insert();
    refresh([keyedTurn('a1', item)]);
    url = B;
    refresh([keyedTurn('server-1', item)]);

    expect(owners.allows('server-1', A)).toBe(true);
    expect(owners.allows('server-1', B)).toBe(false);
  });

  it('leaves items that replace all of the conversation’s own unattributed', () => {
    const a1 = insert();
    refresh([keyedTurn('a1', a1, 'same')]);
    a1.remove();
    const b1 = insert();
    refresh([keyedTurn('b1', b1, 'same')]);

    expect(owners.allows('b1', A)).toBe(false);
  });

  it('leaves turns inserted while another conversation’s are on screen unattributed', () => {
    const a1 = insert();
    refresh([keyedTurn('a1', a1)]);
    url = B;
    const early = insert();
    refresh([keyedTurn('a1', a1), keyedTurn('b1', early)]);
    a1.remove();
    const later = insert();
    refresh([keyedTurn('b1', early), keyedTurn('b2', later)]);

    expect(owners.allows('b1', B)).toBe(false);
    // An unattributed turn may be anyone's, so it still withholds new ones.
    expect(owners.allows('b2', B)).toBe(false);
  });

  it('keeps the previous conversation its keys when its items come back after the URL changed', () => {
    const a1 = insert();
    refresh([keyedTurn('a1', a1)]);
    url = B;
    a1.remove();
    refresh([]);
    const again = insert();
    refresh([keyedTurn('a1', again)]);

    expect(owners.allows('a1', B)).toBe(false);
  });

  it('gives turns already on the page the URL from when recording began', () => {
    const before = document.createElement('div');
    document.body.appendChild(before);
    refresh([keyedTurn('p1', before)]);

    expect(owners.allows('p1', A)).toBe(true);
  });

  it('takes the insertion that brought the turn in, not an older one of the page around it', () => {
    const shell = insert();
    url = B;
    const b1 = insert(shell);
    refresh([keyedTurn('b1', b1)]);

    expect(owners.allows('b1', B)).toBe(true);
  });

  it('takes the turn item’s insertion, not a message mounted inside it later', () => {
    const item = insert();
    refresh([keyedTurn('a1', item)]);
    url = B;
    insert(item);
    refresh([keyedTurn('a1', item)]);

    expect(owners.allows('a1', B)).toBe(false);
  });
});

describe('turn ownership with mounted elements', () => {
  beforeEach(() => {
    keyedHost = false;
  });

  it('gives a conversation the elements a far scroll mounts', () => {
    const a1 = insert();
    refresh([mountedTurn(a1, 'x')]);
    a1.remove();
    const a2 = insert();
    refresh([mountedTurn(a2, 'y')]);

    expect(owners.allows(a2, A)).toBe(true);
  });

  it('leaves the previous thread unattributed when it remounts after the URL changed', () => {
    const a1 = insert();
    refresh([mountedTurn(a1, 'x')]);
    url = B;
    a1.remove();
    refresh([]);
    const again = insert();
    refresh([mountedTurn(again, 'x')]);

    expect(owners.allows(again, B)).toBe(false);
  });

  it("gives a new chat's re-rendered thread to the id it was given, but not the draft", () => {
    url = null;
    const draft = insert();
    refresh([mountedTurn(draft, 'x')]);
    url = A;
    draft.remove();
    const rerendered = insert();
    refresh([mountedTurn(rerendered, 'x')]);

    expect(owners.allows(draft, A)).toBe(false);
    expect(owners.allows(rerendered, A)).toBe(true);
  });
});
