import { describe, expect, it } from 'vitest';

import { type ObservedTurn, TurnOwnership } from './turnOwnership';

const A = 'site:conv:a';
const B = 'site:conv:b';

function keyed(): TurnOwnership {
  return new TurnOwnership(() => true);
}

function mounted(): TurnOwnership {
  return new TurnOwnership(() => false);
}

const item = (token: string | object, hash: string | null = null): ObservedTurn => ({
  token,
  hash,
});

describe('turn ownership with host keys', () => {
  it('gives a conversation the turns it loads and the turns it grows', () => {
    const owners = keyed();
    owners.enterRoute(A);
    owners.observe([item('a1', 'x')]);
    owners.observe([item('a1', 'x'), item('a2', 'y')]);

    expect(owners.allows('a1', A)).toBe(true);
    expect(owners.allows('a2', A)).toBe(true);
  });

  it('leaves a thread swapped in under the old URL unattributed, under either id', () => {
    const owners = keyed();
    owners.enterRoute(A);
    owners.observe([item('a1', 'x')]);
    owners.observe([item('b1', 'y')]);
    owners.enterRoute(B);
    owners.observe([item('b1', 'y')]);

    expect(owners.allows('b1', A)).toBe(false);
    expect(owners.allows('b1', B)).toBe(false);
  });

  it('carries the owner across a rename, but not across an empty refresh', () => {
    const owners = keyed();
    owners.enterRoute(A);
    owners.observe([item('a1', 'x')]);
    owners.observe([item('server-1', 'x')]);
    expect(owners.allows('server-1', A)).toBe(true);

    owners.observe([]);
    owners.observe([item('server-2', 'x')]);
    expect(owners.allows('server-2', A)).toBe(false);
  });

  it('keeps the previous conversation its turns after the URL changes first', () => {
    const owners = keyed();
    owners.enterRoute(A);
    owners.observe([item('a1', 'x'), item('a2')]);
    owners.enterRoute(B);
    owners.observe([item('a1', 'x'), item('a2')]);
    owners.observe([]);
    owners.observe([item('a1', 'x'), item('a2', 'z')]);
    owners.observe([item('b1', 'y')]);

    expect(owners.allows('a1', B)).toBe(false);
    expect(owners.allows('a2', B)).toBe(false);
    expect(owners.allows('b1', B)).toBe(true);
  });

  it("lets a new chat's turns be starred under its id, which then owns them", () => {
    const owners = keyed();
    owners.enterRoute(null);
    owners.observe([item('d1', 'x')]);
    owners.enterRoute(A);
    owners.observe([item('d1', 'x')]);

    expect(owners.allows('d1', A)).toBe(true);
    owners.adopt('d1', A);
    expect(owners.allows('d1', B)).toBe(false);
  });
});

describe('turn ownership with mounted elements', () => {
  it('gives a conversation the elements a far scroll mounts', () => {
    const owners = mounted();
    const [a1, a2] = [{}, {}];
    owners.enterRoute(A);
    owners.observe([item(a1, 'x')]);
    owners.observe([item(a2, 'y')]);

    expect(owners.allows(a2, A)).toBe(true);
  });

  it('leaves the previous thread unattributed when it remounts after the URL changed', () => {
    const owners = mounted();
    const [a1, again] = [{}, {}];
    owners.enterRoute(A);
    owners.observe([item(a1, 'x')]);
    owners.enterRoute(B);
    owners.observe([item(a1, 'x')]);
    owners.observe([]);
    owners.observe([item(again, 'x')]);

    expect(owners.allows(again, B)).toBe(false);
  });

  it('leaves new elements unattributed while the previous thread is still on screen', () => {
    const owners = mounted();
    const [a1, b1, b2] = [{}, {}, {}];
    owners.enterRoute(A);
    owners.observe([item(a1, 'x')]);
    owners.enterRoute(B);
    owners.observe([item(a1, 'x'), item(b1, 'y')]);
    owners.observe([item(b2, 'z')]);

    expect(owners.allows(b1, B)).toBe(false);
    expect(owners.allows(b2, B)).toBe(true);
  });

  it("gives a new chat's re-rendered thread to the id it was given", () => {
    const owners = mounted();
    const [draft, rerendered] = [{}, {}];
    owners.enterRoute(null);
    owners.observe([item(draft, 'x')]);
    owners.enterRoute(A);
    owners.observe([item(rerendered, 'x')]);

    expect(owners.allows(rerendered, A)).toBe(true);
  });
});
