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
  optimize: true,
  discordRpc: true,
  profiles: null,
  activeProfile: 'default',
  accent: 'green',
  javaServers: [],
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

/* ---------- производительность ---------- */
// Оптимизированные параметры JVM: меньше фризов от сборщика мусора
const FAST_JVM = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=50',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'
];

// Просим Windows запускать Java на мощной (дискретной) видеокарте
function preferHighPerformanceGpu(javaPath) {
  if (process.platform !== 'win32' || !javaPath) return Promise.resolve();
  const dir = path.dirname(javaPath);
  const exes = ['javaw.exe', 'java.exe'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
  return Promise.all(exes.map((exe) => new Promise((res) => execFile('reg', [
    'add', 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences',
    '/v', exe, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'
  ], { windowsHide: true }, () => res()))));
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
$tmp = ${q(tmp)}
$exe = ${q(exe)}
$ver = ${q(version)}
$script:state = 0

# запасной путь без окна: главное — заменить файл и запустить новую версию
function Finish-Without-UI {
  for ($i = 0; $i -lt 90 -and $script:state -eq 0; $i++) {
    try { Move-Item -LiteralPath $tmp -Destination $exe -Force -ErrorAction Stop; $script:state = 1 }
    catch { Start-Sleep -Seconds 1 }
  }
  if ($script:state -eq 1) { Start-Process -FilePath $exe }
}

try {
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

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
} catch { }
# если окно не смогло показаться или закрылось раньше времени — доделываем без него
if ($script:state -eq 0) { Finish-Without-UI }
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
  const file = path.join(os.tmpdir(), `sigma-update-${Date.now()}.ps1`);
  // BOM — чтобы Windows PowerShell правильно прочитал русский текст
  fs.writeFileSync(file, '\ufeff' + ps.replace(/\n/g, '\r\n'), 'utf8');
  const child = require('child_process').spawn('powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
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

/* ---------- миры ---------- */
function worldSources() {
  const s = loadSettings();
  const list = s.profiles.map((p) => ({ key: 'p:' + p.id, label: `Сборка «${p.name}»`, dir: path.join(profileDir(s, p), 'saves'), current: p.id === s.activeProfile }));
  const mc = path.join(app.getPath('appData'), '.minecraft', 'saves');
  list.push({ key: 'mc', label: 'Обычный Minecraft / TLauncher', dir: mc, current: false });
  return { s, list };
}

ipcMain.handle('worlds:list', () => {
  const { list } = worldSources();
  const out = [];
  for (const src of list) {
    let entries = [];
    try { entries = fs.readdirSync(src.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(src.dir, e.name);
      const level = path.join(dir, 'level.dat');
      if (!fs.existsSync(level)) continue;
      let icon = null;
      try {
        const ip = path.join(dir, 'icon.png');
        if (fs.statSync(ip).size < 200 * 1024) icon = 'data:image/png;base64,' + fs.readFileSync(ip).toString('base64');
      } catch { /* иконки нет */ }
      out.push({ name: e.name, path: dir, source: src.label, sourceKey: src.key, current: src.current, played: fs.statSync(level).mtimeMs, icon });
    }
  }
  return out.sort((a, b) => b.played - a.played);
});

ipcMain.handle('worlds:copy', (_e, from) => {
  if (gameRunning) throw new Error('Закрой игру перед копированием');
  const { s, list } = worldSources();
  if (!list.some((x) => path.resolve(from).startsWith(path.resolve(x.dir) + path.sep))) throw new Error('Неизвестный мир');
  const saves = path.join(s.profile.dir, 'saves');
  fs.mkdirSync(saves, { recursive: true });
  let name = path.basename(from);
  let dest = path.join(saves, name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(saves, `${name} (${i})`);
  fs.cpSync(from, dest, { recursive: true, filter: (src) => path.basename(src) !== 'session.lock' });
  return path.basename(dest);
});

ipcMain.handle('worlds:open', (_e, p) => {
  const { list } = worldSources();
  if (list.some((x) => path.resolve(p).startsWith(path.resolve(x.dir) + path.sep))) shell.openPath(p);
});

/* ---------- карта мира ---------- */
const worldmap = require('./worldmap');
let mapJob = 0;
ipcMain.handle('map:render', async (_e, worldPath) => {
  const { list } = worldSources();
  if (!list.some((x) => path.resolve(worldPath).startsWith(path.resolve(x.dir) + path.sep))) throw new Error('Неизвестный мир');
  const job = ++mapJob;
  const level = await worldmap.readLevel(worldPath);
  const dir = path.join(worldPath, 'region');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^r\.-?\d+\.-?\d+\.mca$/.test(f)); } catch { /* пусто */ }
  const center = level.player || level.spawn || { x: 0, z: 0 };
  const regions = files.map((f) => {
    const [, rx, rz] = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/);
    return { f, rx: +rx, rz: +rz, d: Math.hypot(+rx * 512 + 256 - center.x, +rz * 512 + 256 - center.z) };
  }).sort((a, b) => a.d - b.d).slice(0, 400);

  send('map-start', { job, total: regions.length, ...level });
  let drawn = 0;
  let legacy = false;
  const yieldNow = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < regions.length; i++) {
    if (job !== mapJob) return { cancelled: true };
    const r = regions[i];
    let res = null;
    try { res = await worldmap.renderRegion(path.join(dir, r.f), yieldNow); } catch { /* битый регион */ }
    if (res && res.legacy) legacy = true;
    if (res && res.rgba) {
      drawn++;
      send('map-region', { job, rx: r.rx, rz: r.rz, rgba: res.rgba, done: i + 1, total: regions.length });
    } else {
      send('map-region', { job, done: i + 1, total: regions.length });
    }
    await yieldNow();
  }
  return { job, drawn, total: regions.length, legacy };
});
ipcMain.handle('map:cancel', () => { mapJob++; });
ipcMain.handle('map:save', async (_e, dataUrl, name) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), `${String(name || 'карта').replace(/[\\/:*?"<>|]/g, '_')}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  shell.showItemInFolder(r.filePath);
  return true;
});

/* ---------- серверы Java ---------- */
const slp = require('./slp');
function parseAddr(addr) {
  const m = String(addr || '').trim().match(/^([^\s:]+)(?::(\d{1,5}))?$/);
  return m ? { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null } : null;
}
ipcMain.handle('jservers:ping', async (_e, addr) => {
  const a = parseAddr(addr);
  if (!a) return { online: false };
  let target = { host: a.host, port: a.port || 25565 };
  if (!a.port) target = (await slp.resolveSrv(a.host)) || target;
  return slp.ping(target.host, target.port);
});

/* ---------- скриншоты ---------- */
const { pathToFileURL } = require('url');
function shotDirs() {
  const s = loadSettings();
  return s.profiles.map((p) => ({ profile: p.name, dir: path.join(profileDir(s, p), 'screenshots') }));
}
function isShot(p) {
  return shotDirs().some((d) => path.resolve(path.dirname(p)) === path.resolve(d.dir)) && /\.png$/i.test(p);
}
ipcMain.handle('shots:list', () => {
  const out = [];
  for (const { profile, dir } of shotDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/\.png$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        out.push({ path: full, url: pathToFileURL(full).href, name: f, profile, time: st.mtimeMs, size: st.size });
      } catch { /* файл пропал */ }
    }
  }
  return out.sort((a, b) => b.time - a.time);
});
ipcMain.handle('shots:copy', (_e, p) => {
  if (!isShot(p)) return false;
  require('electron').clipboard.writeImage(nativeImage.createFromPath(p));
  return true;
});
ipcMain.handle('shots:show', (_e, p) => { if (isShot(p)) shell.showItemInFolder(p); });
ipcMain.handle('shots:delete', async (_e, p) => {
  if (!isShot(p)) return false;
  try { await shell.trashItem(p); } catch { fs.rmSync(p, { force: true }); }
  return true;
});

/* ---------- бэкапы миров ---------- */
const BACKUPS = path.join(DATA, 'backups');
ipcMain.handle('backups:create', (_e, worldPath) => {
  if (gameRunning) throw new Error('Закрой игру перед бэкапом — мир может сохраняться прямо сейчас');
  const { list } = worldSources();
  if (!list.some((x) => path.resolve(worldPath).startsWith(path.resolve(x.dir) + path.sep))) throw new Error('Неизвестный мир');
  fs.mkdirSync(BACKUPS, { recursive: true });
  const name = path.basename(worldPath);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const file = path.join(BACKUPS, `${name.replace(/[\\/:*?"<>|]/g, '_')} ${stamp}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(worldPath, name, (f) => !/session\.lock$/.test(f));
  zip.writeZip(file);
  return path.basename(file);
});
ipcMain.handle('backups:list', () => {
  let files = [];
  try { files = fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.zip')); } catch { return []; }
  return files.map((f) => {
    const st = fs.statSync(path.join(BACKUPS, f));
    return { file: f, world: f.replace(/ \d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.zip$/, ''), time: st.mtimeMs, size: st.size };
  }).sort((a, b) => b.time - a.time);
});
ipcMain.handle('backups:restore', (_e, file) => {
  if (gameRunning) throw new Error('Закрой игру перед восстановлением');
  const src = path.join(BACKUPS, path.basename(file));
  if (!fs.existsSync(src)) throw new Error('Бэкап не найден');
  const s = loadSettings();
  const saves = path.join(s.profile.dir, 'saves');
  fs.mkdirSync(saves, { recursive: true });
  const zip = new AdmZip(src);
  const top = zip.getEntries()[0]?.entryName.split('/')[0] || 'Мир';
  let dest = path.join(saves, `${top} (из бэкапа)`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(saves, `${top} (из бэкапа ${i})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-restore-'));
  zip.extractAllTo(tmp, true);
  fs.cpSync(path.join(tmp, top), dest, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  return path.basename(dest);
});
ipcMain.handle('backups:delete', (_e, file) => {
  fs.rmSync(path.join(BACKUPS, path.basename(file)), { force: true });
  return true;
});
ipcMain.handle('backups:open', () => { fs.mkdirSync(BACKUPS, { recursive: true }); shell.openPath(BACKUPS); });

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

/* ---------- автобэкап ---------- */
function dirSize(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* пропал */ } }
      if (total > limit) return total;
    }
  }
  return total;
}
async function autoBackup(gameDir) {
  const saves = path.join(gameDir, 'saves');
  let worlds = [];
  try {
    worlds = fs.readdirSync(saves, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(saves, e.name, 'level.dat')))
      .map((e) => ({ name: e.name, dir: path.join(saves, e.name), t: fs.statSync(path.join(saves, e.name, 'level.dat')).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch { return; }
  const w = worlds[0];
  if (!w) return;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const safe = w.name.replace(/[\\/:*?"<>|]/g, '_');
  const mine = fs.readdirSync(BACKUPS).filter((f) => f.startsWith(`${safe} авто `)).sort();
  const last = mine.length ? fs.statSync(path.join(BACKUPS, mine[mine.length - 1])).mtimeMs : 0;
  if (Date.now() - last < 24 * 3600 * 1000) return; // раз в сутки
  if (dirSize(w.dir, 1024 * 1024 * 1024) > 1024 * 1024 * 1024) { send('log', `[backup] Мир «${w.name}» больше 1 ГБ — автобэкап пропущен`); return; }
  send('status', { text: `Автобэкап мира «${w.name}»...`, percent: 0 });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const zip = new AdmZip();
  zip.addLocalFolder(w.dir, w.name, (f) => !/session\.lock$/.test(f));
  await new Promise((res, rej) => zip.writeZip(path.join(BACKUPS, `${safe} авто ${stamp}.zip`), (err) => (err ? rej(err) : res())));
  // храним 3 последних автобэкапа каждого мира
  for (const old of mine.slice(0, Math.max(0, mine.length - 2))) fs.rmSync(path.join(BACKUPS, old), { force: true });
  send('log', `[backup] Автобэкап «${w.name}» сохранён`);
}

/* ---------- модпаки, обмен сборками, обновление модов ---------- */
const crash = require('./crash');
function newProfile(data) {
  const s = ensureProfiles(readRaw());
  const id = 'p' + Date.now().toString(36);
  const p = { id, content: {}, created: Date.now(), ramMax: null, color: '#60a5fa', ...data };
  s.profiles.push(p);
  s.activeProfile = id;
  writeRaw(s);
  return { s, p, dir: profileDir(s, p) };
}
async function installPackFile(file, icon) {
  const progress = (text, f) => send('pack-progress', { text, percent: Math.round(f * 100) });
  const tmpDir = path.join(DATA, 'profiles', 'tmp-' + Date.now().toString(36));
  try {
    const r = await modrinth.installMrpack({ file, gameDir: tmpDir, log: (l) => send('log', l), progress });
    const { p, dir } = newProfile({
      name: r.name.slice(0, 32), version: r.mc, loader: r.loader, fabricLoader: r.loaderVersion || null,
      content: r.content, packIcon: icon || null, color: '#a78bfa'
    });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(tmpDir, dir);
    return { id: p.id, name: p.name, mc: r.mc, mods: Object.keys(r.content).length };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

ipcMain.handle('packs:search', (_e, q) => modrinth.searchPacks(q || {}));
ipcMain.handle('packs:install', async (_e, project) => {
  if (mrBusy) throw new Error('Подожди, идёт другая установка');
  mrBusy = true;
  const tmp = path.join(os.tmpdir(), `sigma-pack-${Date.now()}.mrpack`);
  try {
    send('pack-progress', { text: 'Скачиваю модпак...', percent: 0 });
    const { icon } = await modrinth.downloadPack(project, tmp);
    return await installPackFile(tmp, icon);
  } finally {
    fs.rmSync(tmp, { force: true });
    mrBusy = false;
  }
});
ipcMain.handle('packs:import', async () => {
  if (mrBusy) throw new Error('Подожди, идёт другая установка');
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Сборка Minecraft', extensions: ['mrpack', 'zip'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  mrBusy = true;
  try { return await installPackFile(r.filePaths[0]); } finally { mrBusy = false; }
});

ipcMain.handle('profiles:export', async (_e, id) => {
  const s = loadSettings();
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error('Сборка не найдена');
  const mc = p.version || (await getManifest()).latest.release;
  let loaderVersion = p.fabricLoader || null;
  if (p.loader === 'fabric' && !loaderVersion) {
    const vid = await modrinth.ensureFabric(s.gameDir, mc);
    loaderVersion = (vid.match(/^fabric-loader-(.+)-[^-]+$/) || [])[1] || null;
    if (!loaderVersion) loaderVersion = vid.replace(/^fabric-loader-/, '').replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '');
  }
  const out = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.mrpack`),
    filters: [{ name: 'Сборка Minecraft', extensions: ['mrpack'] }]
  });
  if (out.canceled || !out.filePath) return null;
  const r = await modrinth.exportMrpack({ name: p.name, mc, loaderVersion, gameDir: profileDir(s, p), content: p.content || {}, out: out.filePath });
  shell.showItemInFolder(out.filePath);
  return { ...r, file: out.filePath };
});

ipcMain.handle('mr:updates', async () => {
  const s = loadSettings();
  const mc = s.version || (await getManifest()).latest.release;
  return modrinth.checkUpdates({ mc, gameDir: s.profile.dir, content: s.profile.content || {} });
});
ipcMain.handle('mr:updateAll', async (_e, list) => {
  if (gameRunning) throw new Error('Закрой игру перед обновлением модов');
  if (mrBusy) throw new Error('Подожди, идёт другая установка');
  mrBusy = true;
  try {
    const s = loadSettings();
    const content = { ...(s.profile.content || {}) };
    let done = 0;
    for (const upd of list) {
      send('pack-progress', { text: `Обновляю ${upd.title} (${done + 1}/${list.length})`, percent: Math.round((done / list.length) * 100) });
      try { await modrinth.applyUpdate({ gameDir: s.profile.dir, content, upd }); done++; } catch (e) { send('log', `[mods] ${upd.title}: ${e.message}`); }
    }
    updateProfile(s.profile.id, (prof) => { prof.content = content; });
    return done;
  } finally { mrBusy = false; }
});

// действия из окна «Игра вылетела»
ipcMain.handle('crash:action', (_e, action, report) => {
  const s = loadSettings();
  if (action === 'moreRam') {
    const total = Math.floor(os.totalmem() / 1048576);
    const cur = Number(s.profile.ramMax) || Number(s.ramMax) || 4096;
    const next = Math.min(Math.floor((total * 0.75) / 512) * 512, cur + 2048);
    if (s.profile.ramMax) updateProfile(s.profile.id, (p) => { p.ramMax = next; });
    else saveSettings({ ramMax: next });
    return `Теперь игре выделено ${next} МБ`;
  }
  if (action === 'resetJava') { saveSettings({ customJava: '' }); return 'Своя Java сброшена — лаунчер скачает нужную сам'; }
  if (action === 'openReport' && report && fs.existsSync(report)) { shell.openPath(report); return null; }
  if (action === 'drivers') { shell.openExternal('https://www.google.com/search?q=%D0%BE%D0%B1%D0%BD%D0%BE%D0%B2%D0%B8%D1%82%D1%8C+%D0%B4%D1%80%D0%B0%D0%B9%D0%B2%D0%B5%D1%80+%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE%D0%BA%D0%B0%D1%80%D1%82%D1%8B'); return null; }
  return null;
});

/* ---------- запуск игры ---------- */
ipcMain.handle('game:launch', async (_e, extra = {}) => {
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
      version.custom = await modrinth.ensureFabric(root, entry.id, (l) => send('log', l), prof.fabricLoader);
    }

    if (s.autoBackup !== false) {
      try { await autoBackup(gameDir); } catch (e) { send('log', `[backup] Не получилось: ${e.message}`); }
    }

    const ram = Number(prof.ramMax) || Number(s.ramMax) || 4096;
    const optimize = s.optimize !== false;
    if (optimize) await preferHighPerformanceGpu(javaPath);
    const userArgs = s.jvmArgs ? s.jvmArgs.split(/\s+/).filter(Boolean) : [];
    // свои аргументы пользователя важнее — если он задал GC сам, наши не добавляем
    const gcArgs = optimize && !userArgs.some((a) => /^-XX:\+Use\w+GC$/.test(a)) ? FAST_JVM : [];
    const minRam = optimize ? Math.min(ram, Math.max(1024, Math.floor(ram / 2))) : Math.min(s.ramMin, ram);
    send('log', `[sigma] RAM ${ram} МБ · оптимизация ${optimize ? 'вкл (G1GC, дискретная видеокарта)' : 'выкл'}`);
    const launcher = new Client();
    const opts = {
      authorization: Authenticator.getAuth(nick),
      root,
      version,
      memory: { max: `${ram}M`, min: `${minRam}M` },
      javaPath,
      window: s.fullscreen
        ? { fullscreen: true }
        : { width: Number(s.width) || 1280, height: Number(s.height) || 720 },
      customArgs: [...gcArgs, ...userArgs],
      overrides: { detached: false, maxSockets: 8, gameDirectory: gameDir, cwd: gameDir }
    };
    if (extra.server) {
      // с 23w14a есть «быстрая игра», в старых версиях — флаги --server/--port
      const modern = new Date(vjson.releaseTime) >= new Date('2023-04-05');
      opts.quickPlay = { type: modern ? 'multiplayer' : 'legacy', identifier: extra.server };
      send('log', `[sigma] Подключение к серверу ${extra.server}`);
    }

    let started = 0;
    const tail = [];
    const launchAt = Date.now();
    const session = { version: entry.id, loader: prof.loader, profileId: prof.id, profileName: prof.name };

    launcher.on('debug', (l) => { send('log', `[launcher] ${l}`); tail.push(String(l)); if (tail.length > 800) tail.shift(); });
    launcher.on('data', (l) => {
      send('log', String(l).trimEnd());
      for (const line of String(l).split('\n')) { tail.push(line); if (tail.length > 800) tail.shift(); }
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
      // обычный выход — 0; закрытие крестиком на Windows иногда даёт 1 без ошибок в логе
      if (code !== 0 && code !== null) {
        const info = crash.analyze({ log: tail, gameDir, started: launchAt, code, ram });
        const quietExit = code === 1 && info.title === 'Игра вылетела' && !info.report;
        if (!quietExit) send('crash', info);
      }
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
