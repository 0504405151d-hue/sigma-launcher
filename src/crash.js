// Разбор вылета: по логу и отчёту о краше объясняет причину по-русски и предлагает действие
const fs = require('fs');
const path = require('path');

function newestCrashReport(gameDir, since) {
  const dir = path.join(gameDir, 'crash-reports');
  try {
    const f = fs.readdirSync(dir)
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .filter((x) => x.t >= since - 5000)
      .sort((a, b) => b.t - a.t)[0];
    return f ? path.join(dir, f.n) : null;
  } catch { return null; }
}

function analyze({ log, gameDir, started, code, ram }) {
  const report = newestCrashReport(gameDir, started || Date.now() - 600000);
  let text = log.join('\n');
  if (report) {
    try { text += '\n' + fs.readFileSync(report, 'utf8').slice(0, 200000); } catch { /* нет доступа */ }
  }
  const has = (re) => re.test(text);
  const grab = (re) => { const m = text.match(re); return m ? m[1] : null; };
  const base = { code, report };

  if (has(/OutOfMemoryError|Could not reserve enough space|Java heap space/i)) {
    return { ...base, title: 'Игре не хватило памяти',
      text: `Сейчас выделено ${ram} МБ — для этой сборки мало. Добавь памяти и запусти снова.`,
      actions: ['moreRam'] };
  }
  if (has(/UnsupportedClassVersionError|Unsupported class file major version|has been compiled by a more recent version of the Java/i)) {
    return { ...base, title: 'Не та версия Java',
      text: 'Игре или моду нужна другая Java. Если в настройках выбрана своя Java — сбрось её, лаунчер скачает подходящую сам.',
      actions: ['resetJava'] };
  }
  const missing = [...text.matchAll(/(?:requires|depends on)[^\n]*?(?:mod|of) '?([\w .\-]+?)'?,? (?:which is missing|version|any version|but)/gi)]
    .map((m) => m[1].trim()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
  if (has(/Incompatible mods? found|Mod resolution failed|requires .* which is missing|ModResolutionException/i)) {
    return { ...base, title: 'Моды не подходят друг к другу',
      text: missing.length
        ? `Не хватает или не подходит: ${missing.join(', ')}. Найди этот мод во вкладке «Моды» или удали тот, которому он нужен.`
        : 'Какому-то моду не хватает другого мода или версия не подходит. Обнови моды или удали последний добавленный.',
      actions: ['updateMods', 'openMods'] };
  }
  const mixinMod = grab(/Mixin apply for mod ([\w\-]+)/i) || grab(/from mod ([\w\-]+)/i);
  if (has(/MixinApplyError|Mixin apply failed|InvalidInjectionException|MixinTransformerError/i)) {
    return { ...base, title: 'Конфликт модов',
      text: mixinMod
        ? `Мод «${mixinMod}» конфликтует с игрой или другим модом. Обнови моды или удали его.`
        : 'Два мода мешают друг другу. Обнови моды или удали последний добавленный.',
      actions: ['updateMods', 'openMods'] };
  }
  if (has(/GLFW error 65542|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated|No OpenGL context|GL_VERSION.*1\.1|Couldn't set pixel format/i)) {
    return { ...base, title: 'Проблема с драйвером видеокарты',
      text: 'Видеокарта не дала игре OpenGL. Обнови драйвер видеокарты (Intel / NVIDIA / AMD) и перезагрузи компьютер.',
      actions: ['drivers'] };
  }
  if (has(/EXCEPTION_ACCESS_VIOLATION|ig\d+icd\d*\.dll|atio6axx\.dll|nvoglv\d+\.dll/i)) {
    return { ...base, title: 'Вылет в драйвере видеокарты',
      text: 'Игра упала внутри драйвера видеокарты. Обнови драйвер. Если играешь с шейдерами — попробуй шейдер полегче.',
      actions: ['drivers'] };
  }
  if (has(/Failed to (?:load|parse) (?:shader|program)|ShaderCompileException|iris.*(?:error|exception)/i)) {
    return { ...base, title: 'Шейдер не запустился',
      text: 'Шейдер не подходит к этой видеокарте или версии. Выключи его клавишей K в игре или удали во вкладке «Моды» → «Установленные».',
      actions: ['openMods'] };
  }
  if (has(/session\.lock|already locked|The directory is already locked/i)) {
    return { ...base, title: 'Мир уже открыт',
      text: 'Этот мир открыт в другой копии игры. Закрой все окна Minecraft и попробуй снова.',
      actions: [] };
  }
  return { ...base, title: 'Игра вылетела',
    text: report ? 'Причину автоматически определить не удалось. Открой отчёт о краше — там подробности.' : `Игра закрылась с кодом ${code}. Подробности — во вкладке «Консоль».`,
    actions: report ? ['openReport'] : ['console'] };
}

module.exports = { analyze };
