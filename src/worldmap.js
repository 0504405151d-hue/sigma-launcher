// Карта мира сверху: читает region/*.mca и рисует верхний блок каждой колонки
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');

/* ---------- цвета блоков ---------- */
const DYE = {
  white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9', yellow: '#f8c627',
  lime: '#70b919', pink: '#ed8dac', gray: '#3e4447', light_gray: '#8e8e86', cyan: '#158991',
  purple: '#792aac', blue: '#35399d', brown: '#724728', green: '#546d1b', red: '#a12722', black: '#141519'
};
const EXACT = {
  grass_block: '#6fa94a', short_grass: '#6fa94a', grass: '#6fa94a', tall_grass: '#6aa646', fern: '#5f9a3f', large_fern: '#5f9a3f',
  water: '#3b6fd8', bubble_column: '#3b6fd8', seagrass: '#3b6fd8', tall_seagrass: '#3b6fd8', kelp: '#3b6fd8', kelp_plant: '#3b6fd8',
  ice: '#91b4fe', packed_ice: '#7fa4e8', blue_ice: '#74a8fd', frosted_ice: '#91b4fe',
  sand: '#dbd3a0', red_sand: '#be6621', gravel: '#857f7e', suspicious_sand: '#dbd3a0', suspicious_gravel: '#857f7e',
  stone: '#7d7d7d', cobblestone: '#7a7a7a', mossy_cobblestone: '#6f7a5f', andesite: '#888888', diorite: '#bcbcbc', granite: '#9a6b57',
  deepslate: '#4d4d50', cobbled_deepslate: '#4d4d50', tuff: '#6c6d66', calcite: '#dfe0dc', dripstone_block: '#866b5c',
  dirt: '#866043', coarse_dirt: '#77553b', rooted_dirt: '#90684c', podzol: '#5b3f21', mycelium: '#6f6369', mud: '#3c3a3d',
  dirt_path: '#94793f', farmland: '#7b5233', clay: '#a0a6b3', moss_block: '#596e2d', moss_carpet: '#596e2d',
  snow: '#f9fefe', snow_block: '#f9fefe', powder_snow: '#f8fdfd',
  lava: '#d4580d', magma_block: '#8f3f1b', obsidian: '#14121d', crying_obsidian: '#21093f', bedrock: '#555555',
  netherrack: '#6f3534', soul_sand: '#513e32', soul_soil: '#4b392e', basalt: '#4b4b50', blackstone: '#2a2328',
  crimson_nylium: '#8b1e1e', warped_nylium: '#2b7265', end_stone: '#dbdea0',
  sandstone: '#d8cb9b', smooth_sandstone: '#d8cb9b', red_sandstone: '#b5621f', terracotta: '#985f45',
  lily_pad: '#2a7a27', sugar_cane: '#94c065', cactus: '#5d8f2f', pumpkin: '#c27416', melon: '#71922b', hay_block: '#a68a0f',
  bamboo: '#5d9a2c', vine: '#4f7c26', glow_lichen: '#708276', dead_bush: '#7d5c33', sweet_berry_bush: '#3f6d34',
  torch: '#fbd65a', wall_torch: '#fbd65a', lantern: '#e9b04a', campfire: '#b06a32', glass: '#bfd9dc', glass_pane: '#bfd9dc',
  bricks: '#966153', stone_bricks: '#7a7a7a', mossy_stone_bricks: '#6f7a5f', bookshelf: '#6b5130', crafting_table: '#7a5a34',
  furnace: '#6e6e6e', chest: '#a77b3a', barrel: '#87643a', iron_block: '#d8d8d8', gold_block: '#f5da2a', diamond_block: '#62ede4',
  emerald_block: '#2ecb6b', redstone_block: '#ab1b09', lapis_block: '#1e4ba3', coal_block: '#101010', tnt: '#c63a25',
  quartz_block: '#ece6df', prismarine: '#63a89a', sea_lantern: '#c6dcd4', sponge: '#c8c64d', slime_block: '#6fc05b',
  cherry_leaves: '#f1b6d3', azalea_leaves: '#5d7d2c', flowering_azalea_leaves: '#6d7d48', mangrove_leaves: '#4c8a2c',
  oak_leaves: '#4b7a2a', dark_oak_leaves: '#3a5e1f', birch_leaves: '#6b8c4a', spruce_leaves: '#3c5c3c',
  jungle_leaves: '#3f8a1f', acacia_leaves: '#58872b', pale_oak_leaves: '#7d8378',
  oak_log: '#6b5130', spruce_log: '#3a2a16', birch_log: '#d7d3c5', jungle_log: '#56441c', acacia_log: '#676157',
  dark_oak_log: '#3c2e1a', mangrove_log: '#544023', cherry_log: '#3a2125'
};
const RULES = [
  [/leaves/, '#4b7a2a'], [/_log$|_wood$|stem$|hyphae$/, '#6b5130'], [/planks|_stairs$|_slab$|fence|door|trapdoor|sign/, '#a2824e'],
  [/glass/, '#bfd9dc'], [/flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily_of|rose|peony|lilac|sunflower/, '#d14a5a'],
  [/mushroom/, '#a33f2e'], [/coral/, '#c5528a'], [/ore$/, '#7d7d7d'], [/copper/, '#c06a4f'], [/stone|deepslate|cobble|brick/, '#7a7a7a'],
  [/sand/, '#d8cb9b'], [/snow/, '#f9fefe'], [/ice/, '#91b4fe'], [/rail/, '#8f7b5c'], [/carpet|bed$/, null]
];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const cache = new Map();
function colorOf(name) {
  if (cache.has(name)) return cache.get(name);
  const id = name.replace(/^minecraft:/, '');
  let c = EXACT[id];
  if (!c) {
    const dye = Object.keys(DYE).sort((a, b) => b.length - a.length).find((d) => id.startsWith(d + '_'));
    if (dye) c = DYE[dye];
  }
  if (!c) for (const [re, col] of RULES) if (re.test(id)) { c = col || '#8a8a8a'; break; }
  const rgb = hex(c || '#8a8a8a');
  const water = /water|seagrass|kelp|bubble_column/.test(id);
  const v = { rgb, water };
  cache.set(name, v);
  return v;
}

/* ---------- длинные массивы NBT ---------- */
function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (Array.isArray(v)) return (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0);
  return BigInt(v);
}
// значения упакованы в 64-битные числа; в новых версиях без переноса между числами
function unpack(longs, bits, count, spanning) {
  const out = new Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  if (!spanning) {
    const per = Math.floor(64 / bits);
    for (let i = 0; i < count; i++) {
      const l = toBig(longs[Math.floor(i / per)]);
      out[i] = Number((BigInt.asUintN(64, l) >> BigInt((i % per) * bits)) & mask);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const bit = i * bits;
      const li = Math.floor(bit / 64);
      const off = bit % 64;
      let v = BigInt.asUintN(64, toBig(longs[li])) >> BigInt(off);
      if (off + bits > 64) v |= BigInt.asUintN(64, toBig(longs[li + 1])) << BigInt(64 - off);
      out[i] = Number(v & mask);
    }
  }
  return out;
}

/* ---------- один чанк ---------- */
function readChunk(data) {
  const root = data.Level || data;
  const dv = data.DataVersion || 0;
  if (dv && dv < 1451) return { legacy: true }; // до 1.13 — числовые ID блоков
  const hm = root.Heightmaps && (root.Heightmaps.WORLD_SURFACE || root.Heightmaps.MOTION_BLOCKING);
  const sections = root.sections || root.Sections || [];
  if (!hm || !sections.length) return null;
  const spanning = dv < 2556; // до 1.16 значения переходили через границу long
  const heights = unpack(hm, 9, 256, spanning);
  const minY = dv >= 2825 ? -64 : 0;

  const bySec = new Map();
  for (const s of sections) {
    const bs = s.block_states || s;
    const palette = bs.palette || bs.Palette;
    if (!palette || !palette.length) continue;
    const longs = bs.data || bs.BlockStates;
    const names = palette.map((p) => p.Name);
    let idx = null;
    if (longs && longs.length && names.length > 1) {
      const bits = Math.max(4, Math.ceil(Math.log2(names.length)));
      idx = unpack(longs, bits, 4096, spanning);
    }
    bySec.set(s.Y, { names, idx });
  }

  const cols = new Array(256);
  for (let i = 0; i < 256; i++) {
    const h = heights[i];
    if (!h) { cols[i] = null; continue; }
    const y = h - 1 + minY;
    const sec = bySec.get(Math.floor(y / 16));
    if (!sec) { cols[i] = null; continue; }
    const x = i & 15;
    const z = i >> 4;
    const li = ((y & 15) * 16 + z) * 16 + x;
    const name = sec.idx ? sec.names[sec.idx[li]] : sec.names[0];
    cols[i] = { name, y };
  }
  return { x: root.xPos, z: root.zPos, cols };
}

function decompress(buf, type) {
  if (type === 2) return zlib.inflateSync(buf);
  if (type === 1) return zlib.gunzipSync(buf);
  if (type === 3) return buf;
  return null; // lz4 и прочее пропускаем
}

/* ---------- регион 32×32 чанка → картинка 512×512 ---------- */
async function renderRegion(file, onYield) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8192) return null;
  const rgba = Buffer.alloc(512 * 512 * 4);
  const height = new Int16Array(512 * 512).fill(-32768);
  let any = false;
  let legacy = false;
  for (let i = 0; i < 1024; i++) {
    const loc = buf.readUInt32BE(i * 4);
    const offset = (loc >>> 8) * 4096;
    if (!offset || offset + 5 > buf.length) continue;
    const len = buf.readUInt32BE(offset);
    const type = buf[offset + 4];
    let chunk;
    try {
      const raw = decompress(buf.subarray(offset + 5, offset + 4 + len), type);
      if (!raw) continue;
      const parsed = nbt.simplify(nbt.parseUncompressed(raw, 'big'));
      chunk = readChunk(parsed);
    } catch { continue; }
    if (!chunk) continue;
    if (chunk.legacy) { legacy = true; continue; }
    const cx = ((chunk.x % 32) + 32) % 32;
    const cz = ((chunk.z % 32) + 32) % 32;
    for (let c = 0; c < 256; c++) {
      const col = chunk.cols[c];
      if (!col) continue;
      const px = cx * 16 + (c & 15);
      const pz = cz * 16 + (c >> 4);
      const p = pz * 512 + px;
      const { rgb, water } = colorOf(col.name);
      height[p] = water ? -1000 : col.y;
      rgba[p * 4] = rgb[0]; rgba[p * 4 + 1] = rgb[1]; rgba[p * 4 + 2] = rgb[2]; rgba[p * 4 + 3] = 255;
      any = true;
    }
    if (i % 48 === 47 && onYield) await onYield();
  }
  if (!any) return legacy ? { legacy: true } : null;

  // «рельеф»: блок выше северного соседа — светлее, ниже — темнее
  for (let z = 1; z < 512; z++) {
    for (let x = 0; x < 512; x++) {
      const p = z * 512 + x;
      const h = height[p];
      const n = height[p - 512];
      if (h === -32768 || n === -32768 || h === -1000 || n === -1000) continue;
      const f = h > n ? 1.14 : h < n ? 0.82 : 1;
      if (f === 1) continue;
      for (let k = 0; k < 3; k++) rgba[p * 4 + k] = Math.min(255, Math.round(rgba[p * 4 + k] * f));
    }
  }
  return { rgba };
}

/* ---------- игрок и спавн из level.dat ---------- */
async function readLevel(worldDir) {
  try {
    const { parsed } = await nbt.parse(fs.readFileSync(path.join(worldDir, 'level.dat')));
    const d = nbt.simplify(parsed).Data || {};
    const pos = d.Player && d.Player.Pos;
    const spawn = d.spawn && d.spawn.pos
      ? { x: d.spawn.pos[0], z: d.spawn.pos[2] }
      : (d.SpawnX != null ? { x: d.SpawnX, z: d.SpawnZ } : null);
    return {
      name: d.LevelName || path.basename(worldDir),
      player: pos ? { x: Math.floor(pos[0]), z: Math.floor(pos[2]) } : null,
      spawn
    };
  } catch {
    return { name: path.basename(worldDir), player: null, spawn: null };
  }
}

module.exports = { renderRegion, readLevel, _test: { readChunk, unpack, colorOf } };
