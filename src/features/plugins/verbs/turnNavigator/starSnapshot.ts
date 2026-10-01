import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';

/**
 * Content hash shared by every historical turn-id format:
 * legacy `c-<mountIndex>-<hash>`, current `c-<hash>` and `c-<hash>~<n>`.
 */
export function extractTurnHash(turnId: string): string {
  const base = turnId.split('~')[0];
  const segments = base.split('-');
  return segments[segments.length - 1] || base;
}

/** Guard asynchronous reads without delaying the caller's existing promise chain. */
export class StarSnapshotLoader {
  private revision = 0;

  begin(isCurrent: () => boolean): () => boolean {
    const revision = ++this.revision;
    return () => revision === this.revision && isCurrent();
  }
}

/**
 * Move the stars of the given turns from one conversation id to another: a new
 * chat's draft id to the stable id the host gave it. Draft ids are a hash of
 * the path, so every new chat on `/` shares one; only this chat's turns move.
 */
export async function moveStarredMessages(
  from: string,
  to: string,
  hashes: readonly string[],
  conversationUrl: string,
): Promise<void> {
  const wanted = new Set(hashes);
  const messages = await StarredMessagesService.getStarredMessagesForConversation(from);
  for (const message of messages) {
    if (!wanted.has(extractTurnHash(message.turnId))) continue;
    await StarredMessagesService.addStarredMessage({
      ...message,
      conversationId: to,
      conversationUrl,
    });
    await StarredMessagesService.removeStarredMessage(from, message.turnId);
  }
}
