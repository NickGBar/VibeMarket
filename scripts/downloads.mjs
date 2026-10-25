// Какой файл релиза скачать на какой компьютер. Робот разбирает файлы по именам раз в час
// и кладёт в catalog.json готовую таблицу: система → файлы, лучший первым. Страница только выбирает строку.
//
// Система узнаётся по расширению (.dmg → macOS, .msi → Windows, .AppImage → Linux, .apk → Android),
// у архивов — по словам в имени (macos, darwin, windows, linux). Процессор — тоже по словам:
// arm64 и aarch64 → arm64, x64, x86_64 и amd64 → x64, universal → любой Mac.
// Контрольные суммы, подписи, серверные и консольные сборки, исходники отбрасываются.

import { ghAll, graphqlRepos } from './github.mjs';

const EXT = /\.(dmg|pkg|exe|msi|msix|msixbundle|appx|appimage|deb|rpm|flatpak|run|apk|zip|7z|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar\.zst)$/;
const KIND = { tgz: 'tar', 'tar.gz': 'tar', 'tar.xz': 'tar', txz: 'tar', 'tar.bz2': 'tar', 'tar.zst': 'tar', msixbundle: 'msix', appx: 'msix' };
const OWN_OS = { dmg: 'mac', pkg: 'mac', exe: 'win', msi: 'win', msix: 'win', appimage: 'linux', deb: 'linux', rpm: 'linux', flatpak: 'linux', run: 'linux', apk: 'android' };
const SKIP = new RegExp([
  String.raw`\.pkg\.tar`, // пакет Arch Linux, ставится через pacman
  String.raw`sha\d*sums?|checksums?|\.sig\b|\.asc\b`,
  String.raw`(^|[-_. ])(src|source|sources|symbols?|debug|dbgsym|pdbs?|dsyms?|headers|sdk|headless|bwrap|devel|static|musl|nightly|test|tests|templates?|export|webview2|plugin)([-_. ]|$)`,
  String.raw`(cli|server)([-_. ]|$)`, // HandBrakeCLI, zed-remote-server
  String.raw`freebsd|openbsd|netbsd|solaris|illumos|haiku`,
].join('|'));
// Переносная версия и сборки для магазинов уступают установщику, но остаются в списке
const RARE = /portable|unsigned|nouserlib|(^|[-_. ])(store|play|fdroid)([-_. ]|$)/;
// Сборки для особого железа и особых случаев: показываем, только если обычной для этой системы нет
const NICHE = /commercial|perfetto|(^|[-_. ])(mono|cuda\d*|cu\d+|rocm|mlx|jetpack\d*|vulkan|opencl|sycl|hip|openvino|kompute|horizonos|picoos|legacy|nogpu|noavx|avx512|gplay|google)([-_. ]|$)/;
const RANK = {
  mac: ['dmg', 'pkg', 'zip', 'tar'],
  win: ['exe', 'msi', 'msix', 'zip', '7z'],
  linux: ['appimage', 'deb', 'rpm', 'flatpak', 'run', 'tar', 'zip'],
  android: ['apk'],
};

const archOf = name =>
  /universal|univ\b/.test(name) ? 'universal'
  : /arm64|aarch64|armv8|win64[-_]arm/.test(name) ? 'arm64'
  : /armv7|armhf|armel|armeabi|arm32|armv6|(^|[-_. ])arm([-_. ]|$)|riscv|ppc|powerpc|s390|loong|mips|sparc/.test(name) ? 'other'
  : /x86[-_]64|x64|amd64|win64|intel|64[-_]?bit/.test(name) ? 'x64'
  : /i[3-6]86|x86|win32|32[-_]?bit|ia32|(^|[-_. ])386([-_. ]|$)/.test(name) ? 'x86'
  : /(^|[-_. ])apple([-_. ]|$)/.test(name) ? 'arm64' // OBS-Studio-macOS-Apple.dmg, anki-mac-apple.dmg
  : null;

export function classify(asset) {
  const name = asset.name.toLowerCase();
  const ext = name.match(EXT)?.[1];
  if (!ext || SKIP.test(name)) return null;
  const kind = KIND[ext] || ext;
  const os = OWN_OS[kind]
    || (/mac|osx|darwin|apple/.test(name) ? 'mac' : /win/.test(name) ? 'win' : /android/.test(name) ? 'android' : /linux|ubuntu|debian|fedora/.test(name) ? 'linux' : null);
  if (!os || !RANK[os].includes(kind)) return null;
  let arch = archOf(name);
  // Mac на ARM бывает только 64-битным: ONLYOFFICE-arm.dmg — сборка для Apple Silicon
  if (arch === 'other' && os === 'mac' && /(^|[-_. ])arm([-_. ]|$)/.test(name)) arch = 'arm64';
  if (arch === 'other') return null;
  const niche = NICHE.test(name);
  const rank = RANK[os].indexOf(kind) + (RARE.test(name) ? 10 : 0) + (niche ? 20 : 0) - (/usersetup|user-setup/.test(name) ? 0.5 : 0);
  return { os, arch, kind, rank, niche, name: asset.name, size: asset.size, url: asset.downloadUrl, sha256: (asset.digest || '').replace(/^sha256:/, '') || undefined };
}

// Файл без процессора в имени: если рядом лежит такой же для arm64, этот для x64, иначе подходит любому.
// APK без процессора в имени — универсальный (app-release.apk рядом с app-arm64-v8a-release.apk у Immich).
// Установщик Windows без процессора рядом с явным x64 различаем по размеру: тот же размер или в полтора раза больше —
// общий установщик для всех процессоров (Super Productivity, Mullvad), иначе отдельная 32-битная сборка (Notepad++).
function settleArch(files) {
  // Сравниваем только с файлами, где процессор указан в имени, а не назначен этим же правилом
  const named = files.filter(f => f.arch);
  for (const f of files) {
    if (f.arch) continue;
    if (f.os === 'android') { f.arch = 'any'; continue; }
    const x64 = f.os === 'win' ? named.filter(g => g.os === 'win' && g.kind === f.kind && g.arch === 'x64') : [];
    if (x64.length) {
      f.arch = x64.some(g => g.size === f.size) || f.size >= Math.max(...x64.map(g => g.size)) * 1.5 ? 'any' : 'x86';
      continue;
    }
    const twin = named.some(g => g.os === f.os && g.kind === f.kind && (g.arch === 'arm64' || g.arch === 'universal'));
    f.arch = twin || f.os === 'win' || f.os === 'linux' ? 'x64' : 'any';
  }
  return files;
}

// Готовые релизы в порядке просмотра: отмеченный latest первым, дальше по дате.
// У Godot самый свежий по дате релиз бывает из старой ветки 3.x, поэтому одной даты мало.
// prerelease: принимать и предварительные релизы — FreeTube выпускает все версии как бету.
export function releaseOrder(releases, { tag, prerelease = false } = {}) {
  const tagRe = tag ? new RegExp(tag) : null;
  return (releases || [])
    .filter(r => !r.isDraft && (prerelease || !r.isPrerelease) && (!tagRe || tagRe.test(r.tagName)))
    .sort((a, b) => (b.isLatest ? 1 : 0) - (a.isLatest ? 1 : 0) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

// Для каждой системы берём первый релиз, где есть файлы для неё. Так у Mullvad приложение для Android
// и версии для компьютеров приходят из разных релизов. На каждый процессор остаётся не больше perArch файлов.
export function pickDownloads(releases, { tag, prerelease, perArch = 2, perArchLinux = 3 } = {}) {
  const out = {};
  for (const release of releaseOrder(releases, { tag, prerelease })) {
    const files = settleArch((release.releaseAssets?.nodes || []).map(classify).filter(Boolean));
    for (const os of Object.keys(RANK)) {
      if (out[os]) continue;
      const mine = files.filter(f => f.os === os && !(f.niche && files.some(g => g.os === os && !g.niche)))
        .sort((a, b) => a.rank - b.rank || b.size - a.size);
      if (!mine.length) continue;
      const kept = [];
      const count = {};
      for (const f of mine) {
        count[f.arch] = (count[f.arch] || 0) + 1;
        if (count[f.arch] <= (os === 'linux' ? perArchLinux : perArch)) kept.push(f);
      }
      out[os] = {
        tag: release.tagName,
        date: release.publishedAt,
        page: release.url,
        files: kept.map(({ rank, niche, os: _os, ...f }) => f),
      };
    }
  }
  return out;
}

// Свежие релизы репозиториев вместе с файлами, одним GraphQL-запросом на 10 репозиториев.
// GraphQL отдаёт не больше сотни файлов на релиз: у VSCodium их под две сотни, поэтому главный релиз
// дочитывается через REST. Репозитории, про которые GitHub не ответил, в результат не попадают.
export async function fetchReleases(slugs, { count = 10, tags = {}, prerelease = new Set() } = {}) {
  const fields = `releases(first: ${count}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { databaseId tagName isDraft isPrerelease isLatest publishedAt url releaseAssets(first: 100) { totalCount nodes { name size downloadUrl digest } } } }`;
  const out = new Map();
  for (const [slug, repo] of await graphqlRepos(slugs, fields)) {
    const releases = repo?.releases?.nodes;
    if (!Array.isArray(releases)) continue;
    const main = releaseOrder(releases, { tag: tags[slug], prerelease: prerelease.has(slug) })[0];
    if (main && main.releaseAssets.totalCount > main.releaseAssets.nodes.length) {
      try {
        const assets = await ghAll(`/repos/${slug}/releases/${main.databaseId}/assets`);
        main.releaseAssets.nodes = assets.map(a => ({ name: a.name, size: a.size, downloadUrl: a.browser_download_url, digest: a.digest }));
      } catch (e) {
        console.log(`${slug}: не удалось дочитать файлы релиза: ${e.message}`);
      }
    }
    out.set(slug, releases);
  }
  return out;
}

// Какой файл подходит компьютеру: те же уровни, что на странице (ARCH_TIERS в index.html).
// Внутри уровня сборки равны и выигрывает лучший файл по порядку робота: установщик раньше архива.
export const ARCH_TIERS = {
  mac: { arm64: [['arm64', 'universal', 'any'], ['x64']], x64: [['x64', 'universal', 'any']], unknown: [['universal', 'any', 'arm64'], ['x64']] },
  win: { arm64: [['arm64'], ['x64', 'any'], ['x86']], x64: [['x64', 'any'], ['x86']], x86: [['x86', 'any']], unknown: [['x64', 'any'], ['x86']] },
  linux: { arm64: [['arm64', 'any']], x64: [['x64', 'any']], unknown: [['x64', 'any']] },
  android: { unknown: [['universal', 'any', 'arm64']] },
};

export function pickFile(release, os, arch) {
  const tiers = ARCH_TIERS[os]?.[arch] || ARCH_TIERS[os]?.unknown || [];
  for (const tier of tiers) {
    const file = release?.files?.find(f => tier.includes(f.arch));
    if (file) return file;
  }
  return null;
}
