// Проверка MCP-сервера (scripts/mcp.mjs): протокол, поиск, подбор замены и скачивание с проверкой SHA-256.
// Каталог — настоящий apps.json из сборки сайта, файлы для скачивания отдаёт локальный сервер.
//   npm test
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;
const TMP = mkdtempSync(join(tmpdir(), 'vibemarket-mcp-'));
const SAVE = join(TMP, 'downloads');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
  if (!ok) failures++;
};

// Каталог из настоящей сборки сайта, файлы трёх приложений ведут на локальный сервер
execFileSync('node', [join(REPO, 'scripts/build-site.mjs'), join(TMP, 'site')], { stdio: 'ignore' });
const data = JSON.parse(readFileSync(join(TMP, 'site/apps.json'), 'utf8'));
const BODY = 'VibeMarket test installer\n';
const SHA = createHash('sha256').update(BODY).digest('hex');
const files = new Map();
const server = createServer((req, res) => {
  if (!files.has(req.url)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(files.get(req.url));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;
const fake = (id, name, sha256, repo) => {
  const app = data.apps.find(a => a.id === id);
  const url = `${ORIGIN}${repo || app.repo}/releases/download/v9/${name}`;
  files.set(new URL(url).pathname, BODY);
  app.downloads = { linux: { tag: 'v9', date: new Date().toISOString(), files: [{ name, size: BODY.length, arch: 'x64', kind: 'appimage', sha256, url }] } };
};
fake('zed', 'zed-test.AppImage', SHA);
fake('neovim', 'nvim-test.AppImage', '0'.repeat(64));
fake('lazygit', 'lazygit-test.AppImage', SHA, 'someone/else');
writeFileSync(join(TMP, 'apps.json'), JSON.stringify(data));

// Сервер MCP и простой клиент JSON-RPC поверх stdio
const mcp = spawn('node', [join(REPO, 'scripts/mcp.mjs')], {
  env: { ...process.env, VIBEMARKET_DATA: join(TMP, 'apps.json'), VIBEMARKET_DOWNLOAD_ORIGIN: ORIGIN },
  stdio: ['pipe', 'pipe', 'ignore'],
});
process.on('exit', () => mcp.kill());
let buffer = '';
const waiting = new Map();
mcp.stdout.on('data', chunk => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\n')) >= 0;) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    waiting.get(msg.id)?.(msg);
  }
});
let nextId = 0;
const rpc = (method, params) => new Promise(ok => {
  const id = ++nextId;
  waiting.set(id, ok);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const ids = result => (result.structuredContent?.apps || []).map(a => a.id);

console.log('== Протокол');
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
check('initialize: имя сервера и версия протокола', init.result?.serverInfo?.name === 'vibemarket' && init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools, JSON.stringify(init));
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const tools = await rpc('tools/list');
check('шесть инструментов, у скачивания нет пометки «только чтение»', tools.result.tools.length === 6 && tools.result.tools.find(t => t.name === 'download_app').annotations.readOnlyHint === false,
  tools.result.tools.map(t => t.name).join(','));
check('ping', JSON.stringify((await rpc('ping')).result) === '{}');
check('неизвестный метод — ошибка -32601', (await rpc('resources/list')).error?.code === -32601);
check('неизвестный инструмент — ошибка -32602', (await rpc('tools/call', { name: 'nope', arguments: {} })).error?.code === -32602);

console.log('== Поиск');
let r = await tool('find_alternative', { product: 'Notion' });
check('замена Notion — AppFlowy', ids(r)[0] === 'appflowy', ids(r).join(','));
r = await tool('find_alternative', { product: 'photoshop', lang: 'ru' });
check('замены Photoshop, описание на русском', ids(r).includes('photocraft') && ids(r).includes('gimp') && /Фоторедактор/.test(r.content[0].text), ids(r).join(','));
r = await tool('search_apps', { query: 'password manager' });
check('поиск «password manager»', ids(r).includes('keepassxc') && ids(r).includes('bitwarden'), ids(r).join(','));
r = await tool('search_apps', { collection: 'google', limit: 50 });
const google = data.collections.find(c => c.id === 'google').apps;
check('подборка «Вместо Google» целиком', ids(r).length === google.length && ids(r).every(id => google.includes(id)), ids(r).join(','));
r = await tool('search_apps', { platform: 'android', limit: 50 });
check('фильтр по платформе', ids(r).length > 0 && r.structuredContent.apps.every(a => a.platforms.includes('Android')), ids(r).join(','));
r = await tool('search_apps', { agent: true, limit: 50 });
check('фильтр «работает с ИИ-агентом»', ids(r).includes('photocraft') && ids(r).includes('drawio') && !ids(r).includes('zed') && r.structuredContent.apps.every(a => a.worksWithAgents), ids(r).join(','));
r = await tool('get_app', { app: 'photocraft' });
check('команда подключения MCP-сервера приложения', r.content[0].text.includes('claude mcp add photocraft -- photocraft-cli mcp') && /ask before/.test(r.content[0].text), r.content[0].text.slice(-400));
r = await tool('get_app', { app: 'bitwarden' });
check('предупреждение для хранилища паролей', /password vault/.test(r.content[0].text), r.content[0].text.slice(-300));
r = await tool('get_app', { app: 'Zed' });
check('карточка приложения со списком файлов', !r.isError && r.content[0].text.includes('zed-test.AppImage') && r.structuredContent.id === 'zed', r.content[0].text.slice(0, 200));
r = await tool('recent_updates', { days: 3, limit: 50 });
check('свежие обновления включают только что вышедшие', ids(r).includes('zed'), ids(r).join(','));
r = await tool('list_collections', {});
check('подборки и категории', r.structuredContent.collections.length >= 4 && r.content[0].text.includes('Instead of Adobe'), r.content[0].text.slice(0, 120));

console.log('== Скачивание');
r = await tool('download_app', { app: 'zed', platform: 'linux', arch: 'x64', directory: SAVE });
const saved = join(SAVE, 'zed-test.AppImage');
check('файл скачан, SHA-256 сверена', !r.isError && r.structuredContent?.verified === true && readFileSync(saved, 'utf8') === BODY, JSON.stringify(r));
check('ничего не установлено и не запущено, есть подсказка', /Nothing was installed or run/.test(r.content[0].text) && /chmod \+x/.test(r.content[0].text), r.content[0].text);
r = await tool('download_app', { app: 'zed', platform: 'linux', arch: 'x64', directory: SAVE });
check('повторное скачивание не перезаписывает файл', r.structuredContent?.file === join(SAVE, 'zed-test (2).AppImage') && existsSync(saved), JSON.stringify(r.structuredContent));
r = await tool('download_app', { app: 'neovim', platform: 'linux', arch: 'x64', directory: SAVE });
check('неверная SHA-256 — ошибка, файл удалён', r.isError && /Checksum mismatch/.test(r.content[0].text) && !readdirSync(SAVE).some(f => f.startsWith('nvim-test')), r.content[0].text);
r = await tool('download_app', { app: 'lazygit', platform: 'linux', arch: 'x64', directory: SAVE });
check('ссылка не на релизы этого репозитория — отказ', r.isError && /Refusing/.test(r.content[0].text) && !readdirSync(SAVE).some(f => f.startsWith('lazygit')), r.content[0].text);
r = await tool('download_app', { app: 'excalidraw', platform: 'mac', directory: SAVE });
check('нет файла — ссылка на веб-версию', !r.isError && r.content[0].text.includes('https://excalidraw.com'), r.content[0].text);
r = await tool('download_app', { app: 'no-such-app-xyz', directory: SAVE });
check('неизвестное приложение — понятная ошибка', r.isError, JSON.stringify(r));

console.log(failures ? `\nПровалено проверок: ${failures}` : '\nВсе проверки пройдены');
mcp.kill();
server.close();
rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
