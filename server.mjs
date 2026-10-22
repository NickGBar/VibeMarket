#!/usr/bin/env node
// Мини-сервер VibeMarket: отдаёт index.html и проводит вход через GitHub.
//
//   npm start            (то же, что node --env-file-if-exists=.env server.mjs)
//
// Токен GitHub живёт только в памяти сервера, браузер получает лишь cookie сессии.
// Все запросы к GitHub идут отсюда, сама страница к сторонним сайтам не обращается.
// После перезапуска сервера сессии сбрасываются и нужно войти заново.
// Сервер необязателен: основной сайт работает на GitHub Pages, а каталог ведёт робот (scripts/robot.mjs).
// Сервер добавляет вход через GitHub, кнопку Star и полку «Ваши звёзды».
// Как создать GitHub App и заполнить .env, написано в README.md.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ORIGIN = new URL(BASE_URL).origin;
const SECURE = ORIGIN.startsWith('https://');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const SCOPE = process.env.GITHUB_SCOPE || ''; // только для классического OAuth App, например public_repo
const CONFIGURED = Boolean(CLIENT_ID && CLIENT_SECRET);
const CALLBACK = `${BASE_URL}/auth/callback`;
// Для GitHub Enterprise: свой адрес GitHub и его API
const GITHUB_URL = (process.env.GITHUB_URL || 'https://github.com').replace(/\/+$/, '');
const GITHUB_API_URL = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

const SESSION_COOKIE = 'vm_session';
const OAUTH_COOKIE = 'vm_oauth';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const CATALOG_TTL = 60 * 1000;
const RETURN_HASH = /^#app-[a-z0-9-]+$/i;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif' };
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const GH_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'VibeMarket' };

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------- Страница и каталог ---------- */

// index.html перечитывается, только когда файл изменился. Из него же берётся список
// репозиториев каталога: сервер работает только с ними и не служит общим прокси к GitHub.
let page = { mtime: 0 };
async function loadPage() {
  const file = join(ROOT, 'index.html');
  const { mtimeMs } = await stat(file);
  if (mtimeMs !== page.mtime) {
    const html = await readFile(file, 'utf8');
    page = {
      mtime: mtimeMs,
      html,
      repos: [...new Set([...html.matchAll(/repo: '([^']+)', stars:/g)].map(m => m[1]))],
      scriptHashes: [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`),
    };
  }
  return page;
}

async function catalogRepos() {
  const { repos } = await loadPage();
  let sandbox = [];
  try {
    sandbox = JSON.parse(await readFile(join(ROOT, 'catalog.json'), 'utf8')).sandbox || [];
  } catch { /* робот ещё не создал каталог */ }
  return [...new Set([...repos, ...sandbox.map(app => app?.repo).filter(repo => typeof repo === 'string')])];
}

async function sendLocale(res, code) {
  const body = await readFile(join(ROOT, 'locales', `${code}.json`)).catch(() => { throw new HttpError(404, 'not_found'); });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function sendCatalog(res) {
  const body = await readFile(join(ROOT, 'catalog.json')).catch(() => { throw new HttpError(404, 'not_found'); });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

const csp = hashes => [
  "default-src 'none'",
  `script-src ${hashes.join(' ')}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const publicUser = session => session && {
  login: session.user.login,
  name: session.user.name || session.user.login,
  url: session.user.html_url,
  avatar: '/api/avatar',
};

async function sendPage(req, res) {
  const p = await loadPage();
  const data = JSON.stringify({ service: 'vibemarket', configured: CONFIGURED, user: publicUser(getSession(req)) })
    .replace(/</g, '\\u003c');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp(p.scriptHashes),
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  res.end(p.html.replace('<!-- vm:server -->', `<script type="application/json" id="vm-server">${data}</script>`));
}

async function sendImage(res, pathname) {
  const type = IMAGE_TYPES[extname(pathname).toLowerCase()];
  let file = '';
  try { file = normalize(join(ROOT, decodeURIComponent(pathname))); } catch { /* битый адрес */ }
  if (!type || !file.startsWith(join(ROOT, 'screens') + sep)) throw new HttpError(404, 'not_found');
  const body = await readFile(file).catch(() => { throw new HttpError(404, 'not_found'); });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
  res.end(body);
}

/* ---------- Сессии ---------- */

const sessions = new Map();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* пропускаем битую cookie */ }
  }
  return out;
}

const cookie = (name, value, { maxAge, path = '/' } = {}) => [
  `${name}=${encodeURIComponent(value)}`,
  `Path=${path}`,
  'HttpOnly',
  'SameSite=Lax',
  SECURE && 'Secure',
  maxAge !== undefined && `Max-Age=${maxAge}`,
].filter(Boolean).join('; ');

function getSession(req) {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = id && sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.seen > SESSION_TTL) { sessions.delete(id); return null; }
  session.seen = Date.now();
  return session;
}

function requireSession(req) {
  const session = getSession(req);
  if (!session) throw new HttpError(401, 'not_signed_in', 'Войдите через GitHub');
  return session;
}

// Изменяющие запросы принимаются только со своей страницы: нужен заголовок X-VibeMarket,
// который чужой сайт не может отправить без CORS, и совпадающий Origin.
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (req.headers['x-vibemarket'] !== '1' || (origin && origin !== ORIGIN)) {
    throw new HttpError(403, 'forbidden', 'Запрос отклонён');
  }
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.seen > SESSION_TTL) sessions.delete(id);
}, 3600 * 1000).unref();

/* ---------- GitHub ---------- */

async function oauthToken(params) {
  const res = await fetch(`${GITHUB_URL}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'VibeMarket' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  return data;
}

function applyToken(session, data) {
  session.token = data.access_token;
  session.refreshToken = data.refresh_token || null;
  // Токены GitHub App живут 8 часов, затем обновляются по refresh_token
  session.expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
}

async function tokenOf(session) {
  if (!session.expiresAt || Date.now() < session.expiresAt - 60_000) return session.token;
  if (!session.refreshToken) throw new HttpError(401, 'session_expired', 'Сессия истекла, войдите снова');
  session.refreshing ??= oauthToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
    .then(data => applyToken(session, data))
    .finally(() => { session.refreshing = null; });
  try {
    await session.refreshing;
  } catch {
    sessions.delete(session.id);
    throw new HttpError(401, 'session_expired', 'Сессия истекла, войдите снова');
  }
  return session.token;
}

async function github(session, path, init = {}) {
  const res = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: { ...GH_HEADERS, Authorization: `Bearer ${await tokenOf(session)}`, ...init.headers },
  });
  if (res.status === 401) {
    sessions.delete(session.id);
    throw new HttpError(401, 'session_expired', 'Сессия истекла, войдите снова');
  }
  return res;
}

// Один GraphQL-запрос вместо 84 REST-вызовов: число звёзд и отметка пользователя для всего каталога
function catalogQuery(repos) {
  const variables = {};
  const fields = repos.map((slug, i) => {
    const [owner, name] = slug.split('/');
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { stargazerCount viewerHasStarred }`;
  });
  const params = repos.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(', ');
  return { query: `query(${params}) { ${fields.join(' ')} }`, variables };
}

/* ---------- Маршруты ---------- */

function login(req, res, url) {
  if (!CONFIGURED) throw new HttpError(503, 'not_configured', 'Вход через GitHub не настроен: задайте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET');
  const back = url.searchParams.get('return') || '';
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${GITHUB_URL}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(SCOPE && { scope: SCOPE }),
  });
  res.writeHead(302, {
    Location: authorize.href,
    'Set-Cookie': cookie(OAUTH_COOKIE, [state, verifier, RETURN_HASH.test(back) ? back : ''].join('|'), { maxAge: 600, path: '/auth' }),
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function callback(req, res, url) {
  const [state = '', verifier = '', back = ''] = (parseCookies(req.headers.cookie)[OAUTH_COOKIE] || '').split('|');
  const clear = cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/auth' });
  const redirect = (location, extra = []) => {
    res.writeHead(302, { Location: location, 'Set-Cookie': [clear, ...extra], 'Cache-Control': 'no-store' });
    res.end();
  };
  const got = url.searchParams.get('state') || '';
  if (!state || got.length !== state.length || !timingSafeEqual(Buffer.from(got), Buffer.from(state))) return redirect(`/?login=failed${back}`);
  if (url.searchParams.get('error')) return redirect(`/?login=cancelled${back}`);
  const code = url.searchParams.get('code');
  if (!code) return redirect(`/?login=failed${back}`);

  const session = { id: randomBytes(32).toString('base64url'), seen: Date.now(), catalog: null, avatar: null };
  try {
    applyToken(session, await oauthToken({ code, redirect_uri: CALLBACK, code_verifier: verifier }));
    const me = await github(session, '/user');
    if (!me.ok) throw new Error(`GET /user: HTTP ${me.status}`);
    session.user = await me.json();
  } catch (err) {
    console.error('Вход через GitHub не удался:', err.message);
    return redirect(`/?login=failed${back}`);
  }
  sessions.set(session.id, session);
  redirect(`/${back}`, [cookie(SESSION_COOKIE, session.id, { maxAge: SESSION_TTL / 1000 })]);
}

async function logout(req, res) {
  requireSameOrigin(req);
  const session = getSession(req);
  if (session) {
    sessions.delete(session.id);
    // Отзываем токен, чтобы он перестал работать и на стороне GitHub
    fetch(`${GITHUB_API_URL}/applications/${CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        ...GH_HEADERS,
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: session.token }),
    }).catch(err => console.error('Не удалось отозвать токен:', err.message));
  }
  res.writeHead(204, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }), 'Cache-Control': 'no-store' });
  res.end();
}

async function catalog(req, res) {
  const session = requireSession(req);
  if (session.catalog && Date.now() - session.catalog.at < CATALOG_TTL) return sendJSON(res, 200, session.catalog.data);
  const repos = await catalogRepos();
  const gql = await github(session, '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(catalogQuery(repos)),
  });
  const body = await gql.json().catch(() => ({}));
  if (!gql.ok || !body.data) {
    throw new HttpError(502, 'github_error', body.message || body.errors?.[0]?.message || `GitHub ответил ${gql.status}`);
  }
  const data = { stars: {}, starred: [], at: new Date().toISOString() };
  repos.forEach((slug, i) => {
    const repo = body.data[`r${i}`];
    if (!repo) return;
    data.stars[slug] = repo.stargazerCount;
    if (repo.viewerHasStarred) data.starred.push(slug);
  });
  session.catalog = { at: Date.now(), data };
  sendJSON(res, 200, data);
}

async function toggleStar(req, res, slug, method) {
  requireSameOrigin(req);
  const session = requireSession(req);
  if (!(await catalogRepos()).includes(slug)) throw new HttpError(404, 'unknown_repo', 'Такого приложения нет в каталоге');
  const r = await github(session, `/user/starred/${slug}`, { method, ...(method === 'PUT' && { body: '' }) });
  if (r.status !== 204) {
    const body = await r.json().catch(() => ({}));
    throw new HttpError(r.status === 403 || r.status === 404 ? 403 : 502, 'github_error', body.message || `GitHub ответил ${r.status}`);
  }
  const cached = session.catalog?.data;
  const on = method === 'PUT';
  if (cached && cached.starred.includes(slug) !== on) {
    cached.starred = on ? [...cached.starred, slug] : cached.starred.filter(s => s !== slug);
    if (slug in cached.stars) cached.stars[slug] += on ? 1 : -1;
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

// Аватар отдаётся через сервер, чтобы браузер не ходил на avatars.githubusercontent.com
async function avatar(req, res) {
  const session = requireSession(req);
  if (!session.avatar) {
    const src = new URL(session.user.avatar_url);
    if (src.hostname !== 'avatars.githubusercontent.com') throw new HttpError(404, 'no_avatar');
    src.searchParams.set('s', '96');
    const r = await fetch(src, { headers: { 'User-Agent': 'VibeMarket' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !AVATAR_TYPES.has(type)) throw new HttpError(502, 'avatar_error');
    session.avatar = { type, body: Buffer.from(await r.arrayBuffer()) };
  }
  res.writeHead(200, { 'Content-Type': session.avatar.type, 'Cache-Control': 'private, max-age=3600' });
  res.end(session.avatar.body);
}

function sendJSON(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, BASE_URL);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /' || route === 'GET /index.html') return await sendPage(req, res);
    if (route === 'GET /catalog.json') return await sendCatalog(res);
    const locale = /^\/locales\/([a-z]{2})\.json$/.exec(url.pathname);
    if (req.method === 'GET' && locale) return await sendLocale(res, locale[1]);
    if (route === 'GET /auth/login') return login(req, res, url);
    if (route === 'GET /auth/callback') return await callback(req, res, url);
    if (route === 'POST /auth/logout') return await logout(req, res);
    if (route === 'GET /api/catalog') return await catalog(req, res);
    if (route === 'GET /api/avatar') return await avatar(req, res);
    const star = /^\/api\/star\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(url.pathname);
    if (star && (req.method === 'PUT' || req.method === 'DELETE')) return await toggleStar(req, res, star[1], req.method);
    if (req.method === 'GET' && url.pathname.startsWith('/screens/')) return await sendImage(res, url.pathname);
    throw new HttpError(404, 'not_found');
  } catch (err) {
    if (err instanceof HttpError) return sendJSON(res, err.status, { error: err.code, message: err.message });
    console.error(err);
    sendJSON(res, 500, { error: 'internal', message: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`VibeMarket: ${BASE_URL}`);
  if (!CONFIGURED) console.log('Вход через GitHub выключен: задайте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET (см. README.md).');
});
