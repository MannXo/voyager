/**
 * What the Prompt Manager needs to know about the site it runs on.
 *
 * The panel itself is the same on every site; only these facts differ. A site
 * is resolved once per page by `resolvePromptSiteAdapter` in the content
 * module. When the panel runs at all (always, or only while the user's
 * custom-website list covers the host) is the content entry's decision, not a
 * fact about the site.
 */
export interface PromptSiteAdapter {
  /** Slash completion and sent-prompt chips run here. */
  readonly slash: boolean;
}
