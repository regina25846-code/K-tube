const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  minimize: () => ipcRenderer.invoke('minimize'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', cb),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', cb),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onPlayVideo: (cb) => ipcRenderer.on('play-video', (_, videoId) => cb(videoId)),
  setVideoMode: (active) => ipcRenderer.invoke('set-video-mode', active),
  onKeyArrow: (cb) => ipcRenderer.on('key-arrow', (_, key) => cb(key)),
  onShowChannel: (cb) => ipcRenderer.on('show-channel', () => cb()),
  getDirectStream: (videoId) => ipcRenderer.invoke('get-direct-stream', videoId),
});
