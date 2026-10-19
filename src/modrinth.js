// Fabric + контент с Modrinth (моды, шейдеры, ресурспаки)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const MR = 'https://api.modrinth.com/v2';
const FABRIC = 'https://meta.fabricmc.net/v2';
const UA = { 'User-Agent': 'sigmaboy/sigma-launcher (github.com/0504405151d-hue/sigma-launcher)' };

const TYPES = {
  mod: { folder: 'mods', loaders: ['fabric'], facet: 'project_type:mod' },
  shader: { folder: 'shaderpacks', loaders: ['iris'], facet: 'project_type:shader' },
  resourcepack: { folder: 'resourcepacks', loaders: ['minecraft'], facet: 'project_type:resourcepack' }
};

async function json(url, body) {
  const r = await fetch(url, body
    ? { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: UA });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
  return r.json();
}

const hashFile = (file, algo = 'sha1') => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
const folderOf = (type) => (TYPES[type] || TYPES.mod).folder;
const typeOfPath = (p) => (p.startsWith('shaderpacks/') ? 'shader' : p.startsWith('resourcepacks/') ? 'resourcepack' : 'mod');

/* ---------- Fabric ---------- */
let fabricGames = null;
async function fabricSupports(mc) {
  if (!fabricGames) fabricGames = new Set((await json(`${FABRIC}/versions/game`)).map((g) => g.version));
  return fabricGames.has(mc);
}

async function ensureFabric(root, mc, log, wanted) {
  const loaders = await json(`${FABRIC}/versions/loader/${encodeURIComponent(mc)}`);
  if (!loaders.length) throw new Error(`Fabric не поддерживает ${mc}`);
  const pick = (wanted && loaders.find((l) => l.loader.version === wanted)) || loaders.find((l) => l.loader.stable) || loaders[0];
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
  // шейдеры почти не зависят от версии игры — не режем по ней поиск
  const facets = [[t.facet]];
  if (type !== 'shader') facets.push([`versions:${mc}`]);
  if (type === 'mod') facets.push(['categories:fabric']);
  if (type === 'shader') facets.push(['categories:iris']);
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
  const base = `${MR}/project/${encodeURIComponent(project)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(t.loaders))}`;
  const list = await json(`${base}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`);
  if (list[0] || type !== 'shader') return list[0] || null;
  // шейдер без точной версии игры — берём самую свежую, обычно он работает
  return (await json(base))[0] || null;
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
    versionId: v.id,
    sha1: file.hashes?.sha1,
    sha512: file.hashes?.sha512,
    url: file.url,
    size: file.size,
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

/* ---------- модпаки (.mrpack) ---------- */
async function searchPacks({ query, offset = 0, sort = 'downloads' }) {
  const facets = [['project_type:modpack'], ['categories:fabric']];
  const url = `${MR}/search?limit=20&offset=${offset}&index=${sort}` +
    `&query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const r = await json(url);
  return {
    total: r.total_hits,
    hits: r.hits.map((h) => ({
      id: h.project_id, title: h.title, description: h.description, icon: h.icon_url,
      downloads: h.downloads, author: h.author, versions: h.versions || []
    }))
  };
}

async function downloadPack(project, dest) {
  const list = await json(`${MR}/project/${encodeURIComponent(project)}/version?loaders=${encodeURIComponent('["fabric"]')}`);
  const v = list[0];
  if (!v) throw new Error('У этого модпака нет версии на Fabric');
  const f = v.files.find((x) => x.primary) || v.files[0];
  await download(f.url, dest);
  let icon = null;
  try { icon = (await json(`${MR}/project/${encodeURIComponent(project)}`)).icon_url; } catch { /* без иконки */ }
  return { icon };
}

// безопасный путь внутри папки сборки
function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error(`Опасный путь в модпаке: ${rel}`);
  return p;
}

/** Читает .mrpack и раскладывает файлы в папку сборки. */
async function installMrpack({ file, gameDir, log, progress }) {
  const zip = new AdmZip(file);
  const idx = zip.getEntry('modrinth.index.json');
  if (!idx) throw new Error('Это не файл сборки (.mrpack)');
  const index = JSON.parse(idx.getData().toString('utf8'));
  const deps = index.dependencies || {};
  const mc = deps.minecraft;
  if (!mc) throw new Error('В сборке не указана версия Minecraft');
  if (deps.forge || deps.neoforge || deps['quilt-loader']) {
    throw new Error('Эта сборка на Forge/NeoForge/Quilt — пока поддерживается только Fabric');
  }
  const loader = deps['fabric-loader'] ? 'fabric' : 'vanilla';

  const files = (index.files || []).filter((f) => !f.env || f.env.client !== 'unsupported');
  fs.mkdirSync(gameDir, { recursive: true });
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progress?.(`Скачиваю моды (${i + 1}/${files.length})`, i / files.length);
    const dest = safeJoin(gameDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let ok = false;
    for (const url of f.downloads || []) {
      try { await download(url, dest); ok = true; break; } catch { /* следующее зеркало */ }
    }
    if (!ok) log?.(`[pack] Не удалось скачать ${f.path}`);
  }

  progress?.('Распаковываю настройки сборки...', 1);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const m = e.entryName.match(/^(overrides|client-overrides)\/(.+)$/);
    if (!m) continue;
    const dest = safeJoin(gameDir, m[2]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }

  // узнаём, какие проекты Modrinth стоят — чтобы потом можно было обновлять и удалять
  const content = {};
  const byHash = {};
  for (const f of files) if (f.hashes?.sha1) byHash[f.hashes.sha1] = f;
  try {
    const found = await json(`${MR}/version_files`, { hashes: Object.keys(byHash), algorithm: 'sha1' });
    const ids = [...new Set(Object.values(found).map((v) => v.project_id))];
    const projects = ids.length ? await json(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`) : [];
    const meta = Object.fromEntries(projects.map((p) => [p.id, p]));
    for (const [hash, v] of Object.entries(found)) {
      const f = byHash[hash];
      const type = typeOfPath(f.path);
      content[v.project_id] = {
        id: v.project_id, title: meta[v.project_id]?.title || path.basename(f.path),
        icon: meta[v.project_id]?.icon_url || null, type, file: path.basename(f.path),
        version: v.version_number, versionId: v.id, sha1: hash, sha512: f.hashes?.sha512,
        url: f.downloads?.[0], size: f.fileSize, dependency: false
      };
    }
  } catch { /* без списка модов — сборка всё равно работает */ }

  return { name: index.name || 'Сборка', mc, loader, loaderVersion: deps['fabric-loader'], content, summary: index.summary || '' };
}

/** Собирает .mrpack из сборки, чтобы отправить другу. */
async function exportMrpack({ name, mc, loaderVersion, gameDir, content, out }) {
  const zip = new AdmZip();
  const files = [];
  const known = new Set();
  // моды, шейдеры и ресурспаки с Modrinth — ссылками, остальное кладём внутрь
  for (const type of Object.keys(TYPES)) {
    const dir = path.join(gameDir, folderOf(type));
    let list = [];
    try { list = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()); } catch { continue; }
    const hashes = {};
    for (const f of list) hashes[hashFile(path.join(dir, f))] = f;
    let found = {};
    try { found = await json(`${MR}/version_files`, { hashes: Object.keys(hashes), algorithm: 'sha1' }); } catch { /* офлайн */ }
    for (const [hash, fname] of Object.entries(hashes)) {
      const full = path.join(dir, fname);
      const rel = `${folderOf(type)}/${fname}`;
      const v = found[hash];
      const vf = v && v.files.find((x) => x.hashes?.sha1 === hash);
      if (vf) {
        files.push({
          path: rel,
          hashes: { sha1: hash, sha512: vf.hashes.sha512 || hashFile(full, 'sha512') },
          env: { client: 'required', server: type === 'mod' ? 'optional' : 'unsupported' },
          downloads: [vf.url],
          fileSize: fs.statSync(full).size
        });
      } else {
        zip.addLocalFile(full, `overrides/${folderOf(type)}`);
      }
      known.add(rel);
    }
  }
  // настройки модов — чтобы у друга было так же
  const cfg = path.join(gameDir, 'config');
  if (fs.existsSync(cfg)) zip.addLocalFolder(cfg, 'overrides/config');

  const deps = { minecraft: mc };
  if (loaderVersion) deps['fabric-loader'] = loaderVersion;
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name, summary: 'Сделано в Sigma Launcher', files, dependencies: deps
  }, null, 2)));
  zip.writeZip(out);
  return { files: files.length };
}

/* ---------- обновление модов ---------- */
async function checkUpdates({ mc, gameDir, content }) {
  const updates = [];
  const groups = {};
  for (const c of Object.values(content)) {
    const full = path.join(gameDir, folderOf(c.type), c.file);
    if (!fs.existsSync(full)) continue;
    const sha1 = c.sha1 || hashFile(full);
    (groups[c.type] = groups[c.type] || []).push({ c, sha1 });
  }
  for (const [type, items] of Object.entries(groups)) {
    const body = { hashes: items.map((x) => x.sha1), algorithm: 'sha1', loaders: TYPES[type].loaders, game_versions: [mc] };
    let res = {};
    try { res = await json(`${MR}/version_files/update`, body); } catch { continue; }
    for (const { c, sha1 } of items) {
      const v = res[sha1];
      if (!v) continue;
      const f = v.files.find((x) => x.primary) || v.files[0];
      if (!f || f.hashes?.sha1 === sha1) continue;
      updates.push({ id: c.id, title: c.title, icon: c.icon, type, from: c.version, to: v.version_number, versionId: v.id, file: f });
    }
  }
  return updates;
}

async function applyUpdate({ gameDir, content, upd }) {
  const c = content[upd.id];
  const folder = path.join(gameDir, folderOf(upd.type));
  const dest = path.join(folder, upd.file.filename);
  await download(upd.file.url, dest);
  if (c && c.file !== upd.file.filename) fs.rmSync(path.join(folder, c.file), { force: true });
  content[upd.id] = {
    ...(c || { id: upd.id, title: upd.title, icon: upd.icon, type: upd.type, dependency: false }),
    file: upd.file.filename, version: upd.to, versionId: upd.versionId,
    sha1: upd.file.hashes?.sha1, sha512: upd.file.hashes?.sha512, url: upd.file.url, size: upd.file.size
  };
}

module.exports = {
  fabricSupports, ensureFabric, search, install, remove, latestVersion, TYPES,
  searchPacks, downloadPack, installMrpack, exportMrpack, checkUpdates, applyUpdate
};
