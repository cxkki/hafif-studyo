// Pre-publish secret scan: fails if any file that git would publish contains an API key or app storage data.
//   node tools/check-secrets.mjs          -> scan files tracked or addable by git (respects .gitignore)
// Also run automatically by the git pre-push hook (tools/hooks/pre-push). Matches are printed masked.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{16,}/g],
  ['OpenRouter key', /sk-or-[A-Za-z0-9_-]{16,}/g],
  ['OpenAI key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['Groq key', /gsk_[A-Za-z0-9]{20,}/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/g],
  ['x-api-key value', /x-api-key["']?\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/gi],
];
// App storage must never be published (localStorage holds the AI keys).
const FORBIDDEN_PATHS = [/EBWebView/i, /(^|\/)\.storage\//, /Local Storage/i, /\.ldb$/i, /leveldb/i, /(^|\/)\.env(\.|$)/];

function listFiles() {
  try {
    const out = execSync('git ls-files -co --exclude-standard -z', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    // Not a git repo yet: walk the tree, skipping the usual ignored folders.
    const skip = new Set(['node_modules', '.git', 'dist', 'dist-web', 'bin', '_ref', '.tmp', '.claude']);
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skip.has(e.name)) walk(rel);
        } else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|mp4|webm|mp3|wav|ogg|glb|exe|neu|woff2?|ttf)$/i;
const mask = (s) => s.slice(0, 6) + '…' + '*'.repeat(6);
let problems = 0;
const files = listFiles();
for (const rel of files) {
  if (FORBIDDEN_PATHS.some((re) => re.test(rel))) {
    console.log(`FORBIDDEN PATH  ${rel}`);
    problems++;
    continue;
  }
  if (BINARY.test(rel)) continue;
  const abs = path.join(root, rel);
  let text;
  try {
    if (fs.statSync(abs).size > 5 * 1024 * 1024) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      for (const m of line.matchAll(re)) {
        console.log(`${name.padEnd(16)} ${rel}:${i + 1}  ${mask(m[0])}`);
        problems++;
      }
    }
  });
}
if (problems) {
  console.log(`\nSECRET SCAN FAILED: ${problems} problem(s) in ${files.length} files. Remove them before publishing.`);
  process.exit(1);
}
console.log(`secret scan ok: ${files.length} files, no API keys or app storage found`);
