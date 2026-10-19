const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('win:min'),
  maximize: () => ipcRenderer.send('win:max'),
  close: () => ipcRenderer.send('win:close'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  systemInfo: () => ipcRenderer.invoke('system:info'),

  listVersions: () => ipcRenderer.invoke('versions:list'),
  deleteVersion: (id) => ipcRenderer.invoke('version:delete', id),
  launch: () => ipcRenderer.invoke('game:launch'),

  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickJava: () => ipcRenderer.invoke('dialog:java'),
  openFolder: (which) => ipcRenderer.invoke('open:folder', which),

  getSkin: () => ipcRenderer.invoke('skin:get'),
  setSkin: (dataUrl) => ipcRenderer.invoke('skin:set', dataUrl),
  removeSkin: () => ipcRenderer.invoke('skin:remove'),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  bedrockStatus: () => ipcRenderer.invoke('bedrock:status'),
  bedrockLaunch: () => ipcRenderer.invoke('bedrock:launch'),
  bedrockStore: () => ipcRenderer.invoke('bedrock:store'),
  bedrockConnect: (h, p) => ipcRenderer.invoke('bedrock:connect', h, p),
  bedrockPing: (h, p) => ipcRenderer.invoke('bedrock:ping', h, p),

  profiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (p) => ipcRenderer.invoke('profiles:save', p),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  openProfile: (id) => ipcRenderer.invoke('profiles:open', id),
  fabricSupported: (mc) => ipcRenderer.invoke('fabric:supported', mc),

  mrSearch: (q) => ipcRenderer.invoke('mr:search', q),
  mrInstalled: () => ipcRenderer.invoke('mr:installed'),
  mrInstall: (id, type) => ipcRenderer.invoke('mr:install', { id, type }),
  mrRemove: (id) => ipcRenderer.invoke('mr:remove', id),

  createPreset: (key) => ipcRenderer.invoke('presets:create', key),
  onPresetProgress: (cb) => ipcRenderer.on('preset-progress', (_e, d) => cb(d)),

  stats: () => ipcRenderer.invoke('stats:get'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  discordAvailable: () => ipcRenderer.invoke('discord:available'),

  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d))
});
