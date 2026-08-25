const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const https = require('https');

// yt-dlp 바이너리 경로 — K-Music과 동일한 탐색 패턴(2026-07-20)
//
// ── 오버라이드 통로(2026-08-18 신설, 임시 성격) ──────────────────────────────
// K-Music main.js에 넣은 것과 글자 그대로 같은 구조다. 두 앱이 같은 yt-dlp.exe를 번들하고
// 있어서(md5 동일) 같은 사고를 같이 겪는다.
//
// 유튜브가 SABR 전용 스트리밍을 켜면서, 번들된 yt-dlp 2026.07.04로 뽑은 스트림 주소는
// 앞쪽 1,000,000바이트까지만 서빙되고 그 뒤는 403으로 끊긴다(실측). K-Tube는 이 주소를
// <video>/<audio>에 직접 물리는 구조라, 1MB를 넘는 영상은 재생이 시작조차 안 된다.
// yt-dlp 쪽 수정(visionos 클라이언트 추가 #17184, 2026-07-09 머지)은 나이틀리에 이미 들어가
// 있고 PO Token 없이 정상 동작하는 걸 확인했지만, 아직 정식 릴리스에는 안 실렸다.
//
// 그래서 앱 재빌드 없이 실행파일만 갈아끼우는 통로를 하나만 둔다. userData/bin/ 아래에
// 실행 가능한 yt-dlp가 있으면 그걸 먼저 쓰고, 없으면 예전과 완전히 똑같이 번들 exe로 간다.
// 정식 릴리스를 번들한 뒤 override 파일만 지우면 원복이고, 이 블록을 통째로 지워도 아래
// 원본 함수 본문은 손댄 곳이 없다.
//
// override가 깨진 파일이어도 앱이 죽지 않도록 `--version`으로 한 번 확인하고, 실패하면
// 조용히 번들 exe로 되돌아간다. 판정은 프로세스 수명 동안 캐시하므로 파일을 넣거나 뺀
// 뒤에는 앱을 한 번 재시작해야 반영된다. 타임아웃 15초는 yt-dlp 공식 단독 실행파일이
// PyInstaller onefile이라 첫 응답이 느린 것(맥 실측 8.5초)을 감안한 값이다.
let _ytDlpOverride;  // undefined = 아직 안 봄, null = 없음(또는 못 씀)
function getYtDlpOverridePath() {
  if (_ytDlpOverride !== undefined) return _ytDlpOverride;
  _ytDlpOverride = null;
  try {
    const p = path.join(app.getPath('userData'), 'bin',
      process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    fs.accessSync(p, fs.constants.X_OK);
    execFileSync(p, ['--version'], { timeout: 15000, stdio: 'ignore' });
    _ytDlpOverride = p;
  } catch { _ytDlpOverride = null; }
  return _ytDlpOverride;
}

function getYtDlpPath() {
  const override = getYtDlpOverridePath();
  if (override) return override;
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
      // 최소화된 창의 렌더러를 절전 목적으로 스로틀하면 우회재생 <video> 디코딩이 멈추면서
      // 버퍼링 방어 로직(waiting 이벤트)이 소리까지 같이 꺼버리는 문제가 있었음(2026-08-06)
      backgroundThrottling: false,
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

  // 백그라운드 재생 토글이 꺼져있을 때만 렌더러가 최소화/복원에 맞춰 직접 멈추고 재개함(2026-08-06)
  mainWin.on('minimize', () => mainWin?.webContents.send('window-minimized'));
  mainWin.on('restore', () => mainWin?.webContents.send('window-restored'));

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

// 프로그램 정보 창 폭 = 카드 300px + about.html body 좌우 padding 28px*2.
// about.html의 body{padding}을 바꾸면 이 값도 같이 바꿔야 한다.
const ABOUT_W = 356;
let aboutWin = null;
function openAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) { aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    // 카드 300px + about.html의 body padding(좌우 28px) = 356.
    // 창이 카드보다 그림자 여백만큼 크지 않으면 그림자가 창 경계에서 직선으로 잘려
    // 카드 모서리가 각져 보인다(2026-08-25 확정). 높이는 로드 직후 about-resize가 실측 보정.
    width: ABOUT_W, height: 525,
    frame: false, resizable: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'renderer', 'about-preload.js') }
  });
  const cfg = loadConfig();
  aboutWin.loadFile(path.join(__dirname, 'renderer', 'about.html'), { query: { theme: cfg.theme || 'dark' } });
  aboutWin.on('closed', () => { aboutWin = null; });
}

function setupTray() {
  try {
    const trayIconPath = path.join(__dirname, 'assets', 'icon_tray.png');
    const iconPath = fs.existsSync(trayIconPath) ? trayIconPath : path.join(__dirname, 'assets', 'icon.ico');
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
  // 테스트빌드(1.2.0-2 같은 하이픈숫자 버전) 설치 상태에서 "업데이트 확인" 누르면 실패하던 문제 —
  // electron-updater는 버전에 하이픈(프리릴리즈)이 붙어있으면 allowPrerelease를 자동으로 true로
  // 켜는데, 여기에 channel='latest'까지 같이 있으면 GitHubProvider.getLatestVersion()의 태그
  // 매칭 로직이 정식 릴리즈(비-프리릴리즈 태그)를 절대 못 찾는 조합이 됨 — updater-error.log로
  // 실측한 stack trace가 정확히 이 경로(GitHubProvider.js:111 tag==null)를 가리켜서 확정.
  // channel 강제 대신 allowPrerelease=false로 프리릴리즈 자동감지 자체를 꺼서, 테스트빌드든
  // 정식버전이든 항상 최신 정식 릴리즈를 찾는 기본 로직(getLatestTagName)을 타게 함(2026-08-06).
  autoUpdater.allowPrerelease = false;
  // "No published versions on GitHub" 에러가 서버는 멀쩡한데도 재현되는 문제 진단용 —
  // K-Memo 때도 같은 에러로 헤맸는데 그땐 로그 파일이 없어서 원인을 확정 못 했음(레이트리밋 추정,
  // 미검증). 다음엔 실측하려고 %APPDATA%/kris-tube/updater-error.log에 매 시도 기록(2026-08-06).
  // ⚠️ 실제 폴더명은 kris-tube임(userData 내부 식별자가 아직 개명 전, 2026-08-16 확인 — project_kseries_kris_prefix_audit 참고)
  const logUpdater = (msg) => {
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'updater-error.log'),
        `[${new Date().toISOString()}] ${msg}\n`
      );
    } catch (e) {}
  };
  const broadcast = (channel, arg) => {
    mainWin?.webContents.send(channel, arg);
    if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send(channel, arg);
  };
  logUpdater(`앱 시작, 현재 버전 ${app.getVersion()}, checkForUpdates 호출`);
  autoUpdater.on('checking-for-update', () => logUpdater('checking-for-update 이벤트'));
  autoUpdater.on('update-available', (info) => { logUpdater(`update-available: ${JSON.stringify(info)}`); broadcast('update-available'); });
  autoUpdater.on('update-downloaded', () => { logUpdater('update-downloaded'); broadcast('update-downloaded'); });
  autoUpdater.on('update-not-available', (info) => { logUpdater(`update-not-available: ${JSON.stringify(info)}`); broadcast('update-not-available'); });
  autoUpdater.on('error', (err) => { logUpdater(`error 이벤트: ${err?.stack || err}`); broadcast('update-error', err?.message || String(err)); });
  try { autoUpdater.checkForUpdates(); } catch(e) { logUpdater(`checkForUpdates 호출 자체 실패(catch): ${e?.stack || e}`); }
}

// ── IPC ──
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('check-for-updates', () => {
  if (!app.isPackaged) return 'dev';
  autoUpdater.checkForUpdates();
  return 'checking';
});
ipcMain.on('about-resize', (_, h) => {
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.setContentSize(ABOUT_W, Math.round(h));
});
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => {
  saveConfig(cfg);
  if (aboutWin && !aboutWin.isDestroyed() && cfg.theme) aboutWin.webContents.send('theme-changed', cfg.theme);
  return true;
});
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
// 실제 쇼츠 판별(2026-08-06) — 유튜브 데이터API엔 "이게 쇼츠다" 필드가 없어서
// videoDuration 파라미터(길이만 보는 근사치)로 걸러왔는데 일반 영상까지 오탐되던 문제.
// youtube.com/shorts/<id>를 리다이렉트 없이 직접 요청하면 진짜 쇼츠는 200, 아니면 /watch로
// 303 리다이렉트되는 걸 실측 확인(2026-08-06) — 이 응답 코드로 정확히 판별한다.
function checkIsShort(videoId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.youtube.com',
      path: `/shorts/${encodeURIComponent(videoId)}`,
      method: 'HEAD',
      timeout: 5000,
    }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(null));   // 판별 실패 시 null(모름) — 필터에서 걸러내지 않고 통과시킴
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
ipcMain.handle('check-shorts', async (_, videoIds) => {
  const ids = [...new Set(videoIds || [])];
  const entries = await Promise.all(ids.map(async (id) => [id, await checkIsShort(id)]));
  return Object.fromEntries(entries);
});
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
