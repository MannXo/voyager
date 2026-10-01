/**
 * Which stored pack a Gemini page works on: the global pack, or the current
 * account's pack when account isolation is on.
 *
 * The key is resolved from a context snapshot taken when the scope is bound,
 * never from `location` at the time an op finally runs, so an answer added
 * under one account cannot land in another after a switch. Unlike
 * `AccountIsolationService.isIsolationEnabled`, which reads a storage failure
 * as "off", a failure here rejects: the pack then fails closed instead of
 * falling back to the shared global pack.
 */
import {
  type AccountScope,
  type AccountScopeHints,
  detectAccountContextFromDocument,
  detectAccountPlatformFromUrl,
  getAccountIsolationStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { resolveResearchPackStorageKey } from '@/features/researchPack/services/packStore';

export interface ResearchPackScopeContext {
  pageUrl: string;
  routeUserId: string | null;
  email: string | null;
}

export function readScopeContext(pageUrl = window.location.href): ResearchPackScopeContext {
  const { routeUserId, email } = detectAccountContextFromDocument(pageUrl, document);
  return { pageUrl, routeUserId, email };
}

/**
 * Whether the page now belongs to a different account than `bound`. An email
 * that is not (yet) visible counts as unknown, not as a change.
 */
export function isDifferentAccount(
  bound: ResearchPackScopeContext,
  current: ResearchPackScopeContext,
): boolean {
  if (bound.routeUserId !== current.routeUserId) return true;
  return Boolean(bound.email && current.email && bound.email !== current.email);
}

/**
 * The page now shows an email for the route the scope was bound to without
 * one. At startup a reused `/u/<index>/` route can still alias the account
 * that last used it, so the email may name a different pack; only resolving
 * both tells.
 */
export function gainsAccountEmail(
  bound: ResearchPackScopeContext,
  current: ResearchPackScopeContext,
): boolean {
  return bound.routeUserId === current.routeUserId && !bound.email && Boolean(current.email);
}

/**
 * The platform flag and the legacy flag that decide isolation for this page,
 * or null when the page belongs to no account platform (any non-Gemini,
 * non-AI Studio site). There is deliberately no Gemini fallback: such a page
 * has no pack scope at all.
 */
function isolationKeys(pageUrl: string): [string, string] | null {
  const platform = detectAccountPlatformFromUrl(pageUrl);
  if (!platform) return null;
  return [getAccountIsolationStorageKey(platform), StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED];
}

/** True when a storage change can flip account isolation for this page. */
export function isIsolationSettingChange(
  changes: Record<string, unknown>,
  areaName: string,
  pageUrl: string,
): boolean {
  if (areaName !== 'sync') return false;
  return isolationKeys(pageUrl)?.some((key) => key in changes) ?? false;
}

export interface ResearchPackKeyResolverDeps {
  getSync: (keys: string[]) => Promise<Record<string, unknown>>;
  resolveAccountScope: (hints: AccountScopeHints) => Promise<AccountScope>;
}

/**
 * Same precedence as the isolation service (platform flag, then legacy flag),
 * but a read failure, or a page with no account platform, rejects.
 */
export async function readIsolationEnabledStrict(
  pageUrl: string,
  getSync: ResearchPackKeyResolverDeps['getSync'],
): Promise<boolean> {
  const keys = isolationKeys(pageUrl);
  if (!keys) throw new Error('This page has no research pack scope');
  const [platformKey, legacyKey] = keys;
  const stored = await getSync([platformKey, legacyKey]);
  if (typeof stored?.[platformKey] === 'boolean') return stored[platformKey] === true;
  if (typeof stored?.[legacyKey] === 'boolean') return stored[legacyKey] === true;
  return false;
}

export function createResearchPackKeyResolver(
  deps: ResearchPackKeyResolverDeps,
): (context: ResearchPackScopeContext) => Promise<string> {
  return (context) =>
    resolveResearchPackStorageKey({
      isIsolationEnabled: () => readIsolationEnabledStrict(context.pageUrl, deps.getSync),
      resolveAccountKey: async () => {
        const scope = await deps.resolveAccountScope({
          pageUrl: context.pageUrl,
          routeUserId: context.routeUserId,
          email: context.email,
        });
        return scope.accountKey;
      },
    });
}
