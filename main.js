const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

// yt-dlp 바이너리 경로 — K-Music과 동일한 탐색 패턴(2026-07-20)
function getYtDlpPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'yt-dlp.exe');
  }
  const candidates = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(__dirname, 'bin', 'yt-dlp'),
    'yt-dlp'
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { timeout: 5000 }); return c; } catch {}
  }
  return 'yt-dlp';
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    execFile(bin, args, { timeout: 30000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// 임베드 차단된 영상용 — 유튜브 아이프레임 플레이어를 거치지 않고 원본 스트림 주소를 직접 받아서
// K-Tube 내부 <video>/<audio> 태그로 재생하기 위함(2026-07-20, 형 요청으로 추가)
// --dump-json 결과의 각 포맷 항목에 이미 서명 해제된 url이 들어있어서 -f 셀렉터로 한번 더
// 호출할 필요 없음 — 화질 목록 전체 + 각 화질별 url을 한번에 뽑아서 프론트에서 즉시 전환 가능하게 함
// (720p 강제 캡 제거 — 형이 직접 화질 선택하고 싶다고 해서 지원 화질 전부 넘김, 2026-07-21)
async function getDirectStreamUrls(videoId) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const json = await ytdlp(['--no-playlist', '--dump-json', '--no-warnings', ytUrl]);
  const info = JSON.parse(json);

  const heights = {};
  for (const f of info.formats || []) {
    if (f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && f.height && f.url) {
      const isAvc = f.vcodec.startsWith('avc1');
      const cur = heights[f.height];
      if (!cur || (isAvc && !cur.isAvc) || (isAvc === cur.isAvc && (f.tbr || 0) > (cur.tbr || 0))) {
        heights[f.height] = { height: f.height, url: f.url, isAvc, tbr: f.tbr || 0 };
      }
    }
  }
  const qualities = Object.values(heights)
    .sort((a, b) => b.height - a.height)
    .map(q => ({ height: q.height, url: q.url }));

  let bestAudio = null;
  for (const f of info.formats || []) {
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url) {
      if (!bestAudio || (f.abr || 0) > (bestAudio.abr || 0)) bestAudio = f;
    }
  }

  return { qualities, audioUrl: bestAudio ? bestAudio.url : null, duration: info.duration };
}

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
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store' });
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

let aboutWin = null;
function openAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) { aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    width: 320, height: 340,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  aboutWin.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  aboutWin.on('closed', () => { aboutWin = null; });
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
      { label: '프로그램 정보', click: () => openAboutWindow() },
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
ipcMain.handle('close-app', () => { mainWin?.hide(); });
ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWin) return;
  const v = !mainWin.isAlwaysOnTop();
  mainWin.setAlwaysOnTop(v);
  const c = loadConfig(); c.alwaysOnTop = v; saveConfig(c);
  return v;
});
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('set-video-mode', (_, active) => { videoActive = active; });
ipcMain.handle('get-direct-stream', async (_, videoId) => {
  try {
    const data = await getDirectStreamUrls(videoId);
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

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
