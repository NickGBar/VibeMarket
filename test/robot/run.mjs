// Сценарий проверки робота: несколько проходов со сдвигом времени и проверками после каждого.
// Робот работает с копией сайта во временной папке и с поддельным GitHub API (mock.mjs), настоящий GitHub не нужен.
//   npm test
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORM_LABELS } from '../../scripts/robot-i18n.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const REPO = new URL('../../', import.meta.url).pathname;
const PORT = Number(process.env.MOCK_PORT || 3141);
const M = `http://localhost:${PORT}`;
process.env.T0 ||= '2026-10-22T12:00:00Z';
const T0 = Date.parse(process.env.T0);

// Копия сайта: робот пишет catalog.json рядом со своим index.html, настоящий каталог не трогаем
const SITE = mkdtempSync(join(tmpdir(), 'vibemarket-robot-'));
for (const file of ['index.html', 'rules.json', 'scripts', 'locales']) cpSync(join(REPO, file), join(SITE, file), { recursive: true });
writeFileSync(join(SITE, 'catalog.json'), '{ "version": 1, "sandbox": [] }\n');

const mock = spawn('node', [`${DIR}mock.mjs`], { env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  mock.stdout.once('data', resolve);
  mock.once('exit', code => reject(new Error(`mock.mjs завершился с кодом ${code}`)));
});
// Если робот упадёт посреди сценария, мок не должен остаться висеть
process.on('exit', () => mock.kill());
const finish = code => { mock.kill(); rmSync(SITE, { recursive: true, force: true }); process.exit(code); };
const at = hours => new Date(T0 + hours * 3600e3).toISOString();
let failures = 0;

const scoutRun = now => {
  const out = execFileSync('node', [`${SITE}/scripts/scout.mjs`], {
    env: { ...process.env, ROBOT_NOW: now, GITHUB_API_URL: M, GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'NickGBar/VibeMarket' },
    encoding: 'utf8',
  });
  console.log(out.trim().split('\n').map(l => `    | ${l}`).join('\n'));
};
const tick = now => {
  const out = execFileSync('node', [`${SITE}/scripts/robot.mjs`], {
    env: { ...process.env, ROBOT_NOW: now, GITHUB_API_URL: M, GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'NickGBar/VibeMarket' },
    encoding: 'utf8',
  });
  console.log(out.trim().split('\n').map(l => `    | ${l}`).join('\n'));
};
const state = async () => (await fetch(`${M}/__state`)).json();
const post = (path, body) => fetch(`${M}${path}`, { method: 'POST', body: JSON.stringify(body) });
const catalog = () => JSON.parse(readFileSync(`${SITE}/catalog.json`, 'utf8'));
const labels = (s, n) => s.issues.find(i => i.number === n).labels.map(l => l.name).sort().join(',');
const robotText = (s, n) => (s.comments[n] || []).filter(c => c.user.login === 'github-actions[bot]').map(c => c.body).join('\n');
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
  if (!ok) failures++;
};

console.log('== Проход 1: новые заявки и жалобы');
tick(at(0));
let s = await state();
let c = catalog();
check('метки созданы', ['submission', 'candidate', 'invalid', 'accepted', 'rejected', 'blocked', 'report'].every(l => s.labels.includes(l)), s.labels.join(','));
check('#1 прошла проверку', labels(s, 1) === 'candidate,submission' && robotText(s, 1).includes('✅'), labels(s, 1));
check('#2 отклонена с причинами', labels(s, 2) === 'invalid,submission' && ['Название должно', 'Категория должна', 'три подтверждения', 'тему (topic)', 'не меньше 30 дней', 'нет ни одного релиза', 'не указана лицензия'].every(t => robotText(s, 2).includes(t)), robotText(s, 2));
check('#3 без метки опознана как заявка', labels(s, 3) === 'candidate,submission', labels(s, 3));
check('#4 без метки опознана как жалоба', labels(s, 4) === 'report', labels(s, 4));
check('#7 обычный вопрос не тронут', labels(s, 7) === '' && !robotText(s, 7));
check('#8 поддельный маркер не помешал', labels(s, 8) === 'candidate,submission' && (s.comments[8] || []).length === 2);
check('#9 дубль каталога отклонён', robotText(s, 9).includes('уже есть в VibeMarket'), robotText(s, 9));
check('кандидаты в catalog.json', c.candidates.map(x => x.issue).join(',') === '1,3,8', JSON.stringify(c.candidates.map(x => x.issue)));
check('платформы и цвет разобраны', (() => { const x = c.candidates.find(x => x.issue === 1); return x && x.c[0] === '#63D471' && x.repo === 'alice/tiny-timer'; })(), JSON.stringify(c.candidates[0]));
check('звёзды каталога записаны', c.stars['ollama/ollama'] === 184000 && Object.keys(c.stars).length >= 42, Object.keys(c.stars).length);

const dl = c.downloads || {};
const names = (slug, os) => (dl[slug]?.[os]?.files || []).map(f => f.name).join(',');
check('файлы Ollama разобраны по системам', names('ollama/ollama', 'mac') === 'Ollama.dmg' && names('ollama/ollama', 'win') === 'OllamaSetup.exe' && names('ollama/ollama', 'linux').split(',').sort().join(',') === 'ollama-linux-amd64.tar.zst,ollama-linux-arm64.tar.zst', JSON.stringify(dl['ollama/ollama']));
check('у файлов есть ссылка, размер и SHA-256', (() => { const f = dl['ollama/ollama']?.mac?.files[0]; return f?.url.endsWith('/Ollama.dmg') && f.size > 0 && /^0{64}$/.test(f.sha256) && dl['ollama/ollama'].mac.tag === 'v1'; })(), JSON.stringify(dl['ollama/ollama']?.mac));
check('VSCodium: файлы сверх лимита GraphQL дочитаны через REST', names('VSCodium/vscodium', 'win') === 'VSCodiumUserSetup-x64-1.0.exe' && names('VSCodium/vscodium', 'mac').includes('VSCodium.arm64.1.0.dmg'), JSON.stringify(dl['VSCodium/vscodium']));
check('Tauri пропущен по rules.json', !dl['tauri-apps/tauri'], JSON.stringify(dl['tauri-apps/tauri']));
check('Bitwarden: только релизы desktop-v', names('bitwarden/clients', 'mac') === 'Bitwarden-1-universal.dmg' && dl['bitwarden/clients'].mac.tag === 'desktop-v1', JSON.stringify(dl['bitwarden/clients']));
check('бета-релизы берутся только у разрешённых в rules.json', names('FreeTubeApp/FreeTube', 'mac') === 'freetube-1-beta-mac-arm64.dmg' && !dl['zed-industries/zed'], JSON.stringify(dl['FreeTubeApp/FreeTube']) + JSON.stringify(dl['zed-industries/zed']));
check('APK без процессора в имени считается универсальным', (dl['immich-app/immich']?.android?.files || []).some(f => f.name === 'app-release.apk' && f.arch === 'any') && !names('immich-app/immich', 'android').includes('armeabi'), JSON.stringify(dl['immich-app/immich']));
check('Mullvad: Android и компьютеры из разных релизов, бета пропущена', dl['mullvad/mullvadvpn-app']?.android?.tag === 'android/2' && dl['mullvad/mullvadvpn-app']?.mac?.tag === '2026.1', JSON.stringify(dl['mullvad/mullvadvpn-app']));

console.log('== Голоса');
for (let i = 0; i < 13; i++) await post('/__react', { issue: 1, user: `voter${i}`, content: '+1', at: at(1) });
await post('/__react', { issue: 1, user: 'voter13', content: '-1', at: at(1) });
await post('/__react', { issue: 1, user: 'newbie', content: '+1', at: at(1) });
await post('/__react', { issue: 1, user: 'alice', content: '+1', at: at(1) });
await post('/__react', { issue: 1, user: 'both', content: '+1', at: at(1) });
await post('/__react', { issue: 1, user: 'both', content: '-1', at: at(1) });
for (let i = 0; i < 3; i++) await post('/__react', { issue: 3, user: `voter${i}`, content: '+1', at: at(1) });
for (let i = 0; i < 11; i++) await post('/__react', { issue: 8, user: `voter${i}`, content: '+1', at: at(-480) });

console.log('== Проход 2: через двое суток, GitHub не отдаёт релизы');
await post('/__fail-releases', { on: true });
tick(at(48));
await post('/__fail-releases', { on: false });
c = catalog();
check('без ответа GitHub файлы остались прежними', JSON.stringify(c.downloads) === JSON.stringify(dl), Object.keys(c.downloads || {}).join(','));
const v1 = c.candidates.find(x => x.issue === 1);
check('#1: учтены 13 👍 и 1 👎, лишние отсеяны', v1?.up === 13 && v1?.down === 1, JSON.stringify(v1));
check('#8: голоса до начала голосования не считаются', c.candidates.find(x => x.issue === 8)?.up === 0);

console.log('== Проход 3: голосование закончилось');
tick(at(8 * 24));
s = await state();
c = catalog();
const app = c.sandbox.find(a => a.repo === 'alice/tiny-timer');
check('#1 опубликована и закрыта', app && s.issues.find(i => i.number === 1).state === 'closed' && labels(s, 1) === 'accepted,submission', labels(s, 1));
check('запись песочницы собрана из полей', app?.id === 'sb-tiny-timer' && app.cat === 'work' && app.os === 'mlb' && app.lic === 'MIT' && app.about === 'Подробно о таймере' && app.issue === 1, JSON.stringify(app));
check('#3 не набрала голосов', labels(s, 3) === 'rejected,submission' && s.issues.find(i => i.number === 3).state === 'closed', labels(s, 3));
check('#8 не набрала голосов', labels(s, 8) === 'rejected,submission', labels(s, 8));
check('голосование пусто', c.candidates.length === 0);
check('скрытых пока нет (2 жалобы от старых аккаунтов)', c.hidden.length === 0, JSON.stringify(c.hidden));

console.log('== Проход 4: третья жалоба');
await post('/__issue', { number: 10, login: 'frank', title: 'Жалоба', kind: 'report', repo: 'alice/tiny-timer' });
tick(at(8 * 24 + 2));
c = catalog();
check('приложение скрыто по жалобам', c.hidden.some(h => h.repo === 'alice/tiny-timer' && h.reports === 3), JSON.stringify(c.hidden));

console.log('== Проход 5: мейнтейнер ставит blocked');
await post('/__label', { issue: 1, name: 'blocked' });
tick(at(8 * 24 + 3));
c = catalog();
check('заблокированное снято', !c.sandbox.some(a => a.repo === 'alice/tiny-timer'), JSON.stringify(c.sandbox));

console.log('== Проход 6: автор исправил заявку #2');
await post('/__edit', { issue: 2, form: { repo: 'carol/pixel-paint', name: 'Pixel Paint', category: 'Дизайн и 3D', desc: 'Пиксельный редактор в браузере', platforms: 'Windows' } });
tick(at(8 * 24 + 4));
s = await state();
check('#2 после правки стала кандидатом', labels(s, 2) === 'candidate,submission', labels(s, 2) + ' ' + robotText(s, 2));
check('у #2 один комментарий робота', (s.comments[2] || []).length === 1);

console.log('== Проход 7: без изменений');
const before = readFileSync(`${SITE}/catalog.json`, 'utf8');
tick(at(8 * 24 + 4));
check('catalog.json не переписан без причины', readFileSync(`${SITE}/catalog.json`, 'utf8') === before);

// Формы на других языках
const formBody = (lang, f) => {
  const L = FORM_LABELS[lang];
  const consents = [1, 2, 3].map(i => ((f.consents ?? 3) >= i ? '- [X] ok' : '- [ ] ok')).join('\n');
  return [[L.repo, f.repo], [L.name, f.name], [L.category, f.category], [L.desc, f.desc], [L.about, f.about || '_No response_'],
    [L.platforms, f.platforms || '_No response_'], [L.glyph, f.glyph || '_No response_'], [L.color, f.color || '_No response_'], [L.consents, consents]]
    .map(([head, value]) => `### ${head}\n\n${value}`).join('\n\n');
};
const reportBody = (lang, repo) => { const L = FORM_LABELS[lang]; return `### ${L.repo}\n\n${repo}\n\n### ${L.reason}\n\nOtro\n\n### ${L.details}\n\nTest`; };

console.log('== Проход 8: заявки на английском, китайском и жалоба на испанском');
await post('/__issue', { number: 11, login: 'kim', title: 'Submission: Notes App', body: formBody('en', { repo: 'kim/notes-app', name: 'Notes App', category: 'work (Productivity)', desc: 'Quick notes that stay on your device', platforms: 'macOS, web', glyph: 'note', color: 'green' }) });
await post('/__issue', { number: 12, login: 'li', title: '申请：游戏', body: formBody('zh', { repo: 'li/game', name: '小游戏', category: '游戏', desc: '一个很好玩的开源小游戏，适合所有人', platforms: 'Windows、网页版', color: '绿色', consents: 2 }) });
await post('/__issue', { number: 13, login: 'ana', title: 'Denuncia: Notes', body: reportBody('es', 'kim/notes-app') });
tick(at(8 * 24 + 5));
s = await state();
c = catalog();
const en = c.candidates.find(x => x.issue === 11);
check('#11 английская заявка прошла, ответ на английском', labels(s, 11) === 'candidate,submission' && robotText(s, 11).includes('The submission passed the check'), robotText(s, 11).slice(0, 120));
check('#11 поля разобраны: категория, цвет, платформы', en?.cat === 'work' && en?.c[0] === '#63D471', JSON.stringify(en));
check('#12 китайская заявка отклонена, ответ на китайском', labels(s, 12) === 'invalid,submission' && robotText(s, 12).includes('申请未通过检查') && robotText(s, 12).includes('请勾选全部三项确认'), robotText(s, 12));
check('#12 китайская категория распознана', !robotText(s, 12).includes('分类必须'), robotText(s, 12));
check('#13 испанская жалоба опознана', labels(s, 13) === 'report', labels(s, 13));

console.log('== Проход 9: голоса за английскую заявку');
for (let i = 0; i < 12; i++) await post('/__react', { issue: 11, user: `voter${i}`, content: '+1', at: at(8 * 24 + 6) });
tick(at(16 * 24 + 6));
s = await state();
c = catalog();
const pub = c.sandbox.find(a => a.repo === 'kim/notes-app');
check('#11 опубликована, итог на английском', pub?.lang === 'en' && pub.os === 'mb' && robotText(s, 11).includes('Published in the sandbox'), JSON.stringify(pub) + robotText(s, 11).slice(0, 80));

console.log('== Проход 10: разведчик ищет новые приложения');
scoutRun(at(17 * 24));
s = await state();
const found = s.issues.filter(i => i.labels.some(l => l.name === 'scout'));
const notes = found[0];
check('разведчик завёл одну задачу, только на подходящее приложение', found.length === 1 && notes.title === 'Находка: Notes (neo/notes)', found.map(i => i.title).join(' | '));
check('в задаче заполнены поля карточки', notes && ['### Репозиторий\n\nneo/notes', '### Категория\n\nwork', '### Платформы\n\nmacOS, Windows, Linux', '### Значок\n\nnote', 'Notes-2.dmg'].every(t => notes.body.includes(t)), notes?.body);
scoutRun(at(17 * 24 + 1));
s = await state();
check('повторный поиск не дублирует находку', s.issues.filter(i => i.labels.some(l => l.name === 'scout')).length === 1);
tick(at(17 * 24 + 2));
s = await state();
c = catalog();
check('робот не принял находку за заявку и не добавил без approved', labels(s, notes.number) === 'scout' && !(c.picks || []).length, labels(s, notes.number));

console.log('== Проход 11: мейнтейнер одобряет находку');
await post('/__label', { issue: notes.number, name: 'approved' });
await post('/__issue', { number: 40, login: 'nick', title: 'Находка: вручную', labels: ['scout', 'approved'], body: '### Репозиторий\n\nneo/notes\n\n### Название\n\nX\n\n### Категория\n\nwork\n\n### Коротко о приложении\n\nкоротко' });
tick(at(17 * 24 + 3));
s = await state();
c = catalog();
const pick = (c.picks || []).find(a => a.repo === 'neo/notes');
check('находка в каталоге с полями из задачи', pick?.id === 'notes' && pick.name === 'Notes' && pick.cat === 'work' && pick.os === 'mwl' && pick.lic === 'MIT' && pick.issue === notes.number, JSON.stringify(c.picks));
check('задача находки закрыта со ссылкой на страницу', s.issues.find(i => i.number === notes.number).state === 'closed' && robotText(s, notes.number).includes('https://nickgbar.github.io/VibeMarket/ru/app/notes/'), robotText(s, notes.number));
check('у находки сразу есть файлы для скачивания и звёзды', c.downloads?.['neo/notes']?.mac?.files[0]?.name === 'Notes-2.dmg' && c.stars?.['neo/notes'] === 5000, JSON.stringify(c.downloads?.['neo/notes']));
check('ошибочная находка не добавлена, approved снят, причины в комментарии', labels(s, 40) === 'scout' && robotText(s, 40).includes('Не получилось добавить') && (c.picks || []).length === 1, labels(s, 40) + ' ' + robotText(s, 40));

console.log('== Проход 12: мейнтейнер снимает находку');
await post('/__label', { issue: notes.number, name: 'blocked' });
tick(at(17 * 24 + 4));
c = catalog();
check('находка снята по метке blocked', !(c.picks || []).length, JSON.stringify(c.picks));

console.log(failures ? `\nПровалено проверок: ${failures}` : '\nВсе проверки пройдены');
finish(failures ? 1 : 0);
