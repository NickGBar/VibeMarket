#!/usr/bin/env node
// MCP-сервер VibeMarket. Даёт ИИ-агентам (Claude Code, Claude Desktop, Cursor и другим) искать по каталогу,
// подбирать бесплатную замену платным программам и скачивать нужный файл для этого компьютера с проверкой SHA-256.
// Работает у пользователя на компьютере через stdio, без зависимостей, и читает apps.json с сайта VibeMarket.
//
//   claude mcp add vibemarket -- npx -y github:NickGBar/VibeMarket
//
// Установщики сервер не запускает: он только скачивает и проверяет файл, установку делает человек.
//
// VIBEMARKET_URL             адрес сайта, по умолчанию https://nickgbar.github.io/VibeMarket/
// VIBEMARKET_DATA            локальный apps.json вместо сайта: для разработки и тестов
// VIBEMARKET_DOWNLOAD_ORIGIN откуда разрешено скачивать, по умолчанию https://github.com/; подменяют только тесты

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pickFile } from './downloads.mjs';

const VERSION = '0.1.0';
const SITE = (process.env.VIBEMARKET_URL || 'https://nickgbar.github.io/VibeMarket/').replace(/\/?$/, '/');
const DATA = process.env.VIBEMARKET_DATA || '';
const ORIGIN = (process.env.VIBEMARKET_DOWNLOAD_ORIGIN || 'https://github.com/').replace(/\/?$/, '/');
const LANGS = ['ru', 'en', 'es', 'zh'];
const OS_NAMES = { mac: 'macOS', win: 'Windows', linux: 'Linux', android: 'Android' };
const PLATFORMS = { macos: 'macOS', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS', web: 'Web' };
// Этот компьютер: система и процессор известны точно, без догадок, как в браузере
const HERE = {
  os: { darwin: 'mac', win32: 'win', linux: 'linux', android: 'android' }[process.platform] || null,
  arch: { arm64: 'arm64', x64: 'x64', ia32: 'x86' }[process.arch] || null,
};
const log = (...args) => console.error('[vibemarket]', ...args);

/* ---------- Каталог ---------- */

let cache = null;
async function fetchOk(url) {
  const res = await fetch(url, { headers: { 'User-Agent': `vibemarket-mcp/${VERSION}` } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}
// apps.json обновляется вместе с сайтом, поэтому держим его час и потом перечитываем
async function catalog() {
  if (cache && Date.now() - cache.at < 3600e3) return cache.data;
  const text = DATA ? await readFile(DATA, 'utf8') : await (await fetchOk(`${SITE}apps.json`)).text();
  const data = JSON.parse(text);
  if (data.version !== 1 || !Array.isArray(data.apps)) throw new Error('apps.json: unknown format');
  cache = { at: Date.now(), data };
  return data;
}

const norm = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е');
const termsOf = query => norm(query).split(/[^\p{L}\p{N}+#]+/u).filter(term => term.length > 1);
const langOf = lang => (LANGS.includes(lang) ? lang : 'en');

// Чем больше слов запроса совпало и чем важнее поле, тем выше приложение. При равенстве решают звёзды.
function score(app, terms, data) {
  const category = data.categories.find(c => c.id === app.category);
  const fields = [
    [10, app.name], [9, app.replaces.join(' ')], [6, `${app.id} ${app.repo}`],
    [4, Object.values(app.description).join(' ')], [3, Object.values(category?.name || {}).join(' ')], [2, Object.values(app.about).join(' ')],
  ].map(([weight, text]) => [weight, norm(text)]);
  let total = 0, matched = 0;
  for (const term of terms) {
    const best = Math.max(0, ...fields.filter(([, text]) => text.includes(term)).map(([weight]) => weight));
    if (best) { total += best; matched++; }
  }
  return matched ? (total * matched) / terms.length : 0;
}

const onPlatform = (app, platform) => !platform || app.platforms.includes(PLATFORMS[norm(platform)] || platform);
const downloadableHere = app => Boolean(HERE.os && pickFile(app.downloads?.[HERE.os], HERE.os, HERE.arch));

function resolveApp(data, query) {
  const q = norm(query);
  return data.apps.find(a => a.id === q) || data.apps.find(a => norm(a.name) === q)
    || data.apps.map(a => [a, score(a, termsOf(query), data)]).filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1] || y[0].stars - x[0].stars)[0]?.[0];
}

/* ---------- Ответы ---------- */

const brief = (app, lang, data) => ({
  id: app.id,
  name: app.name,
  description: app.description[lang],
  category: data.categories.find(c => c.id === app.category)?.name[lang] || app.category,
  license: app.license,
  stars: app.stars,
  platforms: app.platforms,
  replaces: app.replaces,
  page: app.page[lang],
  downloadForThisComputer: downloadableHere(app),
  worksWithAgents: Boolean(app.agent),
  thirdParty: app.thirdParty,
});
const line = b => `- **${b.name}** (id: ${b.id}): ${b.description} ${b.category} · ${b.license} · ★ ${b.stars.toLocaleString('en-US')} · ${b.platforms.join(', ') || 'see page'}`
  + `${b.replaces.length ? ` · replaces ${b.replaces.join(', ')}` : ''}${b.thirdParty ? ' · third-party sandbox app, not vetted' : ''}`
  + `${b.worksWithAgents ? ' · works with AI agents: has its own MCP server' : ''}${b.downloadForThisComputer ? ' · one-click download for this computer' : ''}\n  ${b.page}`;
const reply = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured && { structuredContent: structured }) });
const failure = text => ({ content: [{ type: 'text', text }], isError: true });
const list = (title, apps, lang, data) => {
  const items = apps.map(a => brief(a, lang, data));
  return reply(items.length ? `${title}\n\n${items.map(line).join('\n')}` : `${title}\n\nNothing found.`, { apps: items });
};

/* ---------- Скачивание ---------- */

const HINTS = {
  dmg: 'Open the .dmg and drag the app to Applications. If macOS blocks the first launch, allow it in System Settings → Privacy & Security.',
  pkg: 'Open the .pkg to run the installer.',
  exe: 'Run the installer.', msi: 'Run the .msi installer.', msix: 'Open the .msix package to install it.',
  appimage: 'Make it executable (chmod +x) and run it.', run: 'Make it executable (chmod +x) and run it.',
  deb: 'Install it with: sudo apt install ./FILE', rpm: 'Install it with: sudo dnf install ./FILE', flatpak: 'Install it with: flatpak install ./FILE',
  apk: 'Copy it to the Android device and open it there; Android will ask to allow installs from this source.',
  zip: 'Unpack the archive and run the app inside.', tar: 'Unpack the archive and run the app inside.', '7z': 'Unpack the archive and run the app inside.',
};
const expandHome = path => path.replace(/^~(?=$|[/\\])/, homedir());
const defaultDir = () => (existsSync(join(homedir(), 'Downloads')) ? join(homedir(), 'Downloads') : homedir());
// Не перезаписываем чужие файлы: Zed.dmg → Zed (2).dmg
function freePath(dir, name) {
  const ext = name.toLowerCase().endsWith('.tar.gz') ? '.tar.gz' : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let path = join(dir, name);
  for (let n = 2; existsSync(path) || existsSync(`${path}.part`); n++) path = join(dir, `${stem} (${n})${ext}`);
  return path;
}
const mb = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function download(args) {
  const data = await catalog();
  const app = resolveApp(data, args.app || '');
  if (!app) return failure(`No app matches "${args.app}". Try search_apps first.`);
  const os = args.platform || HERE.os;
  const arch = args.arch || (os === HERE.os ? HERE.arch : null);
  const release = app.downloads?.[os];
  const file = pickFile(release, os, arch);
  if (!file) {
    const where = app.links.web ? `It runs in the browser: ${app.links.web}` : app.links.site ? `The project offers downloads on its website: ${app.links.site}`
      : `See the repository: ${app.links.repo}`;
    return reply(`${app.name} has no ready-made file for ${OS_NAMES[os] || os || 'this system'} in its GitHub releases. ${where}`);
  }
  // Как и на странице: только релизы того же репозитория, даже если apps.json подменили
  const prefix = `${ORIGIN}${app.repo}/releases/download/`.toLowerCase();
  if (!file.url.toLowerCase().startsWith(prefix) || /["'<>\s]/.test(file.url)) return failure(`Refusing to download ${file.url}: it is not a release of ${app.repo}.`);
  const name = file.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '') || `${app.id}-download`;
  const dir = resolve(args.directory ? expandHome(args.directory) : defaultDir());
  await mkdir(dir, { recursive: true });
  const target = freePath(dir, name);
  const part = `${target}.part`;
  log(`downloading ${file.url} → ${target}`);
  const res = await fetchOk(file.url);
  const hash = createHash('sha256');
  let size = 0;
  const out = createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      size += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((ok, fail) => out.end(err => (err ? fail(err) : ok())));
  } catch (e) {
    out.destroy();
    await rm(part, { force: true });
    throw e;
  }
  const digest = hash.digest('hex');
  if (file.sha256 && digest !== file.sha256) {
    await rm(part, { force: true });
    return failure(`Checksum mismatch for ${file.name}: expected SHA-256 ${file.sha256}, got ${digest}. The file was deleted.`);
  }
  await rename(part, target);
  const hint = (HINTS[file.kind] || 'Open the file to install the app.').replace('FILE', target.split(/[/\\]/).pop());
  const result = { app: app.id, file: target, size, version: release.tag, sha256: digest, verified: Boolean(file.sha256), platform: os, arch: file.arch };
  return reply([
    `Downloaded ${app.name} ${release.tag} for ${OS_NAMES[os] || os}: ${target} (${mb(size)}).`,
    file.sha256 ? `SHA-256 matches the checksum GitHub published for the release: ${digest}.` : `GitHub published no checksum for this file. SHA-256: ${digest}.`,
    `To install: ${hint}`,
    'Nothing was installed or run. Ask the user before opening the installer.',
  ].join('\n'), result);
}

// Как подключить MCP-сервер самого приложения: пусть агент предложит это человеку
function agentLines(app) {
  const a = app.agent;
  if (!a) return [];
  return [
    'Works with AI agents: the app has its own MCP server from its authors.',
    a.warn ? 'Warning: this gives the agent access to the user\'s password vault. Only connect it if the user explicitly wants that.' : '',
    a.install ? `Install the server: ${a.install}` : '',
    a.cliFor ? `Needs the ${a.cli.split(' ')[0]} command-line tool from the app's GitHub release (builds exist for ${a.cliFor.map(os => OS_NAMES[os] || os).join(', ')}).` : '',
    a.claudeCode ? `Connect in Claude Code: ${a.claudeCode}` : a.guide ? `Setup takes a few steps; it starts with: ${a.guide}` : '',
    a.url ? `Remote server URL: ${a.url}` : '',
    a.docs ? `Authors' guide: ${a.docs}` : '',
    'Adding an MCP server changes the user\'s agent configuration: ask before doing it.',
  ].filter(Boolean);
}

/* ---------- Инструменты ---------- */

const langProp = { type: 'string', enum: LANGS, description: 'Language of app descriptions: ru, en, es or zh. Default en.' };
const platformProp = { type: 'string', enum: Object.keys(PLATFORMS), description: 'Only apps for this platform.' };
const limitProp = { type: 'integer', minimum: 1, maximum: 50, description: 'How many apps to return. Default 10.' };
const readOnly = { readOnlyHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'search_apps',
    title: 'Search VibeMarket',
    description: 'Search the VibeMarket catalog of free, open-source apps with no ads or trackers by keywords, category, platform or collection. Categories: dev, design, work, media, privacy, ai, games. Collections: adobe, google, microsoft, subs, agents. Set agent to true for apps that ship their own MCP server, so an agent can work inside them.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords, e.g. "photo editor" or "password manager".' }, category: { type: 'string' }, platform: platformProp, collection: { type: 'string' }, agent: { type: 'boolean', description: 'Only apps with their own MCP server from the authors.' }, lang: langProp, limit: limitProp } },
    annotations: readOnly,
    async run(args) {
      const data = await catalog();
      const lang = langOf(args.lang);
      const terms = termsOf(args.query || '');
      const collection = args.collection && data.collections.find(c => c.id === norm(args.collection));
      let apps = data.apps.filter(a => (!args.category || a.category === args.category) && onPlatform(a, args.platform) && (!collection || collection.apps.includes(a.id)) && (!args.agent || a.agent));
      apps = terms.length
        ? apps.map(a => [a, score(a, terms, data)]).filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1] || y[0].stars - x[0].stars).map(([a]) => a)
        : apps.sort((x, y) => y.stars - x.stars);
      return list(`VibeMarket: ${apps.length} match${apps.length === 1 ? '' : 'es'}.`, apps.slice(0, args.limit || 10), lang, data);
    },
  },
  {
    name: 'find_alternative',
    title: 'Find a free alternative',
    description: 'Find free, open-source replacements for a paid or proprietary product such as Photoshop, Notion, Slack, Google Photos or Microsoft Office.',
    inputSchema: { type: 'object', properties: { product: { type: 'string', description: 'The product to replace, e.g. "Photoshop" or "Notion".' }, platform: platformProp, lang: langProp, limit: limitProp }, required: ['product'] },
    annotations: readOnly,
    async run(args) {
      const data = await catalog();
      const lang = langOf(args.lang);
      const q = norm(args.product);
      const direct = data.apps.filter(a => onPlatform(a, args.platform) && a.replaces.some(r => norm(r).includes(q) || q.includes(norm(r))));
      if (direct.length) {
        const apps = direct.sort((x, y) => y.stars - x.stars).slice(0, args.limit || 10);
        return list(`Free, open-source replacements for ${args.product}:`, apps, lang, data);
      }
      const apps = data.apps.filter(a => onPlatform(a, args.platform)).map(a => [a, score(a, termsOf(args.product), data)]).filter(([, s]) => s > 0)
        .sort((x, y) => y[1] - x[1] || y[0].stars - x[0].stars).map(([a]) => a).slice(0, args.limit || 5);
      return list(`VibeMarket has no curated replacement for ${args.product}. Closest matches by keywords:`, apps, lang, data);
    },
  },
  {
    name: 'get_app',
    title: 'App details',
    description: 'Full details about one app: description, platforms, license, stars, what it replaces, links and the files available for download with sizes and SHA-256.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App id or name, e.g. "zed" or "Zed".' }, lang: langProp }, required: ['app'] },
    annotations: readOnly,
    async run(args) {
      const data = await catalog();
      const lang = langOf(args.lang);
      const app = resolveApp(data, args.app);
      if (!app) return failure(`No app matches "${args.app}". Try search_apps.`);
      const b = brief(app, lang, data);
      const files = Object.entries(app.downloads || {}).map(([os, rel]) => `${OS_NAMES[os] || os} (${rel.tag}): ${rel.files.map(f => `${f.name} [${f.arch}, ${mb(f.size)}]`).join(', ')}`);
      const text = [
        `**${app.name}** (id: ${app.id}), ${b.category}, ${app.license}, ★ ${app.stars.toLocaleString('en-US')}`,
        app.about[lang],
        `Platforms: ${app.platforms.join(', ') || 'see page'}.${app.replaces.length ? ` Replaces: ${app.replaces.join(', ')}.` : ''}`,
        app.thirdParty ? 'Third-party sandbox app: published by community vote, not vetted by the maintainer.' : '',
        `Page: ${app.page[lang]}`, `Repository: ${app.links.repo}`, app.links.web ? `Web version: ${app.links.web}` : '', app.links.site ? `Website: ${app.links.site}` : '',
        files.length ? `Files:\n${files.map(f => `- ${f}`).join('\n')}` : 'No ready-made files in GitHub releases.',
        b.downloadForThisComputer ? 'download_app can fetch the right file for this computer.' : '',
        ...agentLines(app),
      ].filter(Boolean).join('\n');
      return reply(text, { ...b, about: app.about[lang], links: app.links, downloads: app.downloads, screenshots: (app.screenshots || []).map(x => x.url) });
    },
  },
  {
    name: 'recent_updates',
    title: 'Fresh releases',
    description: 'Apps in the catalog that published a new release recently, newest first.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'Look back this many days. Default 14.' }, lang: langProp, limit: limitProp } },
    annotations: readOnly,
    async run(args) {
      const data = await catalog();
      const lang = langOf(args.lang);
      const since = Date.now() - (args.days || 14) * 864e5;
      const fresh = data.apps.flatMap(app => {
        const rel = Object.values(app.downloads || {}).filter(r => r.date).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
        return rel && Date.parse(rel.date) >= since ? [{ app, rel }] : [];
      }).sort((a, b) => Date.parse(b.rel.date) - Date.parse(a.rel.date)).slice(0, args.limit || 10);
      const items = fresh.map(({ app, rel }) => ({ ...brief(app, lang, data), version: rel.tag, released: rel.date }));
      const text = items.length ? items.map(i => `- **${i.name}** ${i.version}, ${i.released.slice(0, 10)}: ${i.description}\n  ${i.page}`).join('\n') : 'No new releases in this period.';
      return reply(`Releases in the last ${args.days || 14} days:\n\n${text}`, { apps: items });
    },
  },
  {
    name: 'list_collections',
    title: 'Collections and categories',
    description: 'The curated collections (Instead of Adobe, Google, Microsoft, subscriptions; Works with AI agents) and categories of the catalog, with the apps in each collection.',
    inputSchema: { type: 'object', properties: { lang: langProp } },
    annotations: readOnly,
    async run(args) {
      const data = await catalog();
      const lang = langOf(args.lang);
      const name = id => data.apps.find(a => a.id === id)?.name || id;
      const text = [
        ...data.collections.map(c => `**${c.title[lang]}** (collection: ${c.id}): ${c.apps.map(name).join(', ')}`),
        '', `Categories: ${data.categories.map(c => `${c.name[lang]} (${c.id})`).join(', ')}.`,
        `Catalog updated ${data.updated || 'unknown'}, ${data.apps.length} apps. Site: ${data.site}`,
      ].join('\n');
      return reply(text, { collections: data.collections, categories: data.categories });
    },
  },
  {
    name: 'download_app',
    title: 'Download an app',
    description: 'Download the right installer of an app for this computer (or a given platform) straight from its GitHub release and verify its SHA-256. Saves to the Downloads folder by default. Does not install or run anything.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id or name.' },
        platform: { type: 'string', enum: Object.keys(OS_NAMES), description: `Target system. Default: this computer (${HERE.os || 'unknown'}).` },
        arch: { type: 'string', enum: ['arm64', 'x64', 'x86'], description: `Processor. Default: this computer (${HERE.arch || 'unknown'}).` },
        directory: { type: 'string', description: 'Folder to save to. Default: ~/Downloads.' },
      },
      required: ['app'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: download,
  },
];

/* ---------- MCP поверх stdio ---------- */

const INSTRUCTIONS = 'VibeMarket is a curated catalog of free, open-source apps with no ads or trackers. Use find_alternative when the user wants a free replacement for a paid or proprietary product, search_apps for other questions, get_app for details and download_app to fetch the right installer for this computer. download_app only downloads and verifies the file: never open or run an installer without asking the user. Apps marked as third-party come from the community sandbox and are not vetted.';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const rpcError = (code, message) => Object.assign(new Error(message), { code });

async function handle(msg) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return {
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(requested || '') ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vibemarket', title: 'VibeMarket', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === msg.params?.name);
      if (!tool) throw rpcError(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        return await tool.run(msg.params.arguments || {});
      } catch (e) {
        log(`${tool.name}: ${e.message}`);
        return failure(`Error: ${e.message}`);
      }
    }
    default: throw rpcError(-32601, `Method not found: ${msg.method}`);
  }
}

const pending = new Set();
async function receive(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return; // ответы клиента и мусор
  if (msg.id === undefined || msg.id === null) return; // уведомления: initialized, cancelled
  try {
    send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', text => {
  if (!text.trim()) return;
  let msg;
  try { msg = JSON.parse(text); } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  for (const one of Array.isArray(msg) ? msg : [msg]) {
    const job = receive(one);
    pending.add(job);
    job.finally(() => pending.delete(job));
  }
});
// Клиент закрыл ввод: отвечаем на начатые запросы и выходим
input.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
log(`ready: ${DATA || `${SITE}apps.json`}, this computer: ${HERE.os || process.platform}/${HERE.arch || process.arch}`);
