const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('normalDocsDaemon', {
  start: () => ipcRenderer.invoke('daemon:start'),
  stop: () => ipcRenderer.invoke('daemon:stop'),
  restart: () => ipcRenderer.invoke('daemon:restart'),
  repairPreviews: () => ipcRenderer.invoke('daemon:repair-previews'),
  status: () => ipcRenderer.invoke('daemon:status'),
  openHealth: () => ipcRenderer.invoke('daemon:open-health'),
  openWeb: () => ipcRenderer.invoke('daemon:open-web'),
  openData: () => ipcRenderer.invoke('daemon:open-data'),
  chooseDataDir: () => ipcRenderer.invoke('daemon:choose-data-dir'),
  onLog: (callback) => ipcRenderer.on('daemon:log', (_event, payload) => callback(payload)),
  onStatus: (callback) => ipcRenderer.on('daemon:status', (_event, payload) => callback(payload))
});
