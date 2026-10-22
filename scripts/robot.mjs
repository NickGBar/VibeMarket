#!/usr/bin/env node
// Робот VibeMarket. Работает в GitHub Actions и ведёт каталог без участия людей:
// проверяет заявки, считает голоса, публикует и снимает приложения, скрывает их по жалобам,
// обновляет звёзды и собирает файлы для кнопки «Скачать». Результат записывается в catalog.json, его читает страница.
//
//   node scripts/robot.mjs              полный проход
//   node scripts/robot.mjs --dry-run    то же, но без записи в GitHub: меняется только catalog.json на диске
//
// Нужны GITHUB_TOKEN и GITHUB_REPOSITORY, в Actions их задаёт GitHub. Правила лежат в rules.json.
// Тексты заявок недоверенные: робот не исполняет их и не передаёт в shell, а собирает записи
// каталога только из проверенных полей. Отвечает робот на языке формы, тексты в robot-i18n.mjs.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FORM_LABELS, formatDate, msg } from './robot-i18n.mjs';
import { pickDownloads, releaseOrder } from './downloads.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HOME = process.env.GITHUB_REPOSITORY || 'NickGBar/VibeMarket';
const BOT = process.env.ROBOT_LOGIN || 'github-actions[bot]';
const DRY = process.argv.includes('--dry-run');
const NOW = process.env.ROBOT_NOW ? new Date(process.env.ROBOT_NOW) : new Date(); // ROBOT_NOW нужен только тестам
const DAY = 24 * 3600 * 1000;
const MARK = 'vibemarket-robot';

const LABELS = {
  submission: ['0A84FF', 'Заявка в песочницу'],
  candidate: ['FFD60A', 'Прошла проверку, идёт голосование'],
  invalid: ['FF453A', 'Не прошла проверку, нужно исправить'],
  accepted: ['30D158', 'Опубликовано в песочнице'],
  rejected: ['8E8E93', 'Не набрала голосов'],
  blocked: ['1C1C1E', 'Снято мейнтейнером'],
  report: ['FF9F0A', 'Жалоба на приложение'],
};

// Заголовок поля формы → поле и язык. Формы на всех языках присылают поля как «### Заголовок».
const LABEL_INDEX = new Map(Object.entries(FORM_LABELS)
  .flatMap(([lang, labels]) => Object.entries(labels).map(([field, label]) => [label, { field, lang }])));

// Те же id и цвета, что PALETTE в index.html. Названия цветов, платформ и категорий на всех языках
// робот берёт из словарей сайта, поэтому в заявке подойдёт и «green», и «Зелёный», и «绿色».
const PALETTE = [
  ['blue', '#4AA8FF', '#0A5BD6'], ['purple', '#A99BFF', '#5E4BD8'], ['pink', '#FF6FA8', '#B3165A'], ['orange', '#FFA24D', '#E8590C'],
  ['yellow', '#FFD166', '#E98A15'], ['green', '#63D471', '#178A3B'], ['teal', '#3FD1C4', '#0E7C86'], ['graphite', '#5A5A60', '#1A1A1C'],
];
const OS_IDS = { m: 'macos', w: 'windows', l: 'linux', a: 'android', i: 'ios', b: 'web' };

const rules = JSON.parse(await readFile(`${ROOT}rules.json`, 'utf8'));
const age = date => (NOW - new Date(date)) / DAY;
const norm = text => String(text || '').toLowerCase().replace(/ё/g, 'е').trim();
const oneLine = (value, max) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);
// Проблема заявки хранится как [ключ, переменные] и превращается в текст на языке заявки
const render = (lang, problems) => problems.map(([key, vars]) => msg(lang, key, vars));

/* ---------- GitHub ---------- */

let calls = 0;
async function gh(path, { method = 'GET', body, allow = [] } = {}) {
  calls++;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vibemarket-robot',
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  if (res.status === 204 || !res.ok) return { status: res.status, data: null };
  return { status: res.status, data: await res.json() };
}

async function ghAll(path) {
  const items = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

// В режиме --dry-run всё, что меняет GitHub, только печатается
async function change(description, action) {
  if (DRY) { console.log(`[dry-run] ${description}`); return null; }
  console.log(description);
  return action();
}

async function ensureLabels() {
  const existing = new Set((await ghAll(`/repos/${HOME}/labels`)).map(l => l.name));
  for (const [name, [color, description]] of Object.entries(LABELS)) {
    if (!existing.has(name)) await change(`метка ${name}`, () => gh(`/repos/${HOME}/labels`, { method: 'POST', body: { name, color, description } }));
  }
}

const hasLabel = (issue, name) => issue.labels.some(l => (l.name || l) === name);

async function setLabels(issue, add = [], remove = []) {
  for (const name of add) {
    if (hasLabel(issue, name)) continue;
    await change(`#${issue.number}: +${name}`, () => gh(`/repos/${HOME}/issues/${issue.number}/labels`, { method: 'POST', body: { labels: [name] } }));
    issue.labels.push({ name });
  }
  for (const name of remove) {
    if (!hasLabel(issue, name)) continue;
    await change(`#${issue.number}: -${name}`, () => gh(`/repos/${HOME}/issues/${issue.number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE', allow: [404] }));
    issue.labels = issue.labels.filter(l => (l.name || l) !== name);
  }
}

async function closeIssue(issue, reason) {
  await change(`#${issue.number}: закрыть (${reason})`, () => gh(`/repos/${HOME}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: reason } }));
}

// У каждой заявки один комментарий робота: текст для людей и служебные данные в HTML-комментарии.
// Доверяем только комментариям самого робота, иначе можно было бы подделать дату начала голосования.
async function robotComment(issue) {
  const comments = await ghAll(`/repos/${HOME}/issues/${issue.number}/comments`);
  const own = comments.find(c => c.user?.login === BOT && c.body?.includes(`<!-- ${MARK} `));
  if (!own) return { comment: null, meta: null };
  try {
    return { comment: own, meta: JSON.parse(own.body.split(`<!-- ${MARK} `)[1].split(' -->')[0]) };
  } catch {
    return { comment: own, meta: null };
  }
}

async function writeComment(issue, comment, text, meta) {
  const body = `${text}\n\n<!-- ${MARK} ${JSON.stringify(meta)} -->`;
  if (comment?.body === body) return;
  if (comment) await change(`#${issue.number}: обновить комментарий`, () => gh(`/repos/${HOME}/issues/comments/${comment.id}`, { method: 'PATCH', body: { body } }));
  else await change(`#${issue.number}: комментарий`, () => gh(`/repos/${HOME}/issues/${issue.number}/comments`, { method: 'POST', body: { body } }));
}

/* ---------- Данные ---------- */

async function loadSite() {
  const html = await readFile(`${ROOT}index.html`, 'utf8');
  const cats = Object.fromEntries([...html.matchAll(/\{ id: '([a-z]+)',\s+name: '([^']+)',\s+sub: '/g)].map(m => [m[1], m[2]]));
  // Словари сайта: русский встроен в index.html, остальные языки в locales/*.json
  const dictionaries = [{ ui: JSON.parse(html.match(/<script type="application\/json" id="i18n-ru">([\s\S]*?)<\/script>/)?.[1] || '{}') }];
  for (const file of (await readdir(`${ROOT}locales`).catch(() => [])).filter(f => f.endsWith('.json'))) {
    try { dictionaries.push(JSON.parse(await readFile(`${ROOT}locales/${file}`, 'utf8'))); } catch { /* битый перевод не мешает роботу */ }
  }
  const names = (entries) => new Map(entries.filter(([name]) => name).map(([name, value]) => [norm(name), value]));
  return {
    repos: [...new Set([...html.matchAll(/repo: '([^']+)', stars: \d+, lic:/g)].map(m => m[1]))],
    ids: new Set([...html.matchAll(/\{ id: '([a-z0-9-]+)', name:/g)].map(m => m[1])),
    cats,
    catNames: names(Object.entries(cats).flatMap(([id, label]) => [[id, id], [label, id], ...dictionaries.map(d => [d.cats?.[id]?.name, id])])),
    colorNames: names(PALETTE.flatMap(([id], i) => [[id, i], ...dictionaries.map(d => [d.ui?.[`color.${i}`], i])])),
    osNames: names([...Object.entries(OS_IDS).flatMap(([code, id]) => [[id, code], ...dictionaries.map(d => [d.ui?.[`os.${code}`], code])]), ['веб', 'b'], ['браузер', 'b'], ['browser', 'b']]),
  };
}

async function loadCatalog() {
  try {
    return JSON.parse(await readFile(`${ROOT}catalog.json`, 'utf8'));
  } catch {
    return { version: 1, sandbox: [] };
  }
}

function parseForm(body) {
  const form = {};
  let lang = null;
  for (const part of String(body || '').replace(/\r\n/g, '\n').split(/^### /m).slice(1)) {
    const newline = part.indexOf('\n');
    const hit = LABEL_INDEX.get(part.slice(0, newline === -1 ? undefined : newline).trim());
    if (!hit) continue;
    const value = newline === -1 ? '' : part.slice(newline + 1).trim();
    form[hit.field] = value === '_No response_' ? '' : value;
    lang ||= hit.lang;
  }
  return { form, lang: lang || 'en' };
}

const parseRepo = value => {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\s].*)?$/.exec(String(value || '').trim());
  return m && m[1].toLowerCase() !== 'github.com' ? `${m[1]}/${m[2]}` : '';
};

const repoCache = new Map();
async function repoFacts(slug) {
  const key = slug.toLowerCase();
  if (repoCache.has(key)) return repoCache.get(key);
  const { data } = await gh(`/repos/${slug}`, { allow: [404, 451] });
  let facts = { missing: true };
  if (data) {
    const release = rules.repo.requireRelease
      ? (await gh(`/repos/${data.full_name}/releases/latest`, { allow: [404] })).status === 200
      : true;
    facts = {
      repo: data.full_name,
      name: data.name,
      private: data.private,
      archived: data.archived,
      fork: data.fork,
      license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : '',
      topics: data.topics || [],
      createdAt: data.created_at,
      stars: data.stargazers_count,
      release,
    };
  }
  repoCache.set(key, facts);
  return facts;
}

// Базовые требования, которые проверяются и при подаче, и у опубликованных приложений
function repoBreaks(f) {
  if (f.missing) return [['missing']];
  const out = [];
  if (f.private) out.push(['private']);
  if (f.archived) out.push(['archived']);
  if (!rules.repo.licenses.includes(f.license)) out.push(f.license ? ['license', { spdx: f.license }] : ['noLicense']);
  return out;
}

function repoProblems(f) {
  const out = repoBreaks(f);
  if (f.missing) return out;
  if (f.fork && !rules.repo.allowForks) out.push(['fork']);
  if (rules.repo.requireTopic && !f.topics.includes(rules.repo.requireTopic)) out.push(['topic', { topic: rules.repo.requireTopic }]);
  if (age(f.createdAt) < rules.repo.minAgeDays) out.push(['age', { days: rules.repo.minAgeDays }]);
  if (!f.release) out.push(['release']);
  return out;
}

const fingerprint = issue => createHash('sha256').update(`${issue.title}\n${issue.body || ''}`).digest('hex').slice(0, 16);

/* ---------- Заявки ---------- */

async function checkSubmission(issue, ctx) {
  const { form, lang } = parseForm(issue.body);
  const problems = [];
  const repo = parseRepo(form.repo);
  const name = oneLine(form.name, 60);
  const desc = oneLine(form.desc, 120);
  const about = oneLine(form.about, 800);
  // Подходит id категории, её название на любом языке сайта или «dev (Разработка)» целиком
  const category = ctx.site.catNames.get(norm(form.category)) || ctx.site.catNames.get(norm(form.category).split(/[\s(]/)[0]);
  if (!repo) problems.push(['repoFormat']);
  if (name.length < 2 || name.length > 40) problems.push(['nameLength']);
  if (desc.length < 10 || desc.length > 90) problems.push(['descLength']);
  if (about.length > 600) problems.push(['aboutLength']);
  if (!category) problems.push(['category', { list: Object.keys(ctx.site.cats).join(', ') }]);
  if ((String(form.consents || '').match(/^- \[x\]/gim) || []).length < 3) problems.push(['consents']);

  let facts = null;
  if (repo) {
    facts = await repoFacts(repo);
    problems.push(...repoProblems(facts));
    const key = (facts.repo || repo).toLowerCase();
    if (ctx.site.repos.some(r => r.toLowerCase() === key) || ctx.catalog.sandbox.some(a => a.repo.toLowerCase() === key && a.issue !== issue.number)) {
      problems.push(['duplicate']);
    } else if (ctx.candidates.some(c => c.number !== issue.number && c.repo.toLowerCase() === key)) {
      problems.push(['votingElsewhere']);
    }
  }
  const busy = ctx.candidates.filter(c => c.number !== issue.number && c.author === issue.user.login).length;
  if (busy >= rules.limits.candidatesPerAuthor) {
    problems.push(['busy', { n: busy }]);
  }

  const glyph = /^[a-z0-9]{1,20}$/.test(norm(form.glyph)) ? norm(form.glyph) : 'blocks';
  const app = {
    name,
    cat: category || 'dev',
    repo: facts?.repo || repo,
    stars: facts?.stars || 0,
    lic: facts?.license || '',
    glyph,
    c: PALETTE[ctx.site.colorNames.get(norm(form.color)) ?? 7].slice(1),
    desc,
    about,
    os: [...new Set(String(form.platforms || '').split(/[,;\n、，]/).map(p => ctx.site.osNames.get(norm(p))).filter(Boolean))].join(''),
  };
  return { problems, app, lang };
}

function candidateText(meta) {
  const v = rules.voting;
  return msg(meta.lang, 'candidate', {
    until: formatDate(meta.lang, new Date(meta.since).getTime() + v.days * DAY),
    voterAge: v.voterMinAgeDays,
    needed: v.votesNeeded,
    weight: v.downvoteWeight,
  });
}

const problemList = (lang, problems) => [msg(lang, 'invalid'), '', ...render(lang, problems).map(p => `- ${p}`)].join('\n');

async function review(issue, ctx) {
  const { comment, meta } = await robotComment(issue);
  const print = fingerprint(issue);
  if (meta?.print === print) return meta;
  const { problems, app, lang } = await checkSubmission(issue, ctx);
  if (problems.length) {
    const next = { status: 'invalid', print, lang };
    await setLabels(issue, ['invalid'], ['candidate']);
    await writeComment(issue, comment, problemList(lang, problems), next);
    return next;
  }
  const keep = meta?.status === 'candidate' && meta.repo?.toLowerCase() === app.repo.toLowerCase();
  const next = { status: 'candidate', print, lang, repo: app.repo, since: keep ? meta.since : NOW.toISOString() };
  await setLabels(issue, ['candidate'], ['invalid']);
  await writeComment(issue, comment, candidateText(next), next);
  return next;
}

const voterCache = new Map();
async function eligibleVoter(login) {
  if (!voterCache.has(login)) {
    const { data } = await gh(`/users/${encodeURIComponent(login)}`, { allow: [404] });
    voterCache.set(login, Boolean(data && data.type === 'User' && age(data.created_at) >= rules.voting.voterMinAgeDays));
  }
  return voterCache.get(login);
}

async function countVotes(issue, since) {
  const byUser = new Map();
  for (const r of await ghAll(`/repos/${HOME}/issues/${issue.number}/reactions`)) {
    if (!['+1', '-1'].includes(r.content) || !r.user || new Date(r.created_at) < since) continue;
    if (r.user.login === issue.user.login) continue;
    byUser.set(r.user.login, (byUser.get(r.user.login) || new Set()).add(r.content));
  }
  let up = 0, down = 0;
  for (const [login, votes] of byUser) {
    if (votes.size !== 1 || !(await eligibleVoter(login))) continue;
    if (votes.has('+1')) up++; else down++;
  }
  return { up, down };
}

function uniqueId(name, catalog, site) {
  const base = `sb-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app'}`;
  let id = base;
  for (let n = 2; site.ids.has(id) || catalog.sandbox.some(a => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

async function finishVoting(issue, meta, votes, ctx) {
  const v = rules.voting;
  const score = votes.up - v.downvoteWeight * votes.down;
  const lang = meta.lang || parseForm(issue.body).lang;
  const tally = msg(lang, 'tally', votes);
  const { comment } = await robotComment(issue);
  if (votes.up >= v.votesNeeded && score >= v.votesNeeded) {
    repoCache.clear();
    const { problems, app } = await checkSubmission(issue, { ...ctx, candidates: [] });
    const breaks = problems.filter(([key]) => key !== 'busy');
    if (!breaks.length) {
      const entry = { id: uniqueId(app.repo.split('/')[1], ctx.catalog, ctx.site), ...app, issue: issue.number, author: issue.user.login, lang, votes: votes.up, addedAt: NOW.toISOString(), checkedAt: NOW.toISOString() };
      ctx.catalog.sandbox.push(entry);
      await writeComment(issue, comment, msg(lang, 'accepted', { tally }), { ...meta, status: 'accepted' });
      await setLabels(issue, ['accepted'], ['candidate']);
      await closeIssue(issue, 'completed');
      return;
    }
    await writeComment(issue, comment, [msg(lang, 'broken', { tally }), '', ...render(lang, breaks).map(p => `- ${p}`), '', msg(lang, 'brokenHint')].join('\n'), { ...meta, status: 'invalid', print: '' });
    await setLabels(issue, ['invalid'], ['candidate']);
    return;
  }
  await writeComment(issue, comment, msg(lang, 'rejected', { tally, needed: v.votesNeeded, weight: v.downvoteWeight }), { ...meta, status: 'rejected' });
  await setLabels(issue, ['rejected'], ['candidate']);
  await closeIssue(issue, 'not_planned');
}

/* ---------- Основной проход ---------- */

const issueFields = (issue, extra) => ({ number: issue.number, author: issue.user.login, ...extra });

async function main() {
  if (!TOKEN) console.warn('Нет GITHUB_TOKEN: GitHub ограничит запросы, а проверка голосов и звёзд может не пройти.');
  const site = await loadSite();
  const catalog = await loadCatalog();
  catalog.sandbox ||= [];
  const before = JSON.stringify({ ...catalog, updated: null });
  await ensureLabels();

  // 1. Открытые заявки и жалобы. Заявку без метки узнаём по полям формы.
  const open = (await ghAll(`/repos/${HOME}/issues?state=open`)).filter(i => !i.pull_request);
  const submissions = [];
  const reports = [];
  for (const issue of open) {
    if (hasLabel(issue, 'blocked')) continue;
    const { form } = parseForm(issue.body);
    if (hasLabel(issue, 'report') || ('repo' in form && 'reason' in form)) {
      await setLabels(issue, ['report']);
      reports.push(issue);
    } else if (hasLabel(issue, 'submission') || ('repo' in form && 'consents' in form)) {
      await setLabels(issue, ['submission']);
      submissions.push(issue);
    }
  }

  // 2. Проверка новых и изменённых заявок
  const ctx = { site, catalog, candidates: [] };
  for (const issue of submissions) {
    const { meta } = await robotComment(issue);
    if (meta?.status === 'candidate') ctx.candidates.push(issueFields(issue, { repo: meta.repo }));
  }
  const metas = new Map();
  for (const issue of submissions) {
    const meta = await review(issue, ctx);
    metas.set(issue.number, meta);
    ctx.candidates = ctx.candidates.filter(c => c.number !== issue.number);
    if (meta.status === 'candidate') ctx.candidates.push(issueFields(issue, { repo: meta.repo }));
  }

  // 3. Голоса: итоги по истёкшим, промежуточные счёты для страницы
  const candidates = [];
  for (const issue of submissions) {
    const meta = metas.get(issue.number);
    if (meta?.status !== 'candidate') continue;
    const since = new Date(meta.since);
    const closesAt = new Date(since.getTime() + rules.voting.days * DAY);
    const votes = await countVotes(issue, since);
    if (NOW >= closesAt) {
      await finishVoting(issue, meta, votes, ctx);
      continue;
    }
    const { app } = await checkSubmission(issue, { ...ctx, candidates: [] });
    candidates.push({ issue: issue.number, name: app.name, desc: app.desc, repo: app.repo, cat: app.cat, glyph: app.glyph, c: app.c, lic: app.lic, stars: app.stars, up: votes.up, down: votes.down, closesAt: closesAt.toISOString() });
  }

  // 4. Мейнтейнер поставил метку blocked: приложение снимается сразу
  const blocked = await ghAll(`/repos/${HOME}/issues?state=all&labels=blocked`);
  const blockedIssues = new Set(blocked.map(i => i.number));
  catalog.sandbox = catalog.sandbox.filter(app => {
    if (!blockedIssues.has(app.issue)) return true;
    console.log(`снято мейнтейнером: ${app.repo}`);
    return false;
  });

  // 5. Раз в сутки перепроверяем опубликованные: удалён, закрыт, в архиве, сменил лицензию
  const kept = [];
  for (const app of catalog.sandbox) {
    if (app.checkedAt && age(app.checkedAt) < 1) { kept.push(app); continue; }
    const facts = await repoFacts(app.repo);
    const breaks = repoBreaks(facts);
    if (breaks.length) {
      const reasons = render(app.lang || 'ru', breaks).join(' ');
      console.log(`снято: ${app.repo}: ${render('ru', breaks).join(' ')}`);
      if (app.issue) {
        await change(`#${app.issue}: сообщить о снятии`, () => gh(`/repos/${HOME}/issues/${app.issue}/comments`, { method: 'POST', body: { body: msg(app.lang || 'ru', 'removed', { reasons }) } }));
      }
      continue;
    }
    kept.push({ ...app, repo: facts.repo, lic: facts.license, checkedAt: NOW.toISOString() });
  }
  catalog.sandbox = kept;

  // 6. Жалобы: приложение скрывается, пока открыто достаточно жалоб от разных аккаунтов
  const reporters = new Map();
  for (const issue of reports) {
    const repo = parseRepo(parseForm(issue.body).form.repo);
    if (!repo || !(await eligibleVoter(issue.user.login))) continue;
    const key = repo.toLowerCase();
    reporters.set(key, (reporters.get(key) || new Set()).add(issue.user.login));
  }
  catalog.hidden = [...reporters]
    .filter(([, people]) => people.size >= rules.reports.toHide)
    .map(([repo, people]) => ({ repo, reports: people.size }));
  const hidden = new Set(catalog.hidden.map(h => h.repo));

  // 7. Звёзды одним GraphQL-запросом на сотню репозиториев
  const repos = [...new Set([...site.repos, ...catalog.sandbox.map(a => a.repo)])];
  const stars = { ...(catalog.stars || {}) };
  for (let i = 0; i < repos.length; i += 100) {
    const chunk = repos.slice(i, i + 100);
    const variables = {};
    const fields = chunk.map((slug, j) => {
      const [owner, name] = slug.split('/');
      variables[`o${j}`] = owner;
      variables[`n${j}`] = name;
      return `r${j}: repository(owner: $o${j}, name: $n${j}) { stargazerCount }`;
    });
    const query = `query(${chunk.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(', ')}) { ${fields.join(' ')} }`;
    const { data } = await gh('/graphql', { method: 'POST', body: { query, variables }, allow: [401, 403, 502] });
    chunk.forEach((slug, j) => {
      const count = data?.data?.[`r${j}`]?.stargazerCount;
      if (Number.isFinite(count)) stars[slug] = count;
    });
  }
  for (const app of catalog.sandbox) if (Number.isFinite(stars[app.repo])) app.stars = stars[app.repo];

  // 8. Файлы для кнопки «Скачать»: свежие релизы, разобранные по системам и процессорам (scripts/downloads.mjs).
  // Если GitHub не ответил про репозиторий, остаются прежние файлы.
  const dlRules = rules.downloads || {};
  const skipDl = new Set((dlRules.skip || []).map(slug => slug.toLowerCase()));
  const downloads = Object.fromEntries(Object.entries(catalog.downloads || {}).filter(([slug]) => repos.includes(slug) && !skipDl.has(slug.toLowerCase())));
  const dlRepos = repos.filter(slug => !skipDl.has(slug.toLowerCase()));
  for (let i = 0; i < dlRepos.length; i += 10) {
    const chunk = dlRepos.slice(i, i + 10);
    const variables = {};
    const fields = chunk.map((slug, j) => {
      const [owner, name] = slug.split('/');
      variables[`o${j}`] = owner;
      variables[`n${j}`] = name;
      return `r${j}: repository(owner: $o${j}, name: $n${j}) { releases(first: ${dlRules.releases || 10}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { databaseId tagName isDraft isPrerelease isLatest publishedAt url releaseAssets(first: 100) { totalCount nodes { name size downloadUrl digest } } } } }`;
    });
    const query = `query(${chunk.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(', ')}) { ${fields.join(' ')} }`;
    const { data } = await gh('/graphql', { method: 'POST', body: { query, variables }, allow: [401, 403, 502] });
    for (const [j, slug] of chunk.entries()) {
      const releases = data?.data?.[`r${j}`]?.releases?.nodes;
      if (!Array.isArray(releases)) continue;
      const tag = dlRules.tags?.[slug];
      // У VSCodium в релизе под две сотни файлов: дочитываем главный релиз через REST
      const main = releaseOrder(releases, { tag })[0];
      if (main && main.releaseAssets.totalCount > main.releaseAssets.nodes.length) {
        try {
          const assets = await ghAll(`/repos/${slug}/releases/${main.databaseId}/assets`);
          main.releaseAssets.nodes = assets.map(a => ({ name: a.name, size: a.size, downloadUrl: a.browser_download_url, digest: a.digest }));
        } catch (e) {
          console.log(`${slug}: не удалось дочитать файлы релиза: ${e.message}`);
        }
      }
      const picked = pickDownloads(releases, { tag });
      if (Object.keys(picked).length) downloads[slug] = picked;
      else delete downloads[slug];
    }
  }

  // 9. Перенос на главную: проверено временем и звёздами, без жалоб
  for (const app of catalog.sandbox) {
    app.promoted = age(app.addedAt) >= rules.promotion.minDays && app.stars >= rules.promotion.minStars && !hidden.has(app.repo.toLowerCase());
  }

  const next = {
    version: 1,
    updated: catalog.updated || null,
    home: HOME,
    rules: {
      votesNeeded: rules.voting.votesNeeded,
      voteDays: rules.voting.days,
      downvoteWeight: rules.voting.downvoteWeight,
      voterMinAgeDays: rules.voting.voterMinAgeDays,
      topic: rules.repo.requireTopic,
      promotionDays: rules.promotion.minDays,
      promotionStars: rules.promotion.minStars,
      reportsToHide: rules.reports.toHide,
    },
    stars: Object.fromEntries(Object.entries(stars).sort(([a], [b]) => a.localeCompare(b))),
    downloads: Object.fromEntries(Object.entries(downloads).sort(([a], [b]) => a.localeCompare(b))),
    sandbox: catalog.sandbox,
    candidates,
    hidden: catalog.hidden,
  };
  if (JSON.stringify({ ...next, updated: null }) !== before) {
    next.updated = NOW.toISOString();
    await writeFile(`${ROOT}catalog.json`, `${JSON.stringify(next, null, 2)}\n`);
    console.log('catalog.json обновлён');
  } else {
    console.log('catalog.json без изменений');
  }
  console.log(`Запросов к GitHub: ${calls}. В песочнице: ${next.sandbox.length}, на голосовании: ${candidates.length}, скрыто: ${next.hidden.length}, с файлами для скачивания: ${Object.keys(downloads).length}.`);
}

await main();
