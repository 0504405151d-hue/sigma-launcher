import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Browser } from '@capacitor/browser';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const REPO = '0504405151d-hue/sigma-launcher';
const MC_PACKAGE = 'com.mojang.minecraftpe';

const DEFAULTS = {
  skinEnabled: true,
  bedrockServers: [
    { name: 'The Hive', host: 'geo.hivebedrock.network', port: 19132 },
    { name: 'CubeCraft', host: 'mco.cubecraft.net', port: 19132 },
    { name: 'Lifeboat', host: 'mco.lbsg.net', port: 19132 }
  ]
};

const load = (k, d) => {
  try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
};
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* память переполнена */ } };

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function open(url) {
  try { await AppLauncher.openUrl({ url }); return true; } catch { return false; }
}

let pendingUpdate = null;

window.api = {
  mobile: true,

  /* настройки */
  getSettings: async () => ({ ...DEFAULTS, ...load('settings', {}) }),
  setSettings: async (patch) => {
    const s = { ...DEFAULTS, ...load('settings', {}), ...patch };
    store('settings', s);
    return s;
  },
  resetSettings: async () => { store('settings', {}); return { ...DEFAULTS }; },

  /* скин */
  getSkin: async () => load('skin', null),
  setSkin: (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.width !== 64 || img.height !== 64) return reject(new Error('Скин должен быть 64×64'));
      store('skin', dataUrl);
      resolve(true);
    };
    img.onerror = () => reject(new Error('Не удалось прочитать картинку'));
    img.src = dataUrl;
  }),
  removeSkin: async () => { localStorage.removeItem('skin'); return true; },
  exportSkin: async (dataUrl) => {
    const name = `sigma-skin-${Date.now()}.png`;
    const res = await Filesystem.writeFile({
      path: name,
      data: dataUrl.split(',')[1],
      directory: Directory.Cache
    });
    await Share.share({
      title: 'Скин Minecraft',
      text: 'Скин из Sigma Launcher',
      files: [res.uri],
      dialogTitle: 'Сохранить или отправить скин'
    });
  },

  /* Bedrock */
  bedrockStatus: async () => {
    try {
      const { value } = await AppLauncher.canOpenUrl({ url: MC_PACKAGE });
      return { supported: true, mobile: true, installed: !!value, version: '' };
    } catch {
      return { supported: true, mobile: true, installed: true, version: '' };
    }
  },
  bedrockLaunch: () => open('minecraft://'),
  bedrockStore: async () => {
    if (!(await open(`market://details?id=${MC_PACKAGE}`))) {
      await Browser.open({ url: `https://play.google.com/store/apps/details?id=${MC_PACKAGE}` });
    }
  },
  bedrockConnect: (host, port) =>
    open(`minecraft://connect/?serverUrl=${encodeURIComponent(host)}&serverPort=${Number(port) || 19132}`),
  bedrockPing: async (host, port) => {
    try {
      const r = await fetch(`https://api.mcsrvstat.us/bedrock/3/${encodeURIComponent(host)}:${Number(port) || 19132}`);
      const d = await r.json();
      if (!d.online) return { online: false };
      return {
        online: true,
        ping: null,
        players: d.players?.online || 0,
        max: d.players?.max || 0,
        version: d.version || '',
        motd: (d.motd?.clean || []).join(' ')
      };
    } catch {
      return { online: false };
    }
  },

  /* обновления — новый APK с GitHub */
  appInfo: async () => {
    try { return await App.getInfo(); } catch { return { version: '0.0.0' }; }
  },
  checkUpdate: async () => {
    try {
      const { version: current } = await window.api.appInfo();
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!r.ok) return { available: false, error: `GitHub ответил ${r.status}` };
      const rel = await r.json();
      const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.apk'));
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (asset && newer(version, current)) {
        pendingUpdate = { version, url: asset.browser_download_url };
        return { available: true, version };
      }
      return { available: false, latest: version };
    } catch {
      return { available: false, error: 'нет интернета' };
    }
  },
  installUpdate: async () => {
    if (!pendingUpdate) return false;
    await Browser.open({ url: pendingUpdate.url });
    return true;
  },
  openUrl: (url) => Browser.open({ url })
};
