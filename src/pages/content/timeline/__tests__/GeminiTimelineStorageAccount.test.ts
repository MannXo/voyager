import { afterEach, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';

import { createGeminiTimelineStoragePolicy } from '../GeminiTimelineStorage';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('keeps the captured account for stars and hierarchy after the page account changes', async () => {
  document.body.innerHTML = '<span data-email="original@example.com"></span>';
  const pageUrl = 'https://gemini.google.com/u/1/app/one';
  const resolve = vi
    .spyOn(accountIsolationService, 'resolveAccountScope')
    .mockImplementation(async (hints) => ({
      accountKey:
        hints?.email === 'original@example.com' ? 'email:opaque-original' : 'email:opaque-other',
      accountId: 1,
      routeUserId: hints?.routeUserId ?? null,
      emailHash: 'opaque-original',
    }));
  const policy = createGeminiTimelineStoragePolicy(pageUrl);
  document.body.innerHTML = '<span data-email="other@example.com"></span>';

  expect(await policy.stars.resolveAccount()).toBe('email:opaque-original');
  if (!('resolveAccountScope' in policy.hierarchy)) throw new Error('Missing Gemini hierarchy');
  expect(await policy.hierarchy.resolveAccountScope()).toEqual({
    accountKey: 'email:opaque-original',
    accountId: 1,
    routeUserId: '1',
    emailHash: 'opaque-original',
  });
  expect(resolve).toHaveBeenCalledWith({
    pageUrl,
    routeUserId: '1',
    email: 'original@example.com',
  });
});

it('omits star account metadata when neither route nor email identifies the page', async () => {
  const policy = createGeminiTimelineStoragePolicy('https://gemini.google.com/app/one');
  expect(await policy.stars.resolveAccount()).toBeUndefined();
  if (!('resolveAccountScope' in policy.hierarchy)) throw new Error('Missing Gemini hierarchy');
  expect(await policy.hierarchy.resolveAccountScope()).toBeNull();
});

it('surfaces account lookup failures instead of inventing a star account', async () => {
  vi.spyOn(accountIsolationService, 'resolveAccountScope').mockRejectedValue(
    new Error('Profile storage unavailable'),
  );
  const policy = createGeminiTimelineStoragePolicy('https://gemini.google.com/u/1/app/one');
  await expect(policy.stars.resolveAccount()).rejects.toThrow('Profile storage unavailable');
  if (!('resolveAccountScope' in policy.hierarchy)) throw new Error('Missing Gemini hierarchy');
  await expect(policy.hierarchy.resolveAccountScope()).rejects.toThrow(
    'Profile storage unavailable',
  );
});
