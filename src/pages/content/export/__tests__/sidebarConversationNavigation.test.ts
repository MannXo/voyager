import { afterEach, describe, expect, it } from 'vitest';

import { toastDriver } from '@/tests/toastDriver';

import { openSidebarConversationForExport } from '../sidebarConversationNavigation';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openSidebarConversationForExport', () => {
  it('tells the user when the menu belongs to no conversation it can find', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);

    await expect(openSidebarConversationForExport(trigger, () => ['.user-query'])).resolves.toBe(
      false,
    );

    expect(toastDriver.all()).toMatchObject([
      {
        message: 'Unable to locate the selected conversation. Please open it first, then export.',
        tone: 'error',
      },
    ]);
  });
});
