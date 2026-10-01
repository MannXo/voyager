/**
 * Voyager's native surfaces, Gemini and AI Studio, as data.
 *
 * Their content script is declared statically in the extension manifest, with
 * matching `host_permissions`, so they never need a dynamic registration or an
 * optional host grant. They are also outside the remote plugin catalog: no
 * catalog file is ever looked up for them (the zero-request promise for Gemini).
 * Only user-imported local plugins may target them.
 *
 * Keep these in step with `manifest.json`'s first `content_scripts` entry.
 */
export const GEMINI_MATCHES: readonly string[] = [
  'https://gemini.google.com/*',
  'https://business.gemini.google/*',
];

export const AISTUDIO_MATCHES: readonly string[] = [
  'https://aistudio.google.com/*',
  'https://aistudio.google.cn/*',
];

export const NATIVE_SURFACE_MATCHES: readonly string[] = [...GEMINI_MATCHES, ...AISTUDIO_MATCHES];

const NATIVE_SURFACE_HOSTS: ReadonlySet<string> = new Set(
  NATIVE_SURFACE_MATCHES.map((pattern) => pattern.replace(/^https:\/\//, '').replace(/\/.*$/, '')),
);

/** True for gemini.google.com, business.gemini.google, aistudio.google.com/.cn. */
export function isNativeSurfaceHost(host: string): boolean {
  return NATIVE_SURFACE_HOSTS.has(host.trim().toLowerCase());
}
