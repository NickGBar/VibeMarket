// Запросы к GitHub API для робота и разведчика. Адрес API можно подменить (GITHUB_API_URL):
// так тесты в test/robot подставляют поддельный GitHub.

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

let calls = 0;
export const hasToken = Boolean(TOKEN);
export const requestCount = () => calls;

// allow: коды ответа, которые не считаются ошибкой; для них возвращается data: null
export async function gh(path, { method = 'GET', body, allow = [] } = {}) {
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

export async function ghAll(path) {
  const items = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

// Несколько репозиториев одним GraphQL-запросом: поля fields запрашиваются у каждого.
// Владельцы и имена идут переменными, в текст запроса ничего из данных не попадает.
// Возвращает Map: репозиторий → данные или null, если GitHub не ответил про него.
export async function graphqlRepos(slugs, fields, { chunk = 10 } = {}) {
  const out = new Map();
  for (let i = 0; i < slugs.length; i += chunk) {
    const part = slugs.slice(i, i + chunk);
    const variables = {};
    const aliases = part.map((slug, j) => {
      const [owner, name] = slug.split('/');
      variables[`o${j}`] = owner;
      variables[`n${j}`] = name;
      return `r${j}: repository(owner: $o${j}, name: $n${j}) { ${fields} }`;
    });
    const query = `query(${part.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(', ')}) { ${aliases.join(' ')} }`;
    const { data } = await gh('/graphql', { method: 'POST', body: { query, variables }, allow: [401, 403, 502] });
    part.forEach((slug, j) => out.set(slug, data?.data?.[`r${j}`] ?? null));
  }
  return out;
}
