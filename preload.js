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
  // 우회재생 실패 안내창 전용(2026-08-27) — 자세한 건 main.js의 각 핸들러 주석 참고
  openExternalYouTube: (videoId) => ipcRenderer.invoke('open-external-youtube', videoId),
  logPlaybackError: (payload) => ipcRenderer.invoke('log-playback-error', payload),
  checkShorts: (videoIds) => ipcRenderer.invoke('check-shorts', videoIds),
  onWindowMinimized: (cb) => ipcRenderer.on('window-minimized', () => cb()),
  onWindowRestored: (cb) => ipcRenderer.on('window-restored', () => cb()),
});
