// Сборка сайта для GitHub Pages. Копирует файлы и создаёт для каждого приложения страницу на четырёх языках
// (ru/app/zed/, en/app/zed/, ...), а ещё sitemap.xml и 404.html, чтобы поисковики видели приложения
// по отдельным адресам.
//
// Рядом лежит apps.json: весь каталог в машиночитаемом виде, с текстами на четырёх языках, подборками и файлами
// для скачивания. Его читает MCP-сервер (scripts/mcp.mjs), им может пользоваться кто угодно.
//
// Исходный index.html остаётся одним файлом. Страницы — его копии с заголовком и описанием на языке страницы,
// разметкой schema.org, переводом интерфейса и текстом о приложении. Скрипт страницы потом заменяет этот текст
// живым интерфейсом, а поисковик без JavaScript видит его как есть. Общие стили и скрипт выносятся
// в assets/ с хешем в имени: браузер скачивает их один раз на весь сайт.
//
//   node scripts/build-site.mjs _site
//   SITE_URL=https://nickgbar.github.io/VibeMarket/ node scripts/build-site.mjs _site
//
// Подтвердить сайт в Google Search Console и Яндекс Вебмастере можно двумя способами: положить их HTML-файл
// (google….html, yandex_….html) в корень репозитория — он попадёт в корень сайта, — или задать GOOGLE_SITE_VERIFICATION
// и YANDEX_VERIFICATION, тогда метатеги появятся на главной.

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = new URL(`${process.argv[2] || '_site'}/`, `file://${process.cwd()}/`).pathname;
const pkg = JSON.parse(await readFile(`${ROOT}package.json`, 'utf8'));
const SITE = new URL(String(process.env.SITE_URL || pkg.homepage).replace(/\/?$/, '/'));
const LANGS = ['ru', 'en', 'es', 'zh'];
const OG_LOCALE = { ru: 'ru_RU', en: 'en_US', es: 'es_ES', zh: 'zh_CN' };
const INTL = { ru: 'ru-RU', en: 'en-US', es: 'es-ES', zh: 'zh-CN' };
const SCHEMA_CATEGORY = {
  dev: 'DeveloperApplication', design: 'DesignApplication', work: 'BusinessApplication', media: 'MultimediaApplication',
  privacy: 'SecurityApplication', ai: 'UtilitiesApplication', games: 'GameApplication',
};
const OS_NAMES = { m: 'macOS', w: 'Windows', l: 'Linux', a: 'Android', i: 'iOS', b: 'Web' };
const DL_OS = { mac: 'm', win: 'w', linux: 'l', android: 'a' };

const html = await readFile(`${ROOT}index.html`, 'utf8');

// Общие стили и скрипт страницы — в отдельные файлы, имя меняется вместе с содержимым
const STYLE = /<style>\n\/\* Layout:[\s\S]*?<\/style>/.exec(html)?.[0];
const SCRIPT = /<script>\n\(\(\) => \{[\s\S]*?<\/script>/.exec(html)?.[0];
if (!STYLE || !SCRIPT) throw new Error('index.html: не найдены основные стили или скрипт');
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 10);
const ASSETS = {
  css: { file: `assets/app-${hash(STYLE)}.css`, body: STYLE.replace(/^<style>\n?/, '').replace(/<\/style>$/, '') },
  js: { file: `assets/app-${hash(SCRIPT)}.js`, body: SCRIPT.replace(/^<script>\n?/, '').replace(/<\/script>$/, '') },
};

// Данные каталога: литералы CATS, APPS и DETAILS из index.html. Это обычные объекты без вызовов,
// поэтому их можно вычислить отдельно от остального скрипта страницы.
const literal = name => {
  const m = new RegExp(`const ${name} = ([\\[{][\\s\\S]*?\\n  [\\]}]);`).exec(html);
  if (!m) throw new Error(`index.html: не найден ${name}`);
  return vm.runInNewContext(`(${m[1]})`);
};
const CATS = literal('CATS');
const APPS = literal('APPS');
const DETAILS = literal('DETAILS');
const LINKS = literal('LINKS');
const REPLACES = literal('REPLACES');
// Подборки «Вместо …»: const ADOBE_PICKS = ['photocraft', …]
const COLLECTIONS = [...html.matchAll(/const ([A-Z]+)_PICKS = (\[[^\]]*\]);/g)].map(m => ({ id: m[1].toLowerCase(), apps: vm.runInNewContext(m[2]) }));
const RU = JSON.parse(/<script type="application\/json" id="i18n-ru">([\s\S]*?)<\/script>/.exec(html)[1]);
const LOCALES = { ru: {} };
for (const code of LANGS.slice(1)) LOCALES[code] = JSON.parse(await readFile(`${ROOT}locales/${code}.json`, 'utf8'));
const catalog = JSON.parse(await readFile(`${ROOT}catalog.json`, 'utf8').catch(() => '{}'));

// Приложения сайта: каталог, опубликованная песочница и находки разведчика, кроме скрытых по жалобам
const hidden = new Set((catalog.hidden || []).map(h => String(h.repo).toLowerCase()));
const seen = new Set();
const apps = [...APPS, ...(catalog.sandbox || []), ...(catalog.picks || [])]
  .filter(a => a && /^[a-z0-9-]+$/.test(a.id) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.repo) && a.name && a.desc)
  .filter(a => !hidden.has(a.repo.toLowerCase()) && !seen.has(a.id) && seen.add(a.id))
  .map(a => ({ ...a, stars: catalog.stars?.[a.repo] ?? a.stars ?? 0 }));
// Счётчик на главной — основной каталог без песочницы, как на странице
const sandboxIds = new Set((catalog.sandbox || []).map(a => a.id));
const mainCount = apps.filter(a => !sandboxIds.has(a.id)).length;

const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const dict = lang => (lang === 'ru' ? RU : { ...RU, ...LOCALES[lang].ui });
const t = (lang, key, vars = {}) => {
  let text = dict(lang)[key];
  if (text && typeof text === 'object') text = text.other;
  return String(text ?? key).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? vars[name] : m));
};
const catName = (lang, id) => (lang === 'ru' ? CATS.find(c => c.id === id)?.name : LOCALES[lang].cats?.[id]?.name) || id;
const appText = (lang, app) => {
  const tr = lang === 'ru' ? null : LOCALES[lang].apps?.[app.id];
  const d = DETAILS[app.id];
  return {
    desc: tr?.desc || app.desc,
    about: tr?.about || d?.about || app.about || app.desc,
    features: (d?.shots || []).map((shot, i) => tr?.shots?.[i] || shot[1] || shot.caption).filter(Boolean),
    os: [...String(d?.os ?? app.os ?? '')].filter(c => OS_NAMES[c]),
  };
};
const fmtSize = (lang, bytes) => new Intl.NumberFormat(INTL[lang], { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 })
  .format(Math.max(1, Math.round(bytes / 1024 ** 2)));

const pageURL = (lang, id) => new URL(`${lang}/${id ? `app/${id}/` : ''}`, SITE).href;
const alternates = id => [...LANGS.map(l => [l, pageURL(l, id)]), ['x-default', id ? pageURL('en', id) : SITE.href]];

// Подпись интерфейса из словаря прямо в разметку: элементы с data-i18n и атрибуты из data-i18n-attr.
// Трогаем только разметку до встроенного словаря, скрипты остаются как есть.
const translateMarkup = (page, lang) => {
  const cut = page.indexOf('<script type="application/json" id="i18n-ru">');
  const words = dict(lang);
  const markup = page.slice(0, cut)
    .replace(/(<([a-z0-9]+)\b[^>]*?\sdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, key, text, close) =>
      (typeof words[key] === 'string' ? open + esc(words[key]) + close : m))
    .replace(/<[a-z0-9]+\b[^>]*?\sdata-i18n-attr="([^"]+)"[^>]*>/g, (tagText, pairs) => pairs.split(';').reduce((acc, pair) => {
      const [attr, key] = pair.split(':');
      return typeof words[key] === 'string' ? acc.replace(new RegExp(`(\\s${attr}=")[^"]*(")`), (m, a, b) => a + esc(words[key]) + b) : acc;
    }, tagText))
    // Тексты, которые рисует скрипт: до его запуска пусть будут на языке страницы
    .replace(/(id="hero-title">)[^<]*/, (m, open) => open + esc(t(lang, 'daily.excalidraw.title')))
    .replace(/(id="hero-text">)[^<]*/, (m, open) => open + esc(t(lang, 'daily.excalidraw.text')))
    .replace(/(id="stat-count">)[^<]*/, (m, open) => open + new Intl.NumberFormat(INTL[lang]).format(mainCount))
    .replace(/(id="stat-count-label">)[^<]*/, (m, open) => {
      const forms = words['manifest.projects'];
      const text = typeof forms === 'object' ? forms[new Intl.PluralRules(INTL[lang]).select(mainCount)] ?? forms.other : forms;
      return open + esc(String(text ?? '').replace('{n}', mainCount));
    })
    .replace(/(id="stars-date">)[^<]*/, (m, open) => open + esc(t(lang, 'foot.starsSnapshot', {
      date: new Date(catalog.updated || Date.now()).toLocaleDateString(INTL[lang], { day: 'numeric', month: 'long', year: 'numeric' }),
    })));
  return markup + page.slice(cut);
};

const render = ({ lang, rel, url, title, description, alt, jsonLd, detail, noindex, verify }) => {
  let page = html.replace('<html lang="ru">', () => `<html lang="${lang || 'ru'}">`);
  page = page.replace(STYLE, () => `<link rel="stylesheet" href="${esc(rel + ASSETS.css.file)}">`);
  page = page.replace(SCRIPT, () => `<script src="${esc(rel + ASSETS.js.file)}"></script>`);
  page = page.replace('<title>VibeMarket</title>\n', '');
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`,
    ...(noindex ? [] : alt.map(([hl, href]) => `<link rel="alternate" hreflang="${hl}" href="${esc(href)}">`)),
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="VibeMarket">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:locale" content="${OG_LOCALE[lang || 'ru']}">`,
    '<meta name="twitter:card" content="summary">',
    '<meta name="vibemarket:pages" content="1">',
    `<meta name="vibemarket:root" content="${esc(rel)}">`,
    lang ? `<meta name="vibemarket:lang" content="${lang}">` : '',
    verify && process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">` : '',
    verify && process.env.YANDEX_VERIFICATION ? `<meta name="yandex-verification" content="${esc(process.env.YANDEX_VERIFICATION)}">` : '',
    jsonLd ? `<script type="application/ld+json">${json(jsonLd)}</script>` : '',
  ].filter(Boolean).join('\n');
  page = page.replace(/(<meta name="viewport"[^>]*>\n)/, (m, viewport) => `${viewport}${head}\n`);
  page = translateMarkup(page, lang || 'ru');
  if (lang && lang !== 'ru') {
    page = page.replace('<script type="application/json" id="i18n-ru">',
      () => `<script type="application/json" id="i18n-page">${json(LOCALES[lang])}</script>\n<script type="application/json" id="i18n-ru">`);
  }
  if (detail) {
    page = page.replace('<div id="browse" class="col">', () => '<div id="browse" class="col" hidden>');
    page = page.replace('<section class="col detail" id="detail" aria-labelledby="d-title" hidden></section>',
      () => `<section class="col detail" id="detail" aria-labelledby="d-title">${detail}</section>`);
  }
  return page;
};

// Текст страницы приложения для поисковиков: то же, что покажет интерфейс, но обычной разметкой
const detailHTML = (lang, app, rel) => {
  const text = appText(lang, app);
  const platforms = text.os.map(c => t(lang, `os.${c}`)).join(', ');
  const row = (label, value) => `<div class="info-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const releases = catalog.downloads?.[app.repo] || {};
  const files = Object.entries(releases).filter(([os]) => DL_OS[os]).flatMap(([os, rel]) =>
    rel.files.map(f => `<li><a href="${esc(f.url)}">${esc(t(lang, `os.${DL_OS[os]}`))} · ${esc(f.name)}</a> · ${esc(fmtSize(lang, f.size))}</li>`));
  const related = apps.filter(a => a.cat === app.cat && a.id !== app.id).sort((a, b) => b.stars - a.stars).slice(0, 12);
  return `
      <div class="d-nav wrap"><a class="back" href="${esc(rel + lang)}/"><span>${esc(t(lang, 'nav.today'))}</span></a></div>
      <header class="d-head wrap">
        <div class="d-title">
          <h1 class="d-name" id="d-title">${esc(app.name)}</h1>
          <p class="d-sub">${esc(text.desc)}</p>
          <p class="d-dl">${esc([catName(lang, app.cat), app.lic, platforms].filter(Boolean).join(' · '))}</p>
        </div>
      </header>
      <div class="d-grid wrap">
        <section class="d-block">
          <h2 class="shelf-title">${esc(t(lang, 'detail.about'))}</h2>
          <p class="d-text">${esc(text.about)}</p>
          ${text.features.length ? `<ul class="features">${text.features.map(f => `<li><span>${esc(f)}</span></li>`).join('')}</ul>` : ''}
        </section>
        <section class="d-block">
          <h2 class="shelf-title">${esc(t(lang, 'detail.info'))}</h2>
          <dl class="info">
            ${row(t(lang, 'info.repo'), `<a href="https://github.com/${esc(app.repo)}">${esc(app.repo)}</a>`)}
            ${row(t(lang, 'info.license'), esc(app.lic))}
            ${row(t(lang, 'info.stars'), esc(new Intl.NumberFormat(INTL[lang]).format(app.stars)))}
            ${platforms ? row(t(lang, 'info.platforms'), esc(platforms)) : ''}
            ${row(t(lang, 'info.price'), esc(t(lang, 'info.free')))}
          </dl>
        </section>
      </div>
      ${files.length ? `<section class="d-block wrap dl-block"><h2 class="shelf-title">${esc(t(lang, 'dl.title'))}</h2><ul>${files.join('')}</ul></section>` : ''}
      ${related.length ? `<section class="d-block wrap"><h2 class="shelf-title">${esc(t(lang, 'detail.moreCat', { cat: catName(lang, app.cat) }))}</h2><ul>${related.map(a => `<li><a href="${esc(`${rel}${lang}/app/${a.id}/`)}">${esc(a.name)}</a> — ${esc(appText(lang, a).desc)}</li>`).join('')}</ul></section>` : ''}`;
};

const write = async (file, content) => {
  const target = `${OUT}${file}`;
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  await writeFile(target, content);
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const file of ['catalog.json', 'rules.json']) if (existsSync(`${ROOT}${file}`)) await cp(`${ROOT}${file}`, `${OUT}${file}`);
for (const dir of ['locales', 'screens']) if (existsSync(`${ROOT}${dir}`)) await cp(`${ROOT}${dir}`, `${OUT}${dir}`, { recursive: true });
for (const asset of Object.values(ASSETS)) await write(asset.file, asset.body);
for (const file of await readdir(ROOT)) {
  if (/^(google[0-9a-f]{16}|yandex_[0-9a-f]{16})\.html$/.test(file)) await cp(`${ROOT}${file}`, `${OUT}${file}`);
}

const home = lang => ({
  title: t(lang, 'seo.homeTitle'),
  description: t(lang, 'seo.homeDesc'),
  jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'VibeMarket', url: pageURL(lang), inLanguage: lang, description: t(lang, 'seo.homeDesc') },
});

// Главная без языка в адресе сама выбирает язык посетителя и переходит на ru/, en/, es/ или zh/
await write('index.html', render({ ...home('ru'), lang: '', rel: './', url: SITE.href, alt: alternates(), verify: true }));
// На неизвестных адресах GitHub Pages отдаёт 404.html: она открывает витрину
await write('404.html', render({ ...home('ru'), lang: '', rel: SITE.pathname, url: SITE.href, alt: [], noindex: true }));

const urls = [{ loc: SITE.href, alt: alternates() }];
for (const lang of LANGS) {
  await write(`${lang}/index.html`, render({ ...home(lang), lang, rel: '../', url: pageURL(lang), alt: alternates() }));
  urls.push({ loc: pageURL(lang), alt: alternates() });
  for (const app of apps) {
    const text = appText(lang, app);
    const url = pageURL(lang, app.id);
    const lic = /^[A-Za-z0-9.+-]+$/.test(app.lic || '') ? `https://spdx.org/licenses/${app.lic}.html` : undefined;
    await write(`${lang}/app/${app.id}/index.html`, render({
      lang,
      rel: '../../../',
      url,
      alt: alternates(app.id),
      title: t(lang, 'seo.appTitle', { name: app.name }),
      description: t(lang, 'seo.appDesc', { desc: text.desc, lic: app.lic }),
      detail: detailHTML(lang, app, '../../../'),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: app.name,
        description: text.desc,
        url,
        applicationCategory: SCHEMA_CATEGORY[app.cat],
        operatingSystem: text.os.map(c => OS_NAMES[c]).join(', ') || undefined,
        license: lic,
        sameAs: `https://github.com/${app.repo}`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    }));
    urls.push({ loc: url, alt: alternates(app.id) });
  }
}

// Каталог для программ и ИИ-агентов
const OS_KEY = { m: 'macOS', w: 'Windows', l: 'Linux', a: 'Android', i: 'iOS', b: 'Web' };
const perLang = fn => Object.fromEntries(LANGS.map(lang => [lang, fn(lang)]));
await write('apps.json', `${JSON.stringify({
  version: 1,
  updated: catalog.updated || null,
  site: SITE.href,
  languages: LANGS,
  categories: CATS.map(c => ({ id: c.id, name: perLang(lang => catName(lang, c.id)) })),
  collections: COLLECTIONS.map(c => ({
    id: c.id,
    title: perLang(lang => t(lang, `${c.id}.title`)),
    apps: c.apps.filter(id => apps.some(a => a.id === id)),
  })),
  apps: apps.map(app => ({
    id: app.id,
    name: app.name,
    category: app.cat,
    repo: app.repo,
    license: app.lic,
    stars: app.stars,
    platforms: appText('ru', app).os.map(c => OS_KEY[c]),
    replaces: REPLACES[app.id] || [],
    thirdParty: sandboxIds.has(app.id),
    page: perLang(lang => pageURL(lang, app.id)),
    description: perLang(lang => appText(lang, app).desc),
    about: perLang(lang => appText(lang, app).about),
    links: { repo: `https://github.com/${app.repo}`, ...(LINKS[app.id] || {}) },
    downloads: catalog.downloads?.[app.repo] || {},
  })),
}, null, 1)}\n`);

const lastmod = (catalog.updated || new Date().toISOString()).slice(0, 10);
await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${lastmod}</lastmod>
${u.alt.map(([hl, href]) => `    <xhtml:link rel="alternate" hreflang="${hl}" href="${esc(href)}"/>`).join('\n')}
  </url>`).join('\n')}
</urlset>
`);

console.log(`Сайт собран в ${OUT}: ${apps.length} приложений × ${LANGS.length} языка, ${urls.length} адресов в sitemap.xml, адрес ${SITE.href}`);
