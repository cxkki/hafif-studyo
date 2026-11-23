// i18n source extractor.
// Scans src/**/*.js for t('key', 'English fallback'[, ...]) calls and src/index.html for data-i18n* attributes,
// writes src/locales/en.json (the English source of truth for translators) and reports, per language file,
// how many keys are missing or obsolete.
//
//   node tools/i18n-extract.mjs            -> write en.json + coverage report
//   node tools/i18n-extract.mjs --missing tr  -> print the missing keys of one language as JSON (key: English)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const locDir = path.join(src, 'locales');

const keys = new Map(); // key -> English
const conflicts = [];
function add(key, en, where) {
  // Dynamic keys like t('pal.add.' + id) only give a prefix; those must be listed explicitly elsewhere.
  if (!key || key.endsWith('.')) return;
  if (keys.has(key) && keys.get(key) !== en && en) conflicts.push(`${key}: "${keys.get(key)}" vs "${en}" (${where})`);
  if (!keys.has(key) || !keys.get(key)) keys.set(key, en || '');
}

// JS string literal: '...', "..." or `...` without ${}
const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\$]|\\.)*\`)`;
// t('key', 'English') and A('key', 'English') (web-mode's attribute-escaping wrapper around t()).
const callRe = new RegExp(String.raw`\b[tA]\(\s*` + STR + String.raw`\s*(?:,\s*` + STR + String.raw`)?`, 'g');
// Label tables written as ['prefix.key', 'English'] pairs and resolved later with t(pair[0], pair[1]).
const pairRe = new RegExp(String.raw`\[\s*('[a-z0-9]+(?:\.[A-Za-z0-9_-]+)+')\s*,\s*` + STR + String.raw`\s*\]`, 'g');
const unquote = (s) => {
  if (!s) return '';
  const q = s[0];
  const body = s.slice(1, -1);
  if (q === '`') return body.replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  try {
    return JSON.parse(q === '"' ? s : '"' + body.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
  } catch {
    return body;
  }
};

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'locales') walk(p);
    } else if (e.name.endsWith('.js')) {
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(callRe)) add(unquote(m[1]), unquote(m[2]), path.relative(root, p));
      // Label tables written as ['prefix.key', 'English'] pairs (resolved later with t(pair[0], pair[1])).
      for (const m of text.matchAll(pairRe)) add(unquote(m[1]), unquote(m[2]), path.relative(root, p));
    }
  }
}
walk(src);

// index.html: data-i18n="key">Text<  and data-i18n-title="key" with title="Text"
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
for (const m of html.matchAll(/<(\w+)([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>([^<]*)</g)) add(m[3], m[5].trim(), 'index.html');
for (const attr of ['title', 'placeholder', 'aria-label']) {
  const re = new RegExp(`<\\w+([^>]*)>`, 'g');
  for (const m of html.matchAll(re)) {
    const tag = m[1];
    const k = new RegExp(`data-i18n-${attr}="([^"]+)"`).exec(tag);
    const v = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag);
    if (k) add(k[1], v ? v[1] : '', 'index.html');
  }
}

const en = Object.fromEntries([...keys.entries()].sort(([a], [b]) => a.localeCompare(b)));
fs.mkdirSync(locDir, { recursive: true });

const want = process.argv.indexOf('--missing');
if (want > 0) {
  const lang = process.argv[want + 1];
  const file = path.join(locDir, `${lang}.json`);
  const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const missing = Object.fromEntries(Object.entries(en).filter(([k]) => !(k in have)));
  process.stdout.write(JSON.stringify(missing, null, 2) + '\n');
  process.exit(0);
}

fs.writeFileSync(path.join(locDir, 'en.json'), JSON.stringify(en, null, 2) + '\n');
console.log(`en.json: ${Object.keys(en).length} keys`);
const empty = Object.entries(en).filter(([, v]) => !v).map(([k]) => k);
if (empty.length) console.log(`WARNING ${empty.length} keys without English text: ${empty.slice(0, 15).join(', ')}${empty.length > 15 ? ' …' : ''}`);
if (conflicts.length) console.log(`WARNING ${conflicts.length} keys with different English texts:\n  ` + conflicts.slice(0, 15).join('\n  '));
for (const f of fs.readdirSync(locDir).filter((x) => /^[a-z]{2}\.json$/.test(x) && x !== 'en.json').sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(locDir, f), 'utf8'));
  const missing = Object.keys(en).filter((k) => !(k in d)).length;
  const obsolete = Object.keys(d).filter((k) => !(k in en)).length;
  console.log(`${f}: ${Object.keys(d).length} keys, missing ${missing}, obsolete ${obsolete}`);
}
