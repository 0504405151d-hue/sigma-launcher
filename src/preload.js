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

  onStatus:(cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d))
});
