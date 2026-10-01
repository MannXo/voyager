import {
  type ChatGptThreadMessage,
  TURN_VERSION_ATTRIBUTES,
  mountedTurnItems,
  readTurnFingerprint,
  readTurnKey,
  resolveVisibleConversationRoot,
} from './chatgptThread';

/**
 * Whether a mounted item differs from `reference` (turn key to fingerprint):
 * it shows another version of a turn in it, or a turn missing from it. An
 * edited prompt's branch gives the prompt and every later turn new keys, so a
 * missing key is a change too. With `learn`, a missing key is added instead.
 */
function mountedTurnChanged(reference: Map<string, string>, learn: boolean): boolean {
  for (const item of mountedTurnItems(resolveVisibleConversationRoot(document))) {
    const key = readTurnKey(item);
    const fingerprint = readTurnFingerprint(item);
    const known = reference.get(key);
    if (known === undefined) {
      if (!learn) return true;
      reference.set(key, fingerprint);
    } else if (known !== fingerprint) {
      return true;
    }
  }
  return false;
}

function fingerprints(messages: readonly ChatGptThreadMessage[]): Map<string, string> {
  return new Map(messages.map((message) => [message.turnKey, message.fingerprint]));
}

export interface ThreadVersionWatch {
  /**
   * Compare against what the crawl read from now on. A mounted turn it did not
   * read then counts as a change as well.
   */
  adopt(messages: readonly ChatGptThreadMessage[]): void;
  /** Whether a turn changed since the watch started; takes pending mutations into account. */
  changed(): boolean;
  stop(): void;
}

/**
 * Watch the thread for a turn that changes version. A branch switch is a
 * click on a mounted item, and the observer runs right after ChatGPT renders
 * it, before the item can scroll away, so a switch is seen even when the item
 * is unmounted by the time the export reads its snapshot.
 *
 * Until {@link ThreadVersionWatch.adopt}, each turn is compared with the first
 * version the watch saw of it, from the first change in the thread on. The watch disconnects once it sees a change,
 * which includes another conversation's turns on screen once the reader
 * leaves; otherwise the next preparation stops it.
 */
export function watchThreadVersions(): ThreadVersionWatch {
  const reference = new Map<string, string>();
  let learning = true;
  let changed = false;
  const observer = new MutationObserver(() => check());

  function stop(): void {
    observer.disconnect();
  }

  function check(): void {
    if (changed) return;
    if (mountedTurnChanged(reference, learning)) {
      changed = true;
      stop();
    }
  }

  observer.observe(resolveVisibleConversationRoot(document), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...TURN_VERSION_ATTRIBUTES],
  });

  return {
    adopt(messages) {
      observer.takeRecords();
      reference.clear();
      fingerprints(messages).forEach((fingerprint, key) => reference.set(key, fingerprint));
      learning = false;
      check();
    },
    changed() {
      observer.takeRecords();
      check();
      return changed;
    },
    stop,
  };
}
