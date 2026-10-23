// Робот-разведчик VibeMarket. Раз в неделю ищет на GitHub бесплатные приложения с открытым кодом,
// которых ещё нет в каталоге, и заводит на каждое задачу с меткой scout. В задаче уже заполнены поля
// карточки: название, категория, описание, платформы. Мейнтейнер проверяет их, правит прямо в описании задачи
// и ставит метку approved, после чего робот (scripts/robot.mjs) добавляет приложение в каталог.
// Задача, закрытая без approved, значит «не подходит»: разведчик больше это приложение не предложит.
//
// Что ищем (rules.json → scout): репозитории с темами из списка, не меньше minStars звёзд, с релизом
// не старше releaseWithinDays дней и с открытой лицензией из rules.json → repo.licenses. У приложения должны быть
// готовые файлы для скачивания: их находит тот же разбор релизов, что и кнопка «Скачать» (scripts/downloads.mjs).
//
//   node scripts/scout.mjs             найти и завести задачи
//   node scripts/scout.mjs --dry-run   только показать находки, в GitHub ничего не пишется

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchReleases, pickDownloads, releaseOrder } from './downloads.mjs';
import { FORM_LABELS } from './robot-i18n.mjs';
import { gh, ghAll, hasToken, requestCount } from './github.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.GITHUB_REPOSITORY || 'NickGBar/VibeMarket';
const DRY = process.argv.includes('--dry-run');
const NOW = process.env.ROBOT_NOW ? new Date(process.env.ROBOT_NOW) : new Date(); // ROBOT_NOW нужен только тестам
const DAY = 24 * 3600 * 1000;
const MARK = 'vibemarket-scout';

const rules = JSON.parse(await readFile(`${ROOT}rules.json`, 'utf8'));
const scout = {
  perRun: 5, minStars: 1000, releaseWithinDays: 365, checkLimit: 40, topics: ['desktop-app'], skip: [],
  ...rules.scout,
};

// Категория по темам и описанию репозитория. Мейнтейнер всё равно смотрит её перед одобрением.
const CAT_HINTS = {
  dev: ['editor', 'ide', 'terminal', 'git', 'developer-tools', 'devtools', 'api-client', 'database', 'programming', 'docker', 'kubernetes', 'http-client'],
  design: ['design', 'graphics', 'image-editor', 'drawing', 'painting', 'photo', 'photography', '3d', 'svg', 'vector', 'diagram', 'whiteboard', 'pixel-art', 'animation'],
  work: ['productivity', 'notes', 'note-taking', 'markdown', 'office', 'pdf', 'todo', 'tasks', 'calendar', 'knowledge-base', 'writing', 'email', 'rss', 'reader', 'time-tracking'],
  media: ['video', 'audio', 'music', 'player', 'media', 'podcast', 'streaming', 'video-editor', 'screen-recorder', 'youtube', 'ebook', 'comics', 'manga'],
  privacy: ['privacy', 'security', 'password-manager', 'encryption', 'vpn', 'proxy', 'sync', 'file-sharing', 'backup', 'messenger', 'p2p', 'e2ee', 'firewall', 'adblock'],
  ai: ['ai', 'llm', 'machine-learning', 'chatgpt', 'gpt', 'stable-diffusion', 'llama', 'openai', 'whisper', 'deep-learning', 'ollama', 'chatbot', 'agent', 'claude', 'copilot'],
  games: ['game', 'games', 'gaming', 'emulator', 'game-engine', 'minecraft', 'roguelike', 'launcher'],
};
const CAT_GLYPH = { dev: 'code', design: 'brush', work: 'note', media: 'play', privacy: 'shield', ai: 'sparkle', games: 'gamepad' };
const COLORS = ['blue', 'purple', 'pink', 'orange', 'yellow', 'green', 'teal']; // id из PALETTE, без графитового
const OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux', android: 'Android' };
// Не приложения: списки, шаблоны, библиотеки и фреймворки
const NOT_APP = /\b(awesome|boilerplate|template|starter|sdk|library|framework|bindings?|plugin for)\b/i;

const guessCategory = repo => {
  const words = new Set(String(repo.description || '').toLowerCase().split(/[^a-z0-9-]+/));
  let best = 'work';
  let bestScore = 0;
  for (const [cat, hints] of Object.entries(CAT_HINTS)) {
    const score = hints.reduce((n, h) => n + (repo.topics?.includes(h) ? 2 : 0) + (words.has(h) ? 1 : 0), 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
};
// Название из имени репозитория: clash-verge-rev → Clash Verge Rev, drawio-desktop → Drawio
const prettyName = repoName => {
  const words = repoName.split(/[-_.]+/).filter(Boolean);
  const core = words.length > 1 && /^(desktop|app|gui|client)$/i.test(words[words.length - 1]) ? words.slice(0, -1) : words;
  return core.map(w => (/[A-Z]/.test(repoName) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').slice(0, 40);
};
const colorFor = slug => COLORS[[...slug].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];
// Описание репозитория пишет кто угодно: одна строка (своё поле «### …» не подсунуть),
// без HTML-комментариев (метку разведчика не подделать) и без упоминаний @человека
const oneLine = (text, max) => {
  const line = String(text || '').replace(/<!--|-->/g, '').replace(/@(?=\w)/g, '@\u200b').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,.;:—-]+$/, '')}…`;
};
const fmtDate = date => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

async function change(description, action) {
  if (DRY) { console.log(`[dry-run] ${description}`); return null; }
  console.log(description);
  return action();
}

// Что уже есть: каталог, песочница, находки, голосование и все задачи разведчика, открытые и закрытые
async function knownRepos() {
  const html = await readFile(`${ROOT}index.html`, 'utf8');
  const catalog = JSON.parse(await readFile(`${ROOT}catalog.json`, 'utf8').catch(() => '{}'));
  const known = new Set([
    ...[...html.matchAll(/repo: '([^']+)', stars: \d+, lic:/g)].map(m => m[1]),
    ...(catalog.sandbox || []).map(a => a.repo),
    ...(catalog.picks || []).map(a => a.repo),
    ...(catalog.candidates || []).map(a => a.repo),
    ...scout.skip,
  ].map(r => String(r).toLowerCase()));
  for (const issue of await ghAll(`/repos/${HOME}/issues?state=all&labels=scout`)) {
    const marked = new RegExp(`<!-- ${MARK} (\\{.*?\\}) -->`).exec(issue.body || '')?.[1];
    try { if (marked) known.add(String(JSON.parse(marked).repo).toLowerCase()); } catch { /* испорченная метка */ }
    const field = new RegExp(`### ${FORM_LABELS.ru.repo}\\s+([^\\s]+)`).exec(issue.body || '')?.[1];
    if (field) known.add(field.replace(/^https?:\/\/github\.com\//, '').toLowerCase());
  }
  return known;
}

async function search(known) {
  const found = new Map();
  for (const topic of scout.topics) {
    const q = `topic:${topic} stars:>=${scout.minStars} archived:false fork:false is:public`;
    const { data } = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`, { allow: [403, 422] });
    for (const repo of data?.items || []) {
      const slug = repo.full_name;
      if (found.has(slug) || known.has(slug.toLowerCase())) continue;
      if (repo.archived || repo.fork || !repo.description || NOT_APP.test(repo.description)) continue;
      if (!rules.repo.licenses.includes(repo.license?.spdx_id)) continue;
      found.set(slug, repo);
    }
  }
  return [...found.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);
}

// Свежий релиз с готовыми файлами: иначе кнопке «Скачать» нечего отдать
async function withFiles(repos) {
  const list = repos.slice(0, scout.checkLimit);
  const releases = await fetchReleases(list.map(r => r.full_name), { count: 5 });
  const out = [];
  for (const repo of list) {
    const rel = releases.get(repo.full_name);
    const latest = releaseOrder(rel)[0];
    if (!latest || (NOW - new Date(latest.publishedAt)) / DAY > scout.releaseWithinDays) continue;
    const files = pickDownloads(rel);
    if (!Object.keys(files).length) continue;
    out.push({ repo, latest, files });
    if (out.length >= scout.perRun) break;
  }
  return out;
}

function issueFor({ repo, latest, files }) {
  const L = FORM_LABELS.ru;
  const cat = guessCategory(repo);
  const name = prettyName(repo.name);
  const platforms = Object.keys(OS_LABEL).filter(os => files[os]).map(os => OS_LABEL[os]);
  const fileList = Object.keys(OS_LABEL).filter(os => files[os]).map(os => `${OS_LABEL[os]}: \`${files[os].files[0].name}\``).join('<br>');
  const field = (label, value) => `### ${label}\n\n${value}`;
  const body = [
    'Разведчик нашёл приложение, которое подходит под правила каталога.',
    '',
    'Проверьте поля ниже и поправьте их прямо в описании задачи: название разведчик собирает из имени репозитория, а категорию угадывает по темам и описанию. Чтобы добавить приложение на главную, поставьте метку `approved`. Если не подходит, просто закройте задачу: разведчик больше его не предложит.',
    '',
    '| | |',
    '|---|---|',
    `| Репозиторий | [${repo.full_name}](https://github.com/${repo.full_name}) |`,
    `| Звёзды | ${repo.stargazers_count.toLocaleString('ru-RU')} |`,
    `| Лицензия | ${repo.license.spdx_id} |`,
    `| Последний релиз | [${latest.tagName}](${latest.url}), ${fmtDate(latest.publishedAt)} |`,
    `| Файлы для «Скачать» | ${fileList} |`,
    repo.topics?.length ? `| Темы | ${repo.topics.slice(0, 12).join(', ')} |` : '',
    /^https?:\/\/[^\s|<>]+$/.test(repo.homepage || '') ? `| Сайт | ${repo.homepage} |` : '',
    '',
    field(L.repo, repo.full_name),
    field(L.name, name),
    field(L.category, cat),
    field(L.desc, oneLine(repo.description, 90)),
    field(L.about, oneLine(repo.description, 600)),
    field(L.platforms, platforms.join(', ')),
    field(L.glyph, CAT_GLYPH[cat]),
    field(L.color, colorFor(repo.full_name)),
    '',
    `<!-- ${MARK} ${JSON.stringify({ repo: repo.full_name, stars: repo.stargazers_count })} -->`,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  return { title: `Находка: ${name} (${repo.full_name})`, body, cat, platforms };
}

async function main() {
  if (!hasToken) console.warn('Нет GITHUB_TOKEN: поиск GitHub без токена сильно ограничен.');
  const known = await knownRepos();
  const repos = await search(known);
  const picks = await withFiles(repos);
  if (!picks.length) {
    console.log(`Новых находок нет. Просмотрено репозиториев: ${repos.length}, запросов к GitHub: ${requestCount()}.`);
    return;
  }
  if (!DRY) {
    const labels = new Set((await ghAll(`/repos/${HOME}/labels`)).map(l => l.name));
    if (!labels.has('scout')) await gh(`/repos/${HOME}/labels`, { method: 'POST', body: { name: 'scout', color: '5E5CE6', description: 'Находка робота-разведчика' } });
  }
  for (const pick of picks) {
    const issue = issueFor(pick);
    console.log(`${pick.repo.full_name} · ★ ${pick.repo.stargazers_count} · ${issue.cat} · ${issue.platforms.join(', ')} · ${pick.latest.tagName} от ${fmtDate(pick.latest.publishedAt)}\n    ${oneLine(pick.repo.description, 200)}`);
    await change(`задача: ${issue.title}`, () => gh(`/repos/${HOME}/issues`, { method: 'POST', body: { title: issue.title, body: issue.body, labels: ['scout'] } }));
  }
  console.log(`Находок: ${picks.length}. Просмотрено репозиториев: ${repos.length}, запросов к GitHub: ${requestCount()}.`);
}

await main();
