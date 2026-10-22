#!/usr/bin/env node
// Обновляет звёзды GitHub в каталоге VibeMarket через GitHub REST API.
//
//   node scripts/update-stars.mjs [файл.html ...]     по умолчанию index.html
//
// Без токена GitHub даёт 60 запросов в час, на каталог уходит по одному на приложение.
// С GITHUB_TOKEN или GH_TOKEN лимит 5000 в час, например: GH_TOKEN=$(gh auth token) node scripts/update-stars.mjs
// Если хоть один репозиторий не ответил, файлы не меняются.

import { readFile, writeFile } from 'node:fs/promises';

const files = process.argv.length > 2 ? process.argv.slice(2) : ['index.html'];
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const ENTRY = /repo: '([^']+)', stars: (\d+), lic: '([^']+)'/g;
const DATE = /const STARS_UPDATED = '\d{4}-\d{2}-\d{2}';/;
const today = new Date().toISOString().slice(0, 10);
const fmt = new Intl.NumberFormat('ru-RU');

async function fetchRepo(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vibemarket-update-stars',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (!res.ok) {
    const limited = res.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(`HTTP ${res.status}${limited ? ': лимит запросов исчерпан, задайте GITHUB_TOKEN' : ''}`);
  }
  const data = await res.json();
  return { stars: data.stargazers_count, fullName: data.full_name, license: data.license?.spdx_id ?? null };
}

async function pool(items, size, fn) {
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try { out.set(item, { ok: true, ...(await fn(item)) }); }
      catch (error) { out.set(item, { ok: false, error: error.message }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const sources = await Promise.all(files.map(async f => [f, await readFile(f, 'utf8')]));
const entries = new Map();
for (const [, text] of sources) {
  for (const [, repo, stars, lic] of text.matchAll(ENTRY)) entries.set(repo, { old: Number(stars), lic });
}
if (!entries.size) {
  console.error(`В файлах ${files.join(', ')} не найдено записей вида repo: '…', stars: N, lic: '…'`);
  process.exit(1);
}

console.log(`Запрашиваю ${entries.size} репозиториев${token ? ' с токеном' : ' без токена'}…`);
const results = await pool([...entries.keys()], 6, fetchRepo);

const failed = [...results].filter(([, r]) => !r.ok);
if (failed.length) {
  for (const [repo, r] of failed) console.error(`✗ ${repo}: ${r.error}`);
  console.error(`\nНе удалось получить ${failed.length} из ${entries.size}. Файлы не изменены.`);
  process.exit(1);
}

const rows = [...entries].map(([repo, { old, lic }]) => {
  const r = results.get(repo);
  return { repo, old, now: r.stars, renamed: r.fullName !== repo ? r.fullName : '', lic, ghLic: r.license };
}).sort((a, b) => b.now - a.now);

const pad = (s, n) => String(s).padEnd(n);
console.log('');
for (const row of rows) {
  const delta = row.now - row.old;
  const sign = delta > 0 ? '+' : '';
  const notes = [
    row.renamed && `переименован в ${row.renamed}`,
    row.ghLic && row.ghLic !== 'NOASSERTION' && row.ghLic !== row.lic && `GitHub определяет лицензию как ${row.ghLic}`,
  ].filter(Boolean).join('; ');
  console.log(`${pad(row.repo, 40)} ${fmt.format(row.now).padStart(9)}  (${sign}${fmt.format(delta)})${notes ? '  ← ' + notes : ''}`);
}

for (const [file, text] of sources) {
  const next = text
    .replace(ENTRY, (match, repo, stars, lic) => {
      const r = results.get(repo);
      return `repo: '${r.fullName}', stars: ${r.stars}, lic: '${lic}'`;
    })
    .replace(DATE, `const STARS_UPDATED = '${today}';`);
  if (next !== text) await writeFile(file, next);
  console.log(`\n${file}: обновлено, дата данных ${today}`);
}
