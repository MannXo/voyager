/**
 * Shadow-surface key guard — an isolated-world content script at document_start,
 * so its window capture listener is registered ahead of the page's own.
 *
 * The bundler loads this entry through a dynamic import, so a page listener
 * registered on `window` in the capture phase before that import resolves still
 * runs first. Listeners on `document`, `body` or any element always run later.
 * Like the other content entries, it lives as long as the page.
 */
import { installShadowKeyGuard } from './shadowKeyGuard';

installShadowKeyGuard();
