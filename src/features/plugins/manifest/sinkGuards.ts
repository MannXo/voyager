/**
 * Sink guards for declarative plugin output.
 *
 * A manifest's CSS and DOM-op values reach three sinks: a `<style>` element,
 * an inline style property and an element attribute. `{{setting}}` tokens are
 * substituted before those writes, and setting values come from the manifest
 * default, `chrome.storage` or a Drive restore, none of which the manifest
 * validator saw. So every check here runs on the RENDERED value, both when a
 * manifest is validated (rendered with its defaults) and in the engine right
 * before each write.
 *
 * The sinks also compose: a custom property set by `setStyle` or a `style`
 * attribute is readable from the plugin's stylesheet through `var()`, and an
 * attribute value through `attr()`. So no sink may hold an external URL in any
 * form a later sink could turn into a fetch, whatever the sink it came from.
 *
 * Every scan here is linear in the input: the checks run on the page's main
 * thread against remote catalog data.
 */
import { MAX_STYLE_LENGTH } from '../constants';
import type { PluginSettings, SettingsSchema } from '../types';

/**
 * Substitute `{{key}}` tokens with the current setting values, falling back to
 * each setting's declared default. Bounded parameter substitution over
 * declared keys, not a template language.
 */
export function renderSettingTemplate(
  value: string,
  schema: SettingsSchema | undefined,
  settings: PluginSettings,
): string {
  if (!schema) return value;
  let rendered = value;
  for (const key of Object.keys(schema)) {
    const settingValue = settings[key] ?? schema[key].default;
    rendered = rendered.split(`{{${key}}}`).join(String(settingValue));
  }
  return rendered;
}

/** One escape per match, left to right, so an escaped `\\` never starts another. */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/gi;

/** Resolve CSS escapes (`\75 rl(`, `@\69mport`, `\` + newline) as the tokenizer does. */
function decodeCssEscapes(css: string): string {
  return css.replace(CSS_ESCAPE, (_, hex?: string, newline?: string, char?: string) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    if (newline) return '';
    return char ?? '';
  });
}

/** Drop `/* *\/` comments; an unclosed comment runs to the end, as in CSS. */
function stripCssComments(css: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = css.indexOf('/*', from);
    if (open < 0) return out + css.slice(from);
    out += css.slice(from, open);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) return out;
    from = close + 2;
  }
}

/**
 * The text the url()/@import patterns scan. `/* *\/` is a comment between
 * tokens but plain text inside strings and `url(...)`, so both readings are
 * checked.
 */
function cssReadings(css: string): string[] {
  return [decodeCssEscapes(css), decodeCssEscapes(stripCssComments(css))];
}

/**
 * The URL parser drops ASCII tab/newline anywhere, trims leading C0 controls
 * and spaces, treats `\\` as `/` for http(s), and resolves `http:host` against
 * an https page as an absolute URL. The patterns below follow those rules.
 */
const URL_GAP = String.raw`[\t\n\r]*`;
const EXTERNAL_URL_START = [
  String.raw`(?:h${URL_GAP}t${URL_GAP}t${URL_GAP}p${URL_GAP}(?:s${URL_GAP})?:`,
  String.raw`|[\/\\]${URL_GAP}[\/\\])`,
].join('');
/** `url(` / `src(` whose argument starts with an external URL. */
const EXTERNAL_URL_FUNCTION = new RegExp(
  String.raw`\b(?:url|src)\(\s*(?:['"][\x00-\x20]*)?${EXTERNAL_URL_START}`,
  'i',
);
/** A URL, as the URL parser reads it, that starts with an external origin. */
const EXTERNAL_URL_PREFIX = new RegExp(String.raw`^[\x00-\x20]*${EXTERNAL_URL_START}`, 'i');
const EXTERNAL_URL_ANYWHERE = new RegExp(EXTERNAL_URL_START, 'i');

const isCssNewline = (ch: string): boolean => ch === '\n' || ch === '\r' || ch === '\f';
const isCssWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || isCssNewline(ch);
const isCssNameChar = (ch: string): boolean => /[a-z0-9_-]/i.test(ch) || ch.charCodeAt(0) >= 0x80;
/** Index just past the escape that starts at `index` (a backslash). */
function skipCssEscape(css: string, index: number): number {
  const hex = /^[0-9a-f]{1,6}(?:\r\n|[ \t\n\r\f])?/i.exec(css.slice(index + 1, index + 9));
  return index + 1 + (hex ? hex[0].length : 1);
}

/**
 * Walk the CSS the way its tokenizer does (comments, strings, escapes and
 * unquoted `url(` tokens) and report whether any string token starts with an
 * external URL once its escapes are resolved. A string can reach a fetch
 * through `image-set()`, `src()`, `image()` or `cross-fade()`, directly or via
 * `var()` from another sink, so the check does not depend on what precedes the
 * string. Where the reading could differ from the browser's (a quote inside an
 * unquoted `url(`, which the browser treats as a bad URL), it fails closed.
 */
function cssHasExternalString(source: string): boolean {
  // The tokenizer's preprocessing: CRLF, CR and FF are one newline.
  const css = source.replace(/\r\n?|\f/g, '\n');
  let name = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) return false;
      i = close + 2;
      name = '';
    } else if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== ch && !isCssNewline(css[end])) {
        end = css[end] === '\\' ? skipCssEscape(css, end) : end + 1;
      }
      const content = decodeCssEscapes(css.slice(i + 1, Math.min(end, css.length)));
      if (EXTERNAL_URL_PREFIX.test(content)) return true;
      i = end + 1;
      name = '';
    } else if (ch === '\\') {
      const next = skipCssEscape(css, i);
      name = name.length < 4 ? name + decodeCssEscapes(css.slice(i, next)).toLowerCase() : name;
      i = next;
    } else if (ch === '(' && name === 'url') {
      let j = i + 1;
      while (j < css.length && isCssWhitespace(css[j])) j++;
      if (css[j] !== '"' && css[j] !== "'") {
        // Unquoted url( token: runs to `)`; the URL itself is EXTERNAL_URL_FUNCTION's job.
        while (j < css.length && css[j] !== ')') {
          if (css[j] === '"' || css[j] === "'") return true;
          j = css[j] === '\\' ? skipCssEscape(css, j) : j + 1;
        }
      }
      i = j;
      name = '';
    } else {
      name = isCssNameChar(ch) ? (name.length < 4 ? name + ch.toLowerCase() : name) : '';
      i++;
    }
  }
  return false;
}

/**
 * True when CSS text can fetch an external resource: an external `url()` /
 * `src()`, or any string that starts with an external URL.
 */
export function cssHasExternalUrl(css: string): boolean {
  return (
    cssReadings(css).some((text) => EXTERNAL_URL_FUNCTION.test(text)) || cssHasExternalString(css)
  );
}

function cssHasRemoteResource(css: string): boolean {
  return cssReadings(css).some((text) => /@import\b/i.test(text)) || cssHasExternalUrl(css);
}

/** Problem with stylesheet text, or null when it may be injected. */
export function styleSheetIssue(css: string): string | null {
  if (css.length > MAX_STYLE_LENGTH) return `exceeds ${MAX_STYLE_LENGTH} chars`;
  if (cssHasRemoteResource(css)) {
    return 'must not use @import or external url(), or a string starting with an external URL (remote-resource fetch)';
  }
  return null;
}

/** Problem with one inline style value, or null when it may be set. */
export function styleValueIssue(value: string): string | null {
  return cssHasExternalUrl(value)
    ? 'must not use an external url(), or a string starting with an external URL (remote-resource fetch)'
    : null;
}

/**
 * Attributes a plugin may set, matched against the exact name that is written.
 * Everything else is refused: URL-bearing names (`href`, `src*`, `srcdoc`,
 * `action`, `data`, …) fetch, navigate or run code, `on*` runs code, `class`
 * would bypass addClass's `gv-` rule, `id` / `name` clobber DOM lookups, and
 * any namespaced name (`xlink:href`) is out.
 */
const ALLOWED_ATTRIBUTES = new Set([
  'title',
  'role',
  'lang',
  'dir',
  'hidden',
  'tabindex',
  'draggable',
  'spellcheck',
  'translate',
  'style',
]);
const ALLOWED_ATTRIBUTE_PATTERN = /^(?:data-[a-z0-9][a-z0-9._-]*|aria-[a-z]+)$/;

/** Problem with an attribute name, or null when a plugin may set it. */
export function attributeNameIssue(name: string): string | null {
  return ALLOWED_ATTRIBUTES.has(name) || ALLOWED_ATTRIBUTE_PATTERN.test(name)
    ? null
    : 'attribute is not allowed (use data-*, aria-*, style or an inert global attribute)';
}

/** Problem with one attribute write, or null when it may be set. */
export function attributeIssue(name: string, value: string): string | null {
  const nameIssue = attributeNameIssue(name);
  if (nameIssue) return nameIssue;
  if (name === 'style') return styleValueIssue(value);
  // An allowed attribute is inert, but `attr()` can read it from CSS and a page
  // script may copy a `data-*` value into a fetching attribute, so it may not
  // carry an external URL either. Unanchored so a URL anywhere in it counts.
  if (EXTERNAL_URL_ANYWHERE.test(value)) {
    return 'must not contain an external URL (remote-resource fetch)';
  }
  return null;
}
