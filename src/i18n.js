// Internationalisation (i18n): default English, 20 languages, auto-detected from the system language.
//
// Usage in code:   t('video.export', 'Export video')            -> translated string (English fallback inline)
//                  t('video.clips', '{n} clips', { n: 3 })      -> "{name}" placeholders are replaced
// Usage in HTML:   <button data-i18n="top.help">Shortcuts</button>   (text content is the English fallback)
//                  data-i18n-title="key" / data-i18n-placeholder="key" for attributes
//
// Dictionaries live in src/locales/<code>.json (flat { "key": "text" }); the build copies them to
// resources/locales/. English needs no dictionary: the fallback text in code IS the English source.
import { store } from './util.js';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: '中文 (简体)' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'bn', name: 'বাংলা' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ko', name: '한국어' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'it', name: 'Italiano' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'ur', name: 'اردو', rtl: true },
  { code: 'pl', name: 'Polski' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'th', name: 'ไทย' },
];

let lang = 'en';
let dict = {};

/** Best match for the system/browser language list, e.g. ["tr-TR", "en-US"] -> "tr". */
export function detectLanguage(list = navigator.languages || [navigator.language || 'en']) {
  for (const l of list) {
    const base = String(l || '').toLowerCase().split(/[-_]/)[0];
    if (LANGUAGES.some((x) => x.code === base)) return base;
  }
  return 'en';
}

export const currentLanguage = () => lang;
export const isRtl = () => !!LANGUAGES.find((x) => x.code === lang)?.rtl;

/** Translate. fallback is the English text; params fill {name} placeholders. */
export function t(key, fallback, params) {
  let s = (key && dict[key]) || fallback || key || '';
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  return s;
}

/** Load the saved or detected language. Call once at startup, before building the UI. */
export async function initI18n() {
  const saved = store.get('lang', null);
  lang = saved && LANGUAGES.some((x) => x.code === saved) ? saved : detectLanguage();
  dict = {};
  // The single-file browser build (dist-web) embeds every dictionary in window.__HS_LOCALES (see build.mjs).
  const embedded = window.__HS_LOCALES && window.__HS_LOCALES[lang];
  if (embedded) dict = embedded;
  else if (lang !== 'en') {
    try {
      const res = await fetch(`locales/${lang}.json`, { cache: 'no-cache' });
      if (res.ok) dict = await res.json();
    } catch {
      // No dictionary (e.g. single-file browser build): English fallbacks are used.
    }
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  applyDom(document);
  return lang;
}

/** Translate static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder. */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (el._i18nSrc == null) el._i18nSrc = el.textContent;
    el.textContent = t(el.dataset.i18n, el._i18nSrc);
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const dataKey = 'i18n' + attr.replace(/(^|-)(\w)/g, (m, d, c) => c.toUpperCase());
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const k = `_i18nSrc_${attr}`;
      if (el[k] == null) el[k] = el.getAttribute(attr) || '';
      el.setAttribute(attr, t(el.dataset[dataKey], el[k]));
    }
  }
}

/** Change the language: saved, then the UI reloads so every module rebuilds its text. */
let langGuard = null;
/** main.js registers an async guard: (code) => boolean. Returning false cancels the reload. */
export function setLanguageGuard(fn) {
  langGuard = typeof fn === 'function' ? fn : null;
}

export async function setLanguage(code) {
  if (!LANGUAGES.some((x) => x.code === code)) return false;
  try {
    if (langGuard && !(await langGuard(code))) return false;
  } catch (e) {
    console.error(e);
    return false;
  }
  store.set('lang', code);
  location.reload();
  return true;
}
