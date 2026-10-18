// Fabric + контент с Modrinth (моды, шейдеры, ресурспаки)
const fs = require('fs');
const path = require('path');

const MR = 'https://api.modrinth.com/v2';
const FABRIC = 'https://meta.fabricmc.net/v2';
const UA = { 'User-Agent': 'sigmaboy/sigma-launcher (github.com/0504405151d-hue/sigma-launcher)' };

const TYPES = {
  mod: { folder: 'mods', loaders: ['fabric'], facet: 'project_type:mod' },
  shader: { folder: 'shaderpacks', loaders: ['iris'], facet: 'project_type:shader' },
  resourcepack: { folder: 'resourcepacks', loaders: ['minecraft'], facet: 'project_type:resourcepack' }
};

async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
  return r.json();
}

/* ---------- Fabric ---------- */
let fabricGames = null;
async function fabricSupports(mc) {
  if (!fabricGames) fabricGames = new Set((await json(`${FABRIC}/versions/game`)).map((g) => g.version));
  return fabricGames.has(mc);
}

async function ensureFabric(root, mc, log) {
  const loaders = await json(`${FABRIC}/versions/loader/${encodeURIComponent(mc)}`);
  if (!loaders.length) throw new Error(`Fabric не поддерживает ${mc}`);
  const pick = loaders.find((l) => l.loader.stable) || loaders[0];
  const profile = await json(`${FABRIC}/versions/loader/${encodeURIComponent(mc)}/${pick.loader.version}/profile/json`);
  const dir = path.join(root, 'versions', profile.id);
  const file = path.join(dir, `${profile.id}.json`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    log?.(`[fabric] Установлен ${profile.id}`);
  }
  return profile.id;
}

/* ---------- Modrinth ---------- */
async function search({ query, type, mc, offset = 0, sort = 'relevance' }) {
  const t = TYPES[type] || TYPES.mod;
  const facets = [[t.facet], [`versions:${mc}`]];
  if (type === 'mod') facets.push(['categories:fabric']);
  const url = `${MR}/search?limit=20&offset=${offset}&index=${sort}` +
    `&query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const r = await json(url);
  return {
    total: r.total_hits,
    hits: r.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      downloads: h.downloads,
      author: h.author,
      type
    }))
  };
}

async function latestVersion(project, type, mc) {
  const t = TYPES[type];
  const list = await json(`${MR}/project/${encodeURIComponent(project)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(t.loaders))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`);
  return list[0] || null;
}

async function download(url, dest) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Не удалось скачать файл (HTTP ${r.status})`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

/**
 * Ставит проект и его обязательные зависимости.
 * content — объект установленного контента сборки { [projectId]: {...} }, изменяется на месте.
 */
async function install({ project, type, mc, gameDir, content, log, depth = 0 }) {
  if (depth > 6) return;
  const v = await latestVersion(project, type, mc);
  if (!v) throw new Error(`Нет версии для Minecraft ${mc}`);
  if (content[v.project_id]) return content[v.project_id];

  const file = v.files.find((f) => f.primary) || v.files[0];
  const folder = path.join(gameDir, TYPES[type].folder);
  fs.mkdirSync(folder, { recursive: true });
  await download(file.url, path.join(folder, file.filename));

  let info = { title: v.name, icon: null };
  try {
    const p = await json(`${MR}/project/${v.project_id}`);
    info = { title: p.title, icon: p.icon_url };
  } catch { /* не критично */ }

  content[v.project_id] = {
    id: v.project_id,
    title: info.title,
    icon: info.icon,
    type,
    file: file.filename,
    version: v.version_number,
    dependency: depth > 0
  };
  log?.(`[mods] Установлено: ${info.title} ${v.version_number}`);

  for (const d of v.dependencies || []) {
    if (d.dependency_type !== 'required' || !d.project_id || content[d.project_id]) continue;
    await install({ project: d.project_id, type: 'mod', mc, gameDir, content, log, depth: depth + 1 });
  }
  return content[v.project_id];
}

function remove({ id, gameDir, content }) {
  const c = content[id];
  if (!c) return;
  fs.rmSync(path.join(gameDir, TYPES[c.type].folder, c.file), { force: true });
  delete content[id];
}

module.exports = { fabricSupports, ensureFabric, search, install, remove, TYPES };
