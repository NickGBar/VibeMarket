#!/usr/bin/env node
// Сверяет переводы в locales/*.json с русским исходником в index.html.
//
//   node scripts/check-locales.mjs            показать расхождения
//   node scripts/check-locales.mjs --strict   то же, но с кодом ошибки, если что-то не так
//
// Проверяет: все ключи интерфейса на месте и нет лишних, формы множественного числа заданы,
// переменные вида {name} совпадают с русскими, у всех категорий и приложений есть тексты,
// а в переводах нет HTML (строки вставляются в страницу как есть).

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STRICT = process.argv.includes('--strict');
const IN_ACTIONS = Boolean(process.env.GITHUB_ACTIONS);

const html = await readFile(`${ROOT}index.html`, 'utf8');
const ru = JSON.parse(html.match(/<script type="application\/json" id="i18n-ru">([\s\S]*?)<\/script>/)[1]);
const cats = [...html.matchAll(/\{ id: '([a-z]+)',\s+name: '[^']+',\s+sub: '/g)].map(m => m[1]);
const apps = [...html.matchAll(/\{ id: '([a-z0-9-]+)', name: '[^']+', cat: '/g)].map(m => m[1]);
const shotCounts = Object.fromEntries([...html.matchAll(/^ {4}([a-z0-9]+): \{ os: '[a-z]*', about: '.*', shots: \[(.*)\] \},?$/gm)]
  .map(m => [m[1], (m[2].match(/\['/g) || []).length]));

const vars = value => new Set([...(typeof value === 'object' ? Object.values(value) : [value]).join(' ').matchAll(/\{(\w+)\}/g)].map(m => m[1]));
const strings = value => (value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [value]);

let total = 0;
for (const file of (await readdir(`${ROOT}locales`)).filter(f => f.endsWith('.json')).sort()) {
  const problems = [];
  const code = file.replace(/\.json$/, '');
  let data;
  try {
    data = JSON.parse(await readFile(`${ROOT}locales/${file}`, 'utf8'));
  } catch (err) {
    problems.push(`не читается как JSON: ${err.message}`);
  }
  if (data) {
    if (data.meta?.lang !== code) problems.push(`meta.lang должен быть «${code}»`);
    const ui = data.ui || {};
    for (const [key, source] of Object.entries(ru)) {
      const value = ui[key];
      if (value === undefined) { problems.push(`нет ключа ${key}`); continue; }
      if (typeof source === 'object' && (typeof value !== 'object' || typeof value.other !== 'string')) problems.push(`${key}: нужны формы множественного числа, как минимум «other»`);
      if (typeof source === 'string' && typeof value !== 'string') problems.push(`${key}: должна быть строка`);
      const want = [...vars(source)].sort().join(',');
      const got = [...vars(value)].sort().join(',');
      if (want !== got) problems.push(`${key}: переменные {${got}} вместо {${want}}`);
    }
    for (const key of Object.keys(ui)) if (!(key in ru)) problems.push(`лишний ключ ${key}`);
    for (const id of cats) if (!data.cats?.[id]?.name || !data.cats?.[id]?.sub) problems.push(`нет названия или подзаголовка категории ${id}`);
    for (const id of apps) {
      const app = data.apps?.[id];
      if (!app?.desc || !app?.about) problems.push(`нет описания приложения ${id}`);
      else if (!Array.isArray(app.shots) || app.shots.length !== shotCounts[id]) problems.push(`${id}: нужно ${shotCounts[id]} подписей к скриншотам`);
    }
    for (const text of strings({ ui, cats: data.cats, apps: data.apps })) {
      if (typeof text === 'string' && /[<>]/.test(text)) problems.push(`HTML в переводе: «${text.slice(0, 60)}»`);
    }
  }
  total += problems.length;
  if (!problems.length) {
    console.log(`${file}: всё на месте`);
    continue;
  }
  console.log(`${file}: расхождений ${problems.length}`);
  for (const p of problems) console.log(IN_ACTIONS ? `::warning file=locales/${file}::${p}` : `  - ${p}`);
}
console.log(`Ключей интерфейса: ${Object.keys(ru).length}, категорий: ${cats.length}, приложений: ${apps.length}.`);
if (STRICT && total) process.exit(1);
