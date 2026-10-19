const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Client, Authenticator } = require('minecraft-launcher-core');
const extractZip = require('extract-zip');
const modrinth = require('./modrinth');

const DATA = path.join(app.getPath('appData'), '.sigmalauncher');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const JAVA_DIR = path.join(DATA, 'java');
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const DEFAULTS = {
  nickname: 'Player',
  version: null,
  showSnapshots: false,
  showOld: false,
  ramMax: 4096,
  ramMin: 1024,
  width: 1280,
  height: 720,
  fullscreen: false,
  gameDir: path.join(DATA, 'minecraft'),
  jvmArgs: '',
  customJava: '',
  closeOnLaunch: true,
  skinEnabled: true,
  discordRpc: true,
  profiles: null,
  activeProfile: 'default',
  bedrockServers: [
    { name: 'The Hive', host: 'geo.hivebedrock.network', port: 19132 },
    { name: 'CubeCraft', host: 'mco.cubecraft.net', port: 19132 },
    { name: 'Lifeboat', host: 'mco.lbsg.net', port: 19132 }
  ]
};

const SKIN_FILE = path.join(DATA, 'skin.png');
const PACK_NAME = 'SigmaSkin.zip';
const PKG = require('../package.json');
const APP_VERSION = PKG.version;
const UPDATE_REPO = (PKG.updateRepo || '').trim();

const stats = require('./stats')(DATA);
const discord = require('./discord')(String(PKG.discordClientId || '').trim());

let win = null;
let manifestCache = null;
let gameRunning = false;
let pendingUpdate = null;

/* ---------- settings + сборки ---------- */
function readRaw() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function writeRaw(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function ensureProfiles(s) {
  if (!Array.isArray(s.profiles) || !s.profiles.length) {
    s.profiles = [{ id: 'default', name: 'Основная', version: s.version || null, loader: 'vanilla', ramMax: null, content: {}, created: Date.now() }];
  }
  if (!s.profiles.find((p) => p.id === s.activeProfile)) s.activeProfile = s.profiles[0].id;
  return s;
}
function activeProfile(s) {
  return s.profiles.find((p) => p.id === s.activeProfile) || s.profiles[0];
}
// у основной сборки — общая папка игры (старые миры остаются на месте)
function profileDir(s, p) {
  return p.id === 'default' ? s.gameDir : path.join(DATA, 'profiles', p.id);
}

function loadSettings() {
  const s = ensureProfiles(readRaw());
  const p = activeProfile(s);
  s.version = p.version;
  s.profile = { ...p, dir: profileDir(s, p) };
  return s;
}
function saveSettings(patch) {
  const s = ensureProfiles(readRaw());
  const { profile, ...rest } = patch;
  Object.assign(s, rest);
  if ('version' in patch) activeProfile(s).version = patch.version;
  writeRaw(s);
}
function updateProfile(id, fn) {
  const s = ensureProfiles(readRaw());
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error('Сборка не найдена');
  fn(p, s);
  writeRaw(s);
  return p;
}

/* ---------- helpers ---------- */
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

async function getManifest() {
  if (!manifestCache) manifestCache = await getJson(MANIFEST_URL);
  return manifestCache;
}

function isInstalled(gameDir, id) {
  return fs.existsSync(path.join(gameDir, 'versions', id, `${id}.jar`));
}

/* ---------- Java auto-download (Eclipse Temurin) ---------- */
function pickJava(major) {
  if (!major || major <= 8) return 8;
  if (major <= 17) return 17;
  if (major <= 21) return 21;
  return major;
}

function findJavaBin(dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}

async function ensureJava(major) {
  const ver = pickJava(major);
  const target = path.join(JAVA_DIR, String(ver));
  const existing = fs.existsSync(target) && findJavaBin(target);
  if (existing) return existing;

  const osName = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${ver}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;

  send('status', { text: `Скачиваю Java ${ver}...`, percent: 0 });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не удалось скачать Java ${ver} (HTTP ${r.status})`);

  const total = Number(r.headers.get('content-length')) || 0;
  const isZip = process.platform === 'win32';
  const archive = path.join(JAVA_DIR, `java${ver}.${isZip ? 'zip' : 'tar.gz'}`);
  fs.mkdirSync(target, { recursive: true });

  let done = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    done += c.length;
    if (total) send('status', { text: `Скачиваю Java ${ver}...`, percent: (done / total) * 100 });
  });
  await pipeline(body, fs.createWriteStream(archive));

  send('status', { text: `Распаковываю Java ${ver}...`, percent: 100 });
  if (isZip) {
    await extractZip(archive, { dir: target });
  } else {
    await new Promise((res, rej) =>
      execFile('tar', ['-xzf', archive, '-C', target], (e) => (e ? rej(e) : res()))
    );
  }
  fs.rmSync(archive, { force: true });

  const bin = findJavaBin(target);
  if (!bin) throw new Error('Java скачана, но исполняемый файл не найден');
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

/* ---------- natives for old versions (fix MCLC duplicate-unlink bug) ---------- */
const AdmZip = require('adm-zip');
const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];

function libAllowed(lib) {
  if (!lib.rules) return true;
  let allowed = false;
  for (const r of lib.rules) {
    const match = !r.os || r.os.name === OS_NAME;
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

async function prepareNatives(vjson, gameDir) {
  const dir = path.join(gameDir, 'natives', vjson.id);
  const marker = path.join(dir, '.sigma-ok');
  if (fs.existsSync(marker)) return;

  const list = new Map();
  for (const lib of vjson.libraries || []) {
    const cls = lib.downloads?.classifiers;
    if (!cls || !libAllowed(lib)) continue;
    let key = lib.natives?.[OS_NAME] || `natives-${OS_NAME}`;
    key = key.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
    const n = cls[key] || (OS_NAME === 'osx' ? cls['natives-macos'] : null);
    if (n && !list.has(n.url)) list.set(n.url, n);
  }
  if (!list.size) return;

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let i = 0;
  for (const n of list.values()) {
    send('status', { text: 'Скачиваю нативные библиотеки...', percent: (i++ / list.size) * 100 });
    const r = await fetch(n.url);
    if (!r.ok) throw new Error(`Не удалось скачать ${n.url}`);
    const zip = new AdmZip(Buffer.from(await r.arrayBuffer()));
    for (const e of zip.getEntries()) {
      if (e.isDirectory || e.entryName.startsWith('META-INF')) continue;
      zip.extractEntryTo(e, dir, true, true);
    }
  }
  fs.writeFileSync(marker, '1');
}

/* ---------- skin (local resource pack overriding default skins) ---------- */
const { nativeImage } = require('electron');
const DEFAULT_SKINS = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'];

function readOptions(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}

function setPackInOptions(gameDir, enable, modern) {
  const file = path.join(gameDir, 'options.txt');
  const lines = readOptions(file);
  const entry = modern ? `file/${PACK_NAME}` : PACK_NAME;

  const edit = (key, add, ensureVanilla) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    let arr = [];
    if (i >= 0) { try { arr = JSON.parse(lines[i].slice(key.length + 1)); } catch { arr = []; } }
    arr = arr.filter((x) => x !== PACK_NAME && x !== `file/${PACK_NAME}`);
    if (add) {
      if (ensureVanilla && !arr.includes('vanilla')) arr.unshift('vanilla');
      arr.push(entry);
    }
    const line = `${key}:${JSON.stringify(arr)}`;
    if (i >= 0) lines[i] = line;
    else if (add) lines.push(line);
  };

  edit('resourcePacks', enable, modern);
  if (modern) edit('incompatibleResourcePacks', enable, false);
  fs.writeFileSync(file, lines.filter((l, idx) => l || idx < lines.length - 1).join('\n') + '\n');
}

function applySkin(vjson, gameDir) {
  const t = new Date(vjson.releaseTime).getTime();
  const SUPPORT_FROM = Date.parse('2013-06-13'); // 13w24a — resource packs
  const SKIN64_FROM = Date.parse('2014-01-16');  // 14w03a — 64x64 skins
  const MODERN_OPTS = Date.parse('2017-10-25');  // 17w43a+ — "file/" prefix
  const s = loadSettings();
  const modern = t >= MODERN_OPTS;
  const packPath = path.join(gameDir, 'resourcepacks', PACK_NAME);

  if (!s.skinEnabled || !fs.existsSync(SKIN_FILE) || t < SUPPORT_FROM) {
    fs.rmSync(packPath, { force: true });
    if (fs.existsSync(path.join(gameDir, 'options.txt'))) setPackInOptions(gameDir, false, modern);
    if (s.skinEnabled && fs.existsSync(SKIN_FILE) && t < SUPPORT_FROM) {
      send('log', '[skin] Эта версия слишком старая для скинов (нужна 1.6+)');
    }
    return;
  }

  let img = nativeImage.createFromPath(SKIN_FILE);
  if (t < SKIN64_FROM) img = img.crop({ x: 0, y: 0, width: 64, height: 32 });
  const png = img.toPNG();

  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({
    pack: {
      pack_format: 1,
      supported_formats: [1, 9999],
      min_format: 1,
      max_format: 9999,
      description: 'Sigma Launcher skin'
    }
  }, null, 2)));
  const base = 'assets/minecraft/textures/entity/';
  zip.addFile(`${base}steve.png`, png);
  zip.addFile(`${base}alex.png`, png);
  for (const n of DEFAULT_SKINS) {
    zip.addFile(`${base}player/wide/${n}.png`, png);
    zip.addFile(`${base}player/slim/${n}.png`, png);
  }
  fs.mkdirSync(path.dirname(packPath), { recursive: true });
  zip.writeZip(packPath);
  setPackInOptions(gameDir, true, modern);
  send('log', '[skin] Скин применён');
}

ipcMain.handle('skin:get', () =>
  fs.existsSync(SKIN_FILE) ? 'data:image/png;base64,' + fs.readFileSync(SKIN_FILE).toString('base64') : null
);
ipcMain.handle('skin:set', (_e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  const { width, height } = img.getSize();
  if (width !== 64 || height !== 64) throw new Error('Скин должен быть 64×64');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SKIN_FILE, img.toPNG());
  return true;
});
ipcMain.handle('skin:remove', () => { fs.rmSync(SKIN_FILE, { force: true }); return true; });

/* ---------- Bedrock ---------- */
const dgram = require('dgram');
const BEDROCK_STORE = 'ms-windows-store://pdp/?productid=9NBLGGH2JHXJ';

ipcMain.handle('bedrock:status', () => new Promise((resolve) => {
  if (process.platform !== 'win32') return resolve({ supported: false, installed: false });
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage -Name Microsoft.MinecraftUWP | Select-Object -First 1).Version'],
  { timeout: 15000, windowsHide: true }, (err, out) => {
    const version = String(out || '').trim();
    resolve({ supported: true, installed: !err && !!version, version });
  });
}));

ipcMain.handle('bedrock:launch', () => shell.openExternal('minecraft:'));
ipcMain.handle('bedrock:store', () => shell.openExternal(BEDROCK_STORE));
ipcMain.handle('bedrock:connect', (_e, host, port) =>
  shell.openExternal(`minecraft://connect/?serverUrl=${encodeURIComponent(host)}&serverPort=${Number(port) || 19132}`)
);

// RakNet unconnected ping — онлайн, версия и пинг сервера
ipcMain.handle('bedrock:ping', (_e, host, port) => new Promise((resolve) => {
  const sock = dgram.createSocket('udp4');
  const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
  const pkt = Buffer.alloc(33);
  pkt[0] = 0x01;
  pkt.writeBigInt64BE(BigInt(Date.now()), 1);
  MAGIC.copy(pkt, 9);
  pkt.writeBigInt64BE(BigInt(Math.floor(Math.random() * 1e15)), 25);
  const started = Date.now();
  const done = (r) => { clearTimeout(t); try { sock.close(); } catch {} resolve(r); };
  const t = setTimeout(() => done({ online: false }), 3000);
  sock.on('error', () => done({ online: false }));
  sock.on('message', (msg) => {
    if (msg[0] !== 0x1c) return;
    const len = msg.readUInt16BE(33);
    const parts = msg.slice(35, 35 + len).toString('utf8').split(';');
    done({
      online: true,
      ping: Date.now() - started,
      motd: (parts[1] || '').replace(/§./g, ''),
      version: parts[3] || '',
      players: Number(parts[4]) || 0,
      max: Number(parts[5]) || 0
    });
  });
  sock.send(pkt, Number(port) || 19132, host, (e) => e && done({ online: false }));
}));

/* ---------- self-update ---------- */
// Окно «Перезапуск…»: живёт, пока старый exe заменяется и новая версия не откроется
function startRestartSplash(tmp, exe, version) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$tmp = ${q(tmp)}
$exe = ${q(exe)}
$ver = ${q(version)}

$bg   = [System.Drawing.Color]::FromArgb(17, 20, 27)
$green = [System.Drawing.Color]::FromArgb(74, 222, 128)
$muted = [System.Drawing.Color]::FromArgb(138, 147, 166)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Обновление Sigma Launcher'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(400, 170)
$form.BackColor = $bg
$form.TopMost = $true
$form.Add_Paint({ param($s, $e)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 44, 57), 2)
  $e.Graphics.DrawRectangle($pen, 1, 1, $form.Width - 2, $form.Height - 2)
})

function Add-Label($text, $y, $size, $color, $bold) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.ForeColor = $color
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $style)
  $l.AutoSize = $false
  $l.Size = New-Object System.Drawing.Size(352, ([int]($size * 2.2)))
  $l.Location = New-Object System.Drawing.Point(24, $y)
  $form.Controls.Add($l)
  return $l
}

Add-Label 'SIGMA launcher' 18 9 $green $true | Out-Null
Add-Label "Обновление до v$ver" 42 14 ([System.Drawing.Color]::White) $true | Out-Null
$status = Add-Label 'Устанавливаю обновление...' 80 10 $muted $false

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 25
$bar.Size = New-Object System.Drawing.Size(352, 8)
$bar.Location = New-Object System.Drawing.Point(24, 126)
$form.Controls.Add($bar)

$script:state = 0
$script:start = Get-Date
$script:launched = $null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  $elapsed = ((Get-Date) - $script:start).TotalSeconds
  if ($script:state -eq 0) {
    try {
      Move-Item -LiteralPath $tmp -Destination $exe -Force -ErrorAction Stop
      $script:state = 1
      $status.Text = 'Запускаю новую версию...'
      Start-Process -FilePath $exe
      $script:launched = Get-Date
    } catch {
      if ($elapsed -gt 60) {
        $script:state = 9
        $status.Text = 'Не получилось заменить файл. Запусти лаунчер вручную.'
        $bar.Visible = $false
      }
    }
  } elseif ($script:state -eq 1) {
    $ready = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -ne $PID -and $_.MainWindowTitle -eq 'Sigma Launcher' }
    if ($ready -or ((Get-Date) - $script:launched).TotalSeconds -gt 90) { $timer.Stop(); $form.Close() }
  } elseif ($elapsed -gt 75) {
    $timer.Stop(); $form.Close()
  }
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
  const file = path.join(os.tmpdir(), `sigma-update-${Date.now()}.ps1`);
  // BOM — чтобы Windows PowerShell правильно прочитал русский текст
  fs.writeFileSync(file, '\ufeff' + ps.replace(/\n/g, '\r\n'), 'utf8');
  const child = require('child_process').spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
    { detached: true, stdio: 'ignore', windowsHide: true });
  // запасной вариант без окна, если PowerShell недоступен
  child.on('error', () => {
    const bat = path.join(os.tmpdir(), `sigma-update-${Date.now()}.cmd`);
    fs.writeFileSync(bat, [
      '@echo off', ':wait', 'timeout /t 1 /nobreak >nul',
      `move /y "${tmp}" "${exe}" >nul 2>&1 || goto wait`,
      `start "" "${exe}"`, 'del "%~f0"'
    ].join('\r\n'));
    require('child_process').spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  child.unref();
}

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// всегда берём самый последний релиз — промежуточные версии пропускаются
async function fetchLatestRelease() {
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SigmaLauncher' }
  });
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
  const rel = await r.json();
  const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.exe'));
  const version = String(rel.tag_name || '').replace(/^v/, '');
  return asset && version ? { version, url: asset.browser_download_url } : null;
}

ipcMain.handle('update:check', async () => {
  if (!UPDATE_REPO) return { available: false };
  try {
    const rel = await fetchLatestRelease();
    if (rel && newer(rel.version, APP_VERSION)) {
      pendingUpdate = rel;
      return { available: true, version: rel.version, notes: '' };
    }
    return { available: false, latest: rel?.version };
  } catch (e) {
    return { available: false, error: e.message.startsWith('GitHub') ? e.message : 'нет связи с GitHub' };
  }
});

ipcMain.handle('update:install', async () => {
  if (!pendingUpdate) return false;
  // перед скачиванием ещё раз проверяем: вдруг пока лаунчер был открыт, вышла версия ещё новее
  try {
    const rel = await fetchLatestRelease();
    if (rel && newer(rel.version, pendingUpdate.version)) pendingUpdate = rel;
  } catch { /* качаем то, что уже нашли */ }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exe) { shell.openExternal(pendingUpdate.url); return false; }

  const tmp = exe + '.new';
  const r = await fetch(pendingUpdate.url);
  if (!r.ok) throw new Error(`Не удалось скачать обновление (HTTP ${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    done += c.length;
    send('status', { text: `Скачиваю обновление v${pendingUpdate.version}...`, percent: total ? (done / total) * 100 : 0 });
  });
  await pipeline(body, fs.createWriteStream(tmp));
  if (fs.statSync(tmp).size < 1024 * 1024) {
    fs.rmSync(tmp, { force: true });
    throw new Error('Скачанный файл обновления повреждён, попробуй ещё раз');
  }

  send('status', { text: 'Перезапуск...', percent: 100 });
  startRestartSplash(tmp, exe, pendingUpdate.version);
  setTimeout(() => app.quit(), 800);
  return true;
});

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 900,
    minHeight: 580,
    frame: false,
    backgroundColor: '#0d0f14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

/* ---------- IPC ---------- */
ipcMain.on('win:min', () => win.minimize());
ipcMain.on('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, s) => { saveSettings(s); return loadSettings(); });
ipcMain.handle('settings:reset', () => {
  const s = ensureProfiles(readRaw());
  const { profiles, activeProfile: ap, bedrockServers } = s;
  writeRaw({ ...DEFAULTS, profiles, activeProfile: ap, bedrockServers });
  return loadSettings();
});

ipcMain.handle('system:info', () => ({
  totalRam: Math.floor(os.totalmem() / 1024 / 1024),
  platform: process.platform,
  version: APP_VERSION
}));

ipcMain.handle('versions:list', async () => {
  const s = loadSettings();
  const m = await getManifest();
  return {
    latest: m.latest,
    versions: m.versions.map((v) => ({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime,
      installed: isInstalled(s.gameDir, v.id)
    }))
  };
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:java', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open:folder', (_e, which) => {
  const s = loadSettings();
  const g = s.profile.dir;
  const map = {
    game: g,
    mods: path.join(g, 'mods'),
    screenshots: path.join(g, 'screenshots'),
    resourcepacks: path.join(g, 'resourcepacks'),
    shaderpacks: path.join(g, 'shaderpacks'),
    saves: path.join(g, 'saves')
  };
  const dir = map[which] || g;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('version:delete', (_e, id) => {
  const s = loadSettings();
  fs.rmSync(path.join(s.gameDir, 'versions', id), { recursive: true, force: true });
  return true;
});

/* ---------- сборки (IPC) ---------- */
const profileView = (s, p, st) => ({
  ...p,
  dir: profileDir(s, p),
  active: p.id === s.activeProfile,
  playtime: st.byProfile[p.id] || 0,
  counts: Object.values(p.content || {}).reduce((a, c) => { a[c.type] = (a[c.type] || 0) + 1; return a; }, {})
});

ipcMain.handle('profiles:list', () => {
  const s = loadSettings();
  const st = stats.get();
  return s.profiles.map((p) => profileView(s, p, st));
});

ipcMain.handle('profiles:save', (_e, data) => {
  const s = ensureProfiles(readRaw());
  const clean = {
    name: String(data.name || '').trim().slice(0, 32) || 'Новая сборка',
    version: data.version || null,
    loader: data.loader === 'fabric' ? 'fabric' : 'vanilla',
    ramMax: data.ramMax ? Number(data.ramMax) : null,
    color: data.color || null
  };
  let p = s.profiles.find((x) => x.id === data.id);
  if (p) Object.assign(p, clean);
  else {
    p = { id: 'p' + Date.now().toString(36), content: {}, created: Date.now(), ...clean };
    s.profiles.push(p);
    s.activeProfile = p.id;
  }
  writeRaw(s);
  return p.id;
});

ipcMain.handle('profiles:select', (_e, id) => { saveSettings({ activeProfile: id }); return loadSettings(); });

ipcMain.handle('profiles:delete', (_e, id) => {
  if (id === 'default') throw new Error('Основную сборку удалить нельзя');
  const s = ensureProfiles(readRaw());
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.activeProfile === id) s.activeProfile = 'default';
  writeRaw(s);
  fs.rmSync(path.join(DATA, 'profiles', id), { recursive: true, force: true });
  return true;
});

ipcMain.handle('profiles:open', (_e, id) => {
  const s = loadSettings();
  const p = s.profiles.find((x) => x.id === id);
  if (!p) return;
  const dir = profileDir(s, p);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('fabric:supported', async (_e, mc) => {
  try { return await modrinth.fabricSupports(mc); } catch { return false; }
});

/* ---------- Iris: включить/выключить шейдер ---------- */
function setIrisShader(gameDir, file) {
  const cfgDir = path.join(gameDir, 'config');
  const cfg = path.join(cfgDir, 'iris.properties');
  let lines = [];
  try { lines = fs.readFileSync(cfg, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* файла ещё нет */ }
  const set = (k, v) => {
    const i = lines.findIndex((l) => l.startsWith(k + '='));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  };
  if (file) { set('shaderPack', file); set('enableShaders', 'true'); }
  else set('enableShaders', 'false');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfg, lines.join('\n') + '\n');
}
function activeIrisShader(gameDir) {
  try {
    const m = fs.readFileSync(path.join(gameDir, 'config', 'iris.properties'), 'utf8').match(/^shaderPack=(.*)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/* ---------- Modrinth (IPC) ---------- */
async function currentMc(s) {
  if (s.version) return s.version;
  return (await getManifest()).latest.release;
}

ipcMain.handle('mr:search', async (_e, q) => {
  const s = loadSettings();
  const mc = await currentMc(s);
  const r = await modrinth.search({ ...q, mc });
  const content = s.profile.content || {};
  r.hits.forEach((h) => { h.installed = !!content[h.id]; });
  return { ...r, mc };
});

ipcMain.handle('mr:installed', () => {
  const s = loadSettings();
  return Object.values(s.profile.content || {});
});

let mrBusy = false;
ipcMain.handle('mr:install', async (_e, { id, type }) => {
  if (mrBusy) throw new Error('Подожди, идёт другая установка');
  if (gameRunning) throw new Error('Закрой игру перед установкой');
  mrBusy = true;
  try {
    const s = loadSettings();
    const p = s.profile;
    const mc = await currentMc(s);
    let switched = false;
    if ((type === 'mod' || type === 'shader') && p.loader !== 'fabric') {
      if (!(await modrinth.fabricSupports(mc))) throw new Error(`Моды работают с 1.14 и новее, а у сборки ${mc}`);
      switched = true;
    }
    const content = { ...(p.content || {}) };
    const log = (l) => send('log', l);
    if (type === 'shader' && !content.YL57xq9U) { // Iris
      await modrinth.install({ project: 'iris', type: 'mod', mc, gameDir: p.dir, content, log, depth: 1 });
    }
    const item = await modrinth.install({ project: id, type, mc, gameDir: p.dir, content, log });
    if (type === 'shader' && item) {
      setIrisShader(p.dir, item.file);
      log(`[mods] Шейдер ${item.title} включён — он заработает при следующем запуске`);
    }
    updateProfile(p.id, (prof) => {
      prof.content = content;
      if (switched) prof.loader = 'fabric';
      if (!prof.version) prof.version = mc;
    });
    return { item, switched };
  } finally {
    mrBusy = false;
  }
});

/* ---------- готовые сборки ---------- */
const PRESETS = {
  fps: {
    name: 'Максимум FPS', color: '#fbbf24',
    items: [
      { p: 'sodium', t: 'mod' }, { p: 'lithium', t: 'mod' }, { p: 'ferrite-core', t: 'mod' },
      { p: 'entityculling', t: 'mod' }, { p: 'immediatelyfast', t: 'mod' }, { p: 'modernfix', t: 'mod' }
    ]
  },
  beauty: {
    name: 'Красивая графика', color: '#a78bfa',
    items: [
      { p: 'sodium', t: 'mod' }, { p: 'iris', t: 'mod' },
      { p: 'makeup-ultra-fast-shaders', q: 'MakeUp Ultra Fast', t: 'shader' }
    ]
  },
  comfort: {
    name: 'Удобная игра', color: '#60a5fa',
    items: [
      { p: 'sodium', t: 'mod' }, { p: 'xaeros-minimap', q: "Xaero's Minimap", t: 'mod' },
      { p: 'appleskin', t: 'mod' }, { p: 'jade', t: 'mod' }, { p: 'mouse-tweaks', q: 'Mouse Tweaks', t: 'mod' }
    ]
  }
};

async function presetVersion() {
  const releases = (await getManifest()).versions.filter((v) => v.type === 'release').slice(0, 8);
  for (const v of releases) {
    try {
      if (await modrinth.fabricSupports(v.id) && await modrinth.latestVersion('sodium', 'mod', v.id)) return v.id;
    } catch { /* пробуем следующую */ }
  }
  throw new Error('Не удалось подобрать версию — проверь интернет');
}

ipcMain.handle('presets:create', async (_e, key) => {
  const preset = PRESETS[key];
  if (!preset) throw new Error('Нет такой сборки');
  if (mrBusy) throw new Error('Подожди, идёт другая установка');
  if (gameRunning) throw new Error('Закрой игру перед установкой');
  mrBusy = true;
  try {
    const progress = (text, i) => send('preset-progress', { key, text, i, n: preset.items.length });
    progress('Подбираю версию...', 0);
    const mc = await presetVersion();

    const s = ensureProfiles(readRaw());
    const id = 'p' + Date.now().toString(36);
    const prof = { id, name: preset.name, version: mc, loader: 'fabric', ramMax: null, color: preset.color, content: {}, created: Date.now() };
    s.profiles.push(prof);
    s.activeProfile = id;
    writeRaw(s);
    const dir = profileDir(s, prof);

    const content = {};
    const failed = [];
    const log = (l) => send('log', l);
    for (let i = 0; i < preset.items.length; i++) {
      const it = preset.items[i];
      progress(`Ставлю ${it.q || it.p} (${i + 1}/${preset.items.length})`, i);
      let item = null;
      try {
        item = await modrinth.install({ project: it.p, type: it.t, mc, gameDir: dir, content, log });
      } catch {
        if (it.q) {
          try {
            const hit = (await modrinth.search({ query: it.q, type: it.t, mc })).hits[0];
            if (hit) item = await modrinth.install({ project: hit.id, type: it.t, mc, gameDir: dir, content, log });
          } catch { /* ниже отметим как не установленный */ }
        }
      }
      if (!item) failed.push(it.q || it.p);
      else if (it.t === 'shader') setIrisShader(dir, item.file);
      updateProfile(id, (p) => { p.content = { ...content }; });
    }
    progress('Готово', preset.items.length);
    return { id, mc, failed };
  } finally {
    mrBusy = false;
  }
});

ipcMain.handle('mr:remove', (_e, id) => {
  const s = loadSettings();
  const content = { ...(s.profile.content || {}) };
  const was = content[id];
  modrinth.remove({ id, gameDir: s.profile.dir, content });
  if (was && was.type === 'shader' && activeIrisShader(s.profile.dir) === was.file) {
    const next = Object.values(content).find((c) => c.type === 'shader');
    setIrisShader(s.profile.dir, next ? next.file : null);
  }
  updateProfile(s.profile.id, (prof) => { prof.content = content; });
  return true;
});

/* ---------- статистика (IPC) ---------- */
ipcMain.handle('stats:get', () => {
  const s = loadSettings();
  const names = Object.fromEntries(s.profiles.map((p) => [p.id, p.name]));
  return { ...stats.get(), profileNames: names };
});
ipcMain.handle('stats:reset', () => { stats.reset(); return true; });
ipcMain.handle('discord:available', () => discord.enabled());

/* ---------- запуск игры ---------- */
ipcMain.handle('game:launch', async () => {
  if (gameRunning) throw new Error('Игра уже запущена');
  if (pendingUpdate) throw new Error('Сначала обнови лаунчер');
  const s = loadSettings();
  const prof = s.profile;
  const nick = (s.nickname || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
    throw new Error('Ник: 3–16 символов, только латиница, цифры и _');
  }

  const m = await getManifest();
  const entry = m.versions.find((v) => v.id === s.version) ||
    m.versions.find((v) => v.id === m.latest.release);
  if (!entry) throw new Error('Версия не найдена');

  gameRunning = true;
  try {
    send('status', { text: 'Получаю данные версии...', percent: 0 });
    const vjson = await getJson(entry.url);
    const javaPath = s.customJava && fs.existsSync(s.customJava)
      ? s.customJava
      : await ensureJava(vjson.javaVersion?.majorVersion);

    const root = s.gameDir;
    const gameDir = prof.dir;
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
    await prepareNatives(vjson, root);
    try { applySkin(vjson, gameDir); } catch (e) { send('log', `[skin] Ошибка: ${e.message}`); }

    const version = { number: entry.id, type: entry.type };
    if (prof.loader === 'fabric') {
      send('status', { text: 'Готовлю Fabric...', percent: 0 });
      version.custom = await modrinth.ensureFabric(root, entry.id, (l) => send('log', l));
    }

    const ram = Number(prof.ramMax) || Number(s.ramMax) || 4096;
    const launcher = new Client();
    const opts = {
      authorization: Authenticator.getAuth(nick),
      root,
      version,
      memory: { max: `${ram}M`, min: `${Math.min(s.ramMin, ram)}M` },
      javaPath,
      window: s.fullscreen
        ? { fullscreen: true }
        : { width: Number(s.width) || 1280, height: Number(s.height) || 720 },
      customArgs: s.jvmArgs ? s.jvmArgs.split(/\s+/).filter(Boolean) : [],
      overrides: { detached: false, maxSockets: 8, gameDirectory: gameDir, cwd: gameDir }
    };

    let started = 0;
    const session = { version: entry.id, loader: prof.loader, profileId: prof.id, profileName: prof.name };

    launcher.on('debug', (l) => send('log', `[launcher] ${l}`));
    launcher.on('data', (l) => {
      send('log', String(l).trimEnd());
      if (!started) {
        started = Date.now();
        stats.launched();
        send('status', { text: 'Игра запущена', percent: 100, playing: true });
        if (s.closeOnLaunch) win.hide();
        if (s.discordRpc) discord.playing({ version: entry.id, loader: prof.loader, profile: prof.name, start: started });
      }
    });
    launcher.on('progress', (p) => {
      if (p.total) send('status', {
        text: `Загрузка: ${p.type} (${p.task}/${p.total})`,
        percent: (p.task / p.total) * 100
      });
    });
    launcher.on('download-status', (d) => {
      if (d.total && d.total > 1024 * 1024) send('status', {
        text: `Скачиваю ${d.name}`,
        percent: (d.current / d.total) * 100
      });
    });
    launcher.on('close', (code) => {
      gameRunning = false;
      if (started) stats.addSession({ ...session, start: started, ms: Date.now() - started });
      discord.stop();
      if (win.isDestroyed()) return;
      win.show();
      send('status', { text: code === 0 ? 'Готово к игре' : `Игра закрылась с кодом ${code}`, percent: 0, playing: false, finished: true, code });
    });

    const items = Object.values(prof.content || {});
    const shader = activeIrisShader(gameDir);
    send('log', `[sigma] Сборка «${prof.name}» · ${entry.id} · ${prof.loader === 'fabric' ? 'Fabric' : 'Ванилла'}` +
      ` · модов: ${items.filter((c) => c.type === 'mod').length}` +
      (prof.loader === 'fabric' && shader ? ` · шейдер: ${shader}` : ''));
    if (prof.loader !== 'fabric' && items.some((c) => c.type !== 'resourcepack')) {
      send('log', '[sigma] ВНИМАНИЕ: в сборке есть моды, но она запускается без Fabric — моды не загрузятся');
    }

    send('status', { text: 'Проверяю файлы игры...', percent: 0 });
    const proc = await launcher.launch(opts);
    if (!proc) throw new Error('Не удалось запустить игру — смотри консоль');
    return true;
  } catch (e) {
    gameRunning = false;
    throw e;
  }
});

app.on('before-quit', () => discord.destroy());
