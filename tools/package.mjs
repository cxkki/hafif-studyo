// Masaüstü paketi: resources/ → dist/HafifStudyo.exe (kaynaklar gömülü, tek dosya)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const run = (c) => execSync(c, { stdio: 'inherit' });

run('node build.mjs');
fs.rmSync('dist/HafifStudyo', { recursive: true, force: true });
run('npx neu build --embed-resources');
const built = 'dist/HafifStudyo/HafifStudyo-win_x64.exe';
if (!fs.existsSync(built)) throw new Error('neu build çıktısı yok: ' + built);
fs.copyFileSync(built, 'dist/HafifStudyo.exe');
fs.rmSync('dist/HafifStudyo', { recursive: true, force: true });
fs.copyFileSync('docs/TARIF.md', 'dist/TARIF.md');
fs.copyFileSync('tools/hs-run.ps1', 'dist/hs-run.ps1');
console.log('dist/HafifStudyo.exe hazır (' + Math.round(fs.statSync('dist/HafifStudyo.exe').size / 1024) + ' KB)');
