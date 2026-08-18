/**
 * Bygger nettversjonen av EV8 til én selvstendig HTML-fil.
 *
 * Poenget er at det bare finnes ÉN lydmotor. Denne fila henter DSP-koden,
 * bilmodellen og testkjøringen rett fra kildene appen bruker, og limer dem
 * inn i web/template.html. Nettversjonen kan derfor ikke drifte fra appen —
 * endrer du engineCore.ts, endrer du begge.
 *
 *   node scripts/build-web.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'web', 'ev8.html');

/* ── 1. DSP-kjernen ── */
const coreTs = fs.readFileSync(path.join(ROOT, 'src/audio/engineCore.ts'), 'utf8');
const m = coreTs.match(/String\.raw`([\s\S]*)`;\s*$/);
if (!m) throw new Error('fant ikke ENGINE_CORE_SRC i engineCore.ts');
const engineSrc = m[1];

/* ── 2. bil, motorprofiler og testkjøring, kompilert fra TypeScript ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev8web-'));
execFileSync(
  'npx',
  ['tsc', 'src/audio/profiles.ts', 'src/audio/testDrive.ts',
    '--outDir', tmp, '--module', 'esnext', '--target', 'es2019',
    '--moduleResolution', 'bundler'],
  { cwd: ROOT, stdio: 'inherit' },
);

const strip = (file) =>
  fs.readFileSync(path.join(tmp, file), 'utf8')
    .replace(/^\s*import[^;]+;\s*$/gm, '')     // modulene limes sammen i ett skop
    .replace(/^export /gm, '')
    .trim();

const data = [strip('profiles.js'), strip('testDrive.js')].join('\n\n');
fs.rmSync(tmp, { recursive: true, force: true });

/* ── 3. sett inn i malen ──
   Kjernen legges inn to ganger med vilje: som kjørbar kode (så
   ScriptProcessor-reserven kan kalle createEngineCore direkte) og som
   tekst (så AudioWorklet-en kan bygges av den). */
const template = fs.readFileSync(path.join(ROOT, 'web', 'template.html'), 'utf8');

const engineBlock =
  engineSrc + '\nvar ENGINE_CORE_SRC = ' + JSON.stringify(engineSrc) + ';\n';

const html = template
  .replace('/*__EV8_ENGINE__*/', () => engineBlock)
  .replace('/*__EV8_DATA__*/', () => data);

if (html.includes('__EV8_')) throw new Error('en plassholder ble ikke erstattet');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

console.log(`web/ev8.html — ${(html.length / 1024).toFixed(0)} kB, alt i én fil`);

/* ── 4. variant for publisering som nettside ──
   Verten leverer sitt eget <!doctype>/<head>/<body>-skjelett, så her sendes
   bare innholdet: tittel, skrifter, stil, markup og skript. */
const pick = (re, what) => {
  const r = html.match(re);
  if (!r) throw new Error('fant ikke ' + what);
  return r[0];
};
const hosted = [
  pick(/<title>[\s\S]*?<\/title>/, 'tittel'),
  pick(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^>]*>/, 'skriftlenke'),
  pick(/<style>[\s\S]*?<\/style>/, 'stil'),
  html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).trim(),
].join('\n');

const HOSTED = path.join(ROOT, 'web', 'ev8-hosted.html');
fs.writeFileSync(HOSTED, hosted);
console.log(`web/ev8-hosted.html — ${(hosted.length / 1024).toFixed(0)} kB, for publisering`);
