// Самообновление без скриптов: новая версия сама заменяет старый exe и запускает его.
// Шаги (job.json в папке update):
//   1. старый лаунчер качает SigmaLauncher-update.exe, пишет stage=launching и запускает его
//   2. «установщик» (тот же exe) показывает окно, пишет stage=ready → старый лаунчер закрывается
//   3. установщик ждёт, пока старый exe освободится, копирует себя на его место, stage=copied, запускает
//   4. новая версия открылась → stage=done → установщик закрывается, а новая версия удаляет временный файл
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const JOB_MAX_AGE = 15 * 60 * 1000;

function paths(dataDir) {
  const dir = path.join(dataDir, 'update');
  return { dir, job: path.join(dir, 'job.json'), exe: path.join(dir, 'SigmaLauncher-update.exe') };
}

function readJob(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(paths(dataDir).job, 'utf8'));
    if (Date.now() - j.created > JOB_MAX_AGE) return null;
    return j;
  } catch { return null; }
}

function writeJob(dataDir, job) {
  const p = paths(dataDir);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.job, JSON.stringify(job, null, 2));
}

const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Кем запущен этот процесс: установщиком обновления, новой версией после обновления или обычным лаунчером. */
function detectRole(dataDir) {
  const self = process.env.PORTABLE_EXECUTABLE_FILE;
  const job = readJob(dataDir);
  if (!job || !self) return { role: null, job: null };
  if (job.stage === 'launching' && same(self, job.updateExe)) return { role: 'finisher', job };
  if ((job.stage === 'copied' || job.stage === 'done') && same(self, job.target)) return { role: 'final', job };
  return { role: null, job: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Шаг 1: старый лаунчер запускает установщик и ждёт, пока тот покажет окно. */
async function launchFinisher(dataDir, { target, version }, onStatus) {
  const p = paths(dataDir);
  writeJob(dataDir, { stage: 'launching', updateExe: p.exe, target, version, created: Date.now() });
  const child = spawn(p.exe, [], { detached: true, stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.unref();
  onStatus?.('Запускаю установку обновления...');
  for (let i = 0; i < 180; i++) { // до 90 секунд: portable-exe сначала распаковывается
    await sleep(500);
    if (spawnError) break;
    const j = readJob(dataDir);
    if (j && j.stage !== 'launching') return true;
  }
  throw new Error(spawnError
    ? `Windows не дала запустить обновление (${spawnError.code || spawnError.message})`
    : 'Установка обновления не запустилась — возможно, её заблокировал антивирус');
}

/** Шаги 2–4: работает внутри установщика. */
async function runFinisher(dataDir, job, { BrowserWindow, app }) {
  const self = process.env.PORTABLE_EXECUTABLE_FILE;
  const splash = new BrowserWindow({
    width: 440, height: 190, frame: false, resizable: false, alwaysOnTop: true,
    backgroundColor: '#11141b', show: false, skipTaskbar: false, title: 'Обновление Sigma Launcher',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await splash.loadFile(path.join(__dirname, 'updater.html'), { query: { v: job.version || '' } });
  splash.show();
  const say = (text, state = '') => splash.isDestroyed() ? null
    : splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(state)})`).catch(() => {});

  writeJob(dataDir, { ...job, stage: 'ready' });
  say('Закрываю старую версию...');

  // ждём, пока старый exe освободится, и подменяем его новым
  const staged = job.target + '.sigma-new';
  let copied = false;
  try { fs.copyFileSync(self, staged); } catch (e) { /* попробуем снова в цикле */ }
  for (let i = 0; i < 150 && !copied; i++) { // до ~2 минут
    try {
      if (!fs.existsSync(staged) || fs.statSync(staged).size !== fs.statSync(self).size) fs.copyFileSync(self, staged);
      fs.renameSync(staged, job.target);
      copied = true;
    } catch {
      if (i === 6) say('Жду, пока старая версия закроется...');
      await sleep(800);
    }
  }

  if (!copied) {
    fs.rmSync(staged, { force: true });
    try { fs.rmSync(paths(dataDir).job, { force: true }); } catch { /* ignore */ }
    say('Не получилось заменить файл — его держит другая программа. Нажми «Запустить», чтобы открыть новую версию отсюда.', 'failed');
    splash.webContents.on('console-message', (_e, _l, msg) => {
      if (msg === 'sigma:run') { spawn(self, [], { detached: true, stdio: 'ignore' }).unref(); app.quit(); }
      if (msg === 'sigma:close') app.quit();
    });
    return;
  }

  writeJob(dataDir, { ...job, stage: 'copied' });
  say('Запускаю новую версию...');
  spawn(job.target, [], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 180; i++) { // до 90 секунд ждём, пока новая версия откроется
    await sleep(500);
    const j = readJob(dataDir);
    if (!j || j.stage === 'done') break;
  }
  app.quit();
}

/** Новая версия открылась: сообщаем установщику и убираем временный файл. */
function finishFinal(dataDir, job) {
  writeJob(dataDir, { ...job, stage: 'done' });
  const p = paths(dataDir);
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    try {
      fs.rmSync(p.exe, { force: true });
      fs.rmSync(job.target + '.new', { force: true }); // хвост от старого способа обновления
      fs.rmSync(p.job, { force: true });
      clearInterval(t);
    } catch {
      if (tries > 40) clearInterval(t);
    }
  }, 2500);
}

module.exports = { paths, detectRole, launchFinisher, runFinisher, finishFinal };
