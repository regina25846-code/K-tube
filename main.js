const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');

const CONFIG_PATH = path.join(app.getPath('userData'), 'ktube_config.json');

let mainWin = null;
let tray = null;
let localServer = null;
let localPort = 0;
let videoActive = false;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function startLocalServer(cb) {
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    let filePath;

    if (urlPath === '/' || urlPath === '/index.html') {
      filePath = path.join(__dirname, 'renderer', 'index.html');
    } else {
      filePath = path.join(__dirname, 'renderer', urlPath);
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const ext = path.extname(filePath);
      const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ttf':'font/ttf', '.woff2':'font/woff2' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });

  const tryListen = (port) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') tryListen(port + 1);
    });
    server.listen(port, '127.0.0.1', () => {
      localPort = server.address().port;
      localServer = server;
      cb(localPort);
    });
  };
  tryListen(7721);
}

function createWindow() {
  const cfg = loadConfig();

  mainWin = new BrowserWindow({
    width: cfg.width || 1200,
    height: cfg.height || 760,
    minWidth: 480,
    minHeight: 400,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0d0d',
    show: false,
    title: 'K-Tube',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  startLocalServer((port) => {
    mainWin.loadURL(`http://127.0.0.1:${port}`);
  });

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    if (cfg.alwaysOnTop) mainWin.setAlwaysOnTop(true);
  });

  mainWin.on('resize', () => {
    const [w, h] = mainWin.getSize();
    const c = loadConfig(); c.width = w; c.height = h; saveConfig(c);
  });

  mainWin.on('closed', () => { mainWin = null; });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    const ytMatch = url.match(/youtube\.com\/watch\?(?:[^#]*&)?v=([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
      mainWin.webContents.send('play-video', ytMatch[1] || ytMatch[2]);
    } else if (/youtube\.com\/(channel\/|@|c\/|user\/)/.test(url)) {
      mainWin.webContents.send('show-channel');
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWin.webContents.on('before-input-event', (event, input) => {
    if (!videoActive || input.type !== 'keyDown') return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(input.key)) {
      event.preventDefault();
      mainWin.webContents.send('key-arrow', input.key);
    }
  });

  mainWin.webContents.on('did-navigate-in-frame', (event, url, httpResponseCode, httpStatusText, isMainFrame) => {
    if (isMainFrame) return;
    const ytMatch = url.match(/youtube\.com\/watch\?(?:[^#]*&)?v=([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
      mainWin.webContents.send('play-video', ytMatch[1] || ytMatch[2]);
      return;
    }
    if (/youtube\.com\/(channel\/|@|c\/|user\/)/.test(url)) {
      mainWin.webContents.send('show-channel');
    }
  });

  setupAutoUpdater();
}

function setupTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('K-Tube');
    tray.on('click', () => { if (mainWin) { mainWin.isVisible() ? mainWin.hide() : mainWin.show(); } });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'K-Tube 열기', click: () => mainWin?.show() },
      { type: 'separator' },
      { label: '종료', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
  } catch(e) {}
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', () => mainWin?.webContents.send('update-available'));
  autoUpdater.on('update-downloaded', () => mainWin?.webContents.send('update-downloaded'));
  try { autoUpdater.checkForUpdates(); } catch(e) {}
}

// ── IPC ──
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => { saveConfig(cfg); return true; });
ipcMain.handle('minimize', () => mainWin?.minimize());
ipcMain.handle('close-app', () => { app.isQuitting = true; app.quit(); });
ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWin) return;
  const v = !mainWin.isAlwaysOnTop();
  mainWin.setAlwaysOnTop(v);
  const c = loadConfig(); c.alwaysOnTop = v; saveConfig(c);
  return v;
});
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('set-video-mode', (_, active) => { videoActive = active; });

// ── App lifecycle ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    setupTray();
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; if (localServer) localServer.close(); });
app.on('activate', () => { if (!mainWin) createWindow(); });
