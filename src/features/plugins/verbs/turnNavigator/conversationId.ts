/**
 * Conversation ids for the navigator's starred messages. They are read from
 * the URL at the moment of each star read or write; markers never carry one.
 */
import { hashString } from '@/core/utils/hash';

import { MAX_REGEX_INPUT_LENGTH } from '../../sites/safeRegex';

interface ConversationIdConfig {
  readonly siteId: string;
  readonly conversationIdPattern?: string;
}

/** `<siteId>:conv:<id>` from the site's route pattern, else a hash of the path. */
export function buildConversationId(
  config: ConversationIdConfig,
  input: string = location.href,
): string {
  try {
    const url = new URL(input, location.origin);
    if (config.conversationIdPattern) {
      // The pattern policy (sites/safeRegex.ts) forbids the constructs that
      // backtrack catastrophically; a bounded subject caps the rest.
      const subject = url.pathname.slice(0, MAX_REGEX_INPUT_LENGTH);
      const match = new RegExp(config.conversationIdPattern).exec(subject);
      if (match?.[1]) return `${config.siteId}:conv:${match[1]}`;
    }
    return `${config.siteId}:${hashString(`${url.origin}${url.pathname}`)}`;
  } catch {
    return `${config.siteId}:${hashString(String(input || ''))}`;
  }
}

/**
 * The id stars are filed under, or null where a site names its conversations
 * in the route but this URL does not: a new chat the host has not given an id
 * yet. Every new chat shares that path, so nothing starred there could be told
 * apart later; starring waits for the real id instead of migrating records.
 */
export function starConversationId(
  config: ConversationIdConfig,
  input: string = location.href,
): string | null {
  const id = buildConversationId(config, input);
  return !config.conversationIdPattern || id.startsWith(`${config.siteId}:conv:`) ? id : null;
}
