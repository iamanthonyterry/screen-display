const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  version: () => ipcRenderer.invoke('updater:version'),
  check: () => ipcRenderer.invoke('updater:check'),
  install: () => ipcRenderer.invoke('updater:install'),
  onStatus: cb => ipcRenderer.on('updater:status', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('remote', {
  start: opts => ipcRenderer.invoke('remote:start', opts),
  stop: () => ipcRenderer.invoke('remote:stop'),
});
