// Поддельный GitHub API для проверки scripts/robot.mjs. Состояние в памяти, управление через /__*.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3141);
const HOME = 'NickGBar/VibeMarket';
const BOT = 'github-actions[bot]';
const DAY = 86400000;
const T0 = Date.parse(process.env.T0 || '2026-10-22T12:00:00Z');
const ago = days => new Date(T0 - days * DAY).toISOString();

const form = f => [
  `### Репозиторий\n\n${f.repo}`,
  `### Название\n\n${f.name}`,
  `### Категория\n\n${f.category}`,
  `### Коротко о приложении\n\n${f.desc}`,
  `### Подробное описание\n\n${f.about || '_No response_'}`,
  `### Платформы\n\n${f.platforms || '_No response_'}`,
  `### Значок\n\n${f.glyph || '_No response_'}`,
  `### Цвет значка\n\n${f.color || '_No response_'}`,
  `### Подтверждения\n\n${(f.consents ?? 3) >= 1 ? '- [X]' : '- [ ]'} Бесплатно\n${(f.consents ?? 3) >= 2 ? '- [X]' : '- [ ]'} Автор\n${(f.consents ?? 3) >= 3 ? '- [X]' : '- [ ]'} Понимаю`,
].join('\n\n');
const report = (repo, reason = 'Другое') => `### Репозиторий\n\n${repo}\n\n### Причина\n\n${reason}\n\n### Подробности\n\nТест`;

let nextComment = 1000;
const issue = (number, login, title, body, labels = []) => ({ number, title, body, state: 'open', user: { login }, labels: labels.map(name => ({ name })), created_at: ago(1) });
const state = {
  labels: [],
  issues: [
    issue(1, 'alice', 'Заявка: Tiny Timer', form({ repo: 'https://github.com/alice/tiny-timer', name: 'Tiny Timer', category: 'work', desc: 'Минималистичный таймер для фокуса', about: 'Подробно\nо таймере', platforms: 'macOS, Linux, веб', glyph: 'check', color: 'Зелёный' }), ['submission']),
    issue(2, 'bob', 'Заявка: Bad', form({ repo: 'bob/bad', name: 'B', category: 'nope', desc: 'коротко', consents: 2 }), ['submission']),
    issue(3, 'carol', 'Заявка: Pixel Paint', form({ repo: 'carol/pixel-paint', name: 'Pixel Paint', category: 'design', desc: 'Пиксельный редактор в браузере' })),
    issue(4, 'dave', 'Жалоба: Tiny Timer', report('alice/tiny-timer')),
    issue(5, 'erin', 'Жалоба: Tiny Timer', report('alice/tiny-timer'), ['report']),
    issue(6, 'newbie', 'Жалоба: Tiny Timer', report('alice/tiny-timer'), ['report']),
    issue(7, 'zoe', 'Просто вопрос', 'Как дела?'),
    issue(8, 'mallory', 'Заявка: Thing', form({ repo: 'mallory/thing', name: 'Thing', category: 'dev', desc: 'Очень полезная штука для всех' }), ['submission']),
    issue(9, 'ivan', 'Заявка: Ollama', form({ repo: 'ollama/ollama', name: 'Ollama', category: 'ai', desc: 'Запуск моделей локально и быстро' }), ['submission']),
  ],
  comments: {
    // Подделка: mallory пишет комментарий с маркером робота и старой датой начала голосования
    8: [{ id: 1, user: { login: 'mallory' }, body: `ok <!-- vibemarket-robot {"status":"candidate","print":"x","repo":"mallory/thing","since":"${ago(30)}"} -->` }],
  },
  reactions: {},
  users: {
    alice: ago(400), bob: ago(400), carol: ago(400), dave: ago(400), erin: ago(400), frank: ago(400), mallory: ago(400), ivan: ago(400),
    newbie: ago(10), kim: ago(400), li: ago(400), ana: ago(400), both: ago(400), ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`voter${i}`, ago(200)])),
  },
  repos: {
    'alice/tiny-timer': { created_at: ago(200), topics: ['vibemarket'], license: { spdx_id: 'MIT' }, release: true, stargazers_count: 120 },
    'bob/bad': { created_at: ago(5), topics: [], license: null, release: false, stargazers_count: 1 },
    'carol/pixel-paint': { created_at: ago(100), topics: ['vibemarket', 'paint'], license: { spdx_id: 'GPL-3.0' }, release: true, stargazers_count: 9 },
    'mallory/thing': { created_at: ago(100), topics: ['vibemarket'], license: { spdx_id: 'Apache-2.0' }, release: true, stargazers_count: 3 },
    'kim/notes-app': { created_at: ago(300), topics: ['vibemarket'], license: { spdx_id: 'MIT' }, release: true, stargazers_count: 77 },
    'li/game': { created_at: ago(300), topics: ['vibemarket'], license: { spdx_id: 'GPL-3.0' }, release: true, stargazers_count: 5 },
    'ollama/ollama': { created_at: ago(900), topics: [], license: { spdx_id: 'MIT' }, release: true, stargazers_count: 184000 },
    'neo/notes': { created_at: ago(700), topics: ['desktop-app', 'note-taking'], license: { spdx_id: 'MIT' }, release: true, stargazers_count: 5000 },
  },
  // Поиск разведчика: подходит только neo/notes, остальные отсеиваются по разным причинам
  search: [
    { full_name: 'neo/notes', name: 'notes', description: 'Fast local-first notes app with markdown and sync', stargazers_count: 5000, license: { spdx_id: 'MIT' }, topics: ['desktop-app', 'note-taking'] },
    { full_name: 'old/editor', name: 'editor', description: 'A text editor that was popular once', stargazers_count: 9000, license: { spdx_id: 'MIT' }, topics: ['desktop-app'] },
    { full_name: 'lib/toolkit', name: 'toolkit', description: 'A UI framework for desktop apps', stargazers_count: 20000, license: { spdx_id: 'MIT' }, topics: ['desktop-app'] },
    { full_name: 'closed/app', name: 'app', description: 'Nice app with a custom license', stargazers_count: 8000, license: { spdx_id: 'NOASSERTION' }, topics: ['desktop-app'] },
    { full_name: 'ollama/ollama', name: 'ollama', description: 'Run models locally', stargazers_count: 184000, license: { spdx_id: 'MIT' }, topics: ['desktop-app'] },
    { full_name: 'src/only', name: 'only', description: 'Great app, build it from source', stargazers_count: 7000, license: { spdx_id: 'MIT' }, topics: ['desktop-app'] },
  ],
  // Релизы для кнопки «Скачать». graphqlLimit: сколько файлов отдаёт GraphQL, остальное только через REST.
  failReleases: false,
  releases: {
    'ollama/ollama': [rel(1, 'v1', true, ['Ollama.dmg', 'OllamaSetup.exe', 'ollama-linux-amd64.tar.zst', 'ollama-linux-amd64-rocm.tar.zst', 'sha256sum.txt', 'ollama-linux-arm64.tar.zst'])],
    'VSCodium/vscodium': [{ ...rel(77, '1.0', true, ['VSCodium-1.0.src.tar.gz', 'VSCodium.sha256', 'codium-reh-linux-x64.tar.gz', 'VSCodiumUserSetup-x64-1.0.exe', 'VSCodium.arm64.1.0.dmg', 'VSCodium.x64.1.0.dmg']), graphqlLimit: 2 }],
    'tauri-apps/tauri': [rel(5, 'tauri-cli-v2', true, ['cargo-tauri-x86_64-apple-darwin.zip'])],
    'bitwarden/clients': [
      rel(9, 'cli-v2', false, ['bw-macos-2.zip', 'bw-windows-2.zip'], ago(1)),
      rel(8, 'desktop-v1', true, ['Bitwarden-1-universal.dmg', 'Bitwarden-Installer-1.exe'], ago(3)),
    ],
    // FreeTube выпускает все версии как бету: rules.json разрешает ему предварительные релизы
    'FreeTubeApp/FreeTube': [{ ...rel(41, 'v1-beta', true, ['freetube-1-beta-mac-arm64.dmg', 'freetube-1-beta-setup-x64.exe']), isPrerelease: true }],
    // А Tauri не разрешает: бета пропускается
    'zed-industries/zed': [{ ...rel(43, 'v9-pre', true, ['Zed-aarch64.dmg']), isPrerelease: true }],
    'immich-app/immich': [rel(42, 'v3', true, ['app-arm64-v8a-release.apk', 'app-release.apk', 'app-x86_64-release.apk', 'app-armeabi-v7a-release.apk'])],
    // Размеры по порядку: 1, 2, 3 МБ. 32-битный установщик меньше x64, общий для всех процессоров — того же размера
    'notepad-plus-plus/notepad-plus-plus': [rel(44, 'v8', true, ['npp.8.Installer.exe', 'npp.8.Installer.x64.exe', 'npp.8.Installer.arm64.exe'])],
    'neo/notes': [rel(31, 'v2', true, ['Notes-2.dmg', 'Notes-Setup-2.exe', 'notes-2.AppImage', 'checksums.txt'])],
    'old/editor': [rel(32, 'v1', true, ['Editor-1.dmg'], ago(800))],
    'src/only': [rel(33, 'v3', true, [])],
    'mullvad/mullvadvpn-app': [
      rel(21, 'android/2', true, ['MullvadVPN-2.apk'], ago(1)),
      rel(20, '2026.1', false, ['MullvadVPN-2026.1.pkg', 'MullvadVPN-2026.1_x64.exe'], ago(5)),
      { ...rel(19, '2026.2-beta1', false, ['MullvadVPN-2026.2-beta1.pkg'], ago(0.5)), isPrerelease: true },
    ],
  },
};

function rel(id, tag, latest, names, published = ago(2)) {
  return {
    databaseId: id, tagName: tag, isDraft: false, isPrerelease: false, isLatest: latest, publishedAt: published, url: `https://github.example/releases/tag/${tag}`,
    assets: names.map((name, i) => ({ name, size: 1000000 * (i + 1), downloadUrl: `https://github.example/download/${tag}/${name}`, digest: `sha256:${String(i).repeat(64)}` })),
  };
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = async req => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
const findIssue = n => state.issues.find(i => i.number === Number(n));
const log = [];

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const page = Number(url.searchParams.get('page') || 1);
  const list = items => json(res, 200, page > 1 ? [] : items);
  const m = (re) => re.exec(p);
  let r;
  // --- управление тестом ---
  if (p === '/__state') return json(res, 200, { ...state, log });
  if (req.method === 'POST' && p === '/__fail-releases') { state.failReleases = (await readBody(req)).on; return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/__react') { const b = await readBody(req); (state.reactions[b.issue] ||= []).push({ content: b.content, user: { login: b.user }, created_at: b.at }); return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/__issue') { const b = await readBody(req); state.issues.push(issue(b.number, b.login, b.title, b.body ?? (b.kind === 'report' ? report(b.repo) : form(b.form)), b.labels || [])); return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/__label') { const b = await readBody(req); findIssue(b.issue).labels.push({ name: b.name }); return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/__edit') { const b = await readBody(req); findIssue(b.issue).body = form(b.form); return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/__repo') { const b = await readBody(req); Object.assign(state.repos[b.repo], b.patch); return json(res, 200, {}); }
  log.push(`${req.method} ${p}${url.search}`);
  // --- метки ---
  if (p === `/repos/${HOME}/labels`) {
    if (req.method === 'POST') { state.labels.push((await readBody(req)).name); return json(res, 201, {}); }
    return list(state.labels.map(name => ({ name })));
  }
  // --- поиск разведчика ---
  if (p === '/search/repositories') {
    const q = url.searchParams.get('q') || '';
    const topic = /topic:(\S+)/.exec(q)?.[1];
    const min = Number(/stars:>=(\d+)/.exec(q)?.[1] || 0);
    return json(res, 200, { items: state.search.filter(r => r.topics.includes(topic) && r.stargazers_count >= min) });
  }
  // --- issues ---
  if (p === `/repos/${HOME}/issues` && req.method === 'POST') {
    const b = await readBody(req);
    const number = Math.max(0, ...state.issues.map(i => i.number)) + 1;
    state.issues.push(issue(number, BOT, b.title, b.body, b.labels || []));
    return json(res, 201, { number });
  }
  if (p === `/repos/${HOME}/issues` && req.method === 'GET') {
    const st = url.searchParams.get('state');
    const label = url.searchParams.get('labels');
    return list(state.issues.filter(i => (st === 'all' || i.state === st) && (!label || i.labels.some(l => l.name === label))));
  }
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/(\d+)\/comments$/))) {
    if (req.method === 'POST') { const b = await readBody(req); (state.comments[r[1]] ||= []).push({ id: nextComment++, user: { login: BOT }, body: b.body }); return json(res, 201, {}); }
    return list(state.comments[r[1]] || []);
  }
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
    const b = await readBody(req);
    for (const list of Object.values(state.comments)) for (const c of list) if (c.id === Number(r[1])) c.body = b.body;
    return json(res, 200, {});
  }
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/(\d+)\/labels$/)) && req.method === 'POST') {
    const b = await readBody(req); const i = findIssue(r[1]);
    for (const name of b.labels) if (!i.labels.some(l => l.name === name)) i.labels.push({ name });
    return json(res, 200, i.labels);
  }
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/(\d+)\/labels\/(.+)$/)) && req.method === 'DELETE') {
    const i = findIssue(r[1]); i.labels = i.labels.filter(l => l.name !== decodeURIComponent(r[2])); return json(res, 200, i.labels);
  }
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/(\d+)\/reactions$/))) return list(state.reactions[r[1]] || []);
  if ((r = m(/^\/repos\/NickGBar\/VibeMarket\/issues\/(\d+)$/)) && req.method === 'PATCH') {
    const b = await readBody(req); Object.assign(findIssue(r[1]), b); return json(res, 200, {});
  }
  // --- пользователи и репозитории приложений ---
  if ((r = m(/^\/users\/([^/]+)$/))) {
    const login = decodeURIComponent(r[1]);
    return state.users[login] ? json(res, 200, { login, type: 'User', created_at: state.users[login] }) : json(res, 404, { message: 'Not Found' });
  }
  if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/))) {
    return state.repos[r[1]]?.release ? json(res, 200, { tag_name: 'v1' }) : json(res, 404, { message: 'Not Found' });
  }
  if ((r = m(/^\/repos\/([^/]+\/[^/]+)$/))) {
    const repo = state.repos[r[1]];
    if (!repo || repo.private) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { full_name: r[1], name: r[1].split('/')[1], private: false, archived: false, fork: false, owner: { login: r[1].split('/')[0] }, ...repo });
  }
  if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets$/))) {
    const release = (state.releases[r[1]] || []).find(x => String(x.databaseId) === r[2]);
    if (!release) return json(res, 404, { message: 'Not Found' });
    const per = Number(url.searchParams.get('per_page') || 30);
    log.push(`assets ${r[1]} page ${page}`);
    return json(res, 200, release.assets.slice((page - 1) * per, page * per).map(a => ({ name: a.name, size: a.size, browser_download_url: a.downloadUrl, digest: a.digest })));
  }
  if (p === '/graphql' && req.method === 'POST') {
    const { query, variables } = await readBody(req);
    const releases = query.includes('releases(');
    if (releases && state.failReleases) return json(res, 502, { message: 'Bad Gateway' });
    const data = {};
    for (const key of Object.keys(variables).filter(k => k.startsWith('o'))) {
      const i = key.slice(1);
      const slug = `${variables[key]}/${variables[`n${i}`]}`;
      data[`r${i}`] = releases
        ? { releases: { nodes: (state.releases[slug] || []).map(({ assets, graphqlLimit, ...x }) => ({ ...x, releaseAssets: { totalCount: assets.length, nodes: assets.slice(0, graphqlLimit ?? 100) } })) } }
        : { stargazerCount: state.repos[slug]?.stargazers_count ?? 1000 };
    }
    return json(res, 200, { data });
  }
  json(res, 404, { message: `mock: ${req.method} ${p}` });
}).listen(PORT, () => console.log(`mock: ${PORT}`));
