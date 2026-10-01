import { beforeEach, describe, expect, it } from 'vitest';

import { isAllowedResearchPackSender } from '../researchPackOwner';

describe('research pack background owner', () => {
  beforeEach(() => {
    Object.assign(chrome.runtime, { id: 'voyager-test' });
  });

  it('accepts pack edits only from this extension on a Gemini page', () => {
    const sender = (id: string, url: string): chrome.runtime.MessageSender => ({ id, url });

    expect(
      isAllowedResearchPackSender(sender('voyager-test', 'https://gemini.google.com/app')),
    ).toBe(true);
    expect(
      isAllowedResearchPackSender(sender('voyager-test', 'https://gemini.google.com.evil.com/app')),
    ).toBe(false);
    expect(
      isAllowedResearchPackSender(sender('voyager-test', 'http://gemini.google.com/app')),
    ).toBe(false);
    expect(isAllowedResearchPackSender(sender('other-ext', 'https://gemini.google.com/app'))).toBe(
      false,
    );
  });
});
