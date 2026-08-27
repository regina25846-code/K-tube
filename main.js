const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const https = require('https');

// yt-dlp 바이너리 경로 — K-Music과 동일한 탐색 패턴(2026-07-20)
//
// ── 번들 바이너리 버전 기록 (2026-08-27 갱신) ───────────────────────────────
// bin/yt-dlp.exe 는 .gitignore 대상이라 git diff/로그에 안 잡힌다. "지금 뭐가 깔려있는지"를
// 나중에 추적할 수 있도록 여기에만 명시적으로 남긴다. 바꿀 때마다 아래 두 줄도 같이 고칠 것.
//
//   버전   : yt-dlp 2026.08.19 (공식 stable, yt-dlp/yt-dlp 릴리스)
//   sha256 : 66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a
//
//   (이전: 2026.07.04 / 52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8)
//
// 교체 이유 — 유튜브가 SABR 전용 스트리밍을 켜면서, 2026.07.04로 뽑은 스트림 주소는 앞쪽
// 1,000,000바이트까지만 서빙되고 그 뒤는 403으로 끊겼다(실측). K-Tube는 이 주소를
// <video>/<audio>에 직접 물리는 구조라 1MB를 넘는 영상은 재생이 시작조차 안 됐다.
// 해당 수정(visionos 클라이언트 추가 #17184, 2026-07-09 머지)이 2026.08.19 정식 릴리스에
// 실려서 나이틀리 대신 공식 stable을 번들한다. 교체 후 Range 2000000- 요청이 206으로
// 정상 응답하는 것까지 확인함(2026-08-27).
//
// ⚠️ 다만 바이너리 교체만으로는 재생이 안 된다 — 아래 getDirectStreamUrls의 진행형 포맷
// 화이트리스트 필터와 반드시 한 세트다. 자세한 건 그쪽 주석 참고.
//
// ── 오버라이드 통로(2026-08-18 신설, 임시 성격) ──────────────────────────────
// K-Music main.js에 넣은 것과 글자 그대로 같은 구조다.
//
// 앱 재빌드 없이 실행파일만 갈아끼우는 통로를 하나만 둔다. userData/bin/ 아래에
// 실행 가능한 yt-dlp가 있으면 그걸 먼저 쓰고, 없으면 예전과 완전히 똑같이 번들 exe로 간다.
// override 파일만 지우면 번들(위 기록된 버전)로 원복이고, 이 블록을 통째로 지워도 아래
// 원본 함수 본문은 손댄 곳이 없다.
//
// ⚠️ override가 걸려 있으면 위 "번들 바이너리 버전 기록"과 실제로 도는 버전이 다를 수 있다.
// 우회재생이 이상하면 userData/bin/ 부터 확인할 것.
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
//
// ── 진행형(progressive) 포맷 화이트리스트 (2026-08-27 추가) ──────────────────
// <video>/<audio> 태그는 "바이트 범위를 그대로 받아서 디코딩하는" 단일 파일 URL만 재생할 수
// 있다. HLS(.m3u8 재생목록)나 DASH 매니페스트는 브라우저가 직접 못 푼다 — 크롬은 hls.js
// 같은 자바스크립트 라이브러리 없이는 HLS를 재생하지 못하기 때문이다.
//
// 그런데 yt-dlp가 돌려주는 formats 배열엔 진행형(https 단일 파일)과 HLS/DASH가 섞여 있고,
// 화질(height)이 같은 항목이 양쪽에 다 있다. 예전 코드는 protocol을 아예 안 보고 tbr(비트레이트)만
// 비교해서 골랐는데, HLS 쪽 tbr이 대체로 더 높게 잡히는 바람에 **전 화질 100%가 m3u8로
// 선택**됐다(2026-08-27 실측: a3yHob16vP8은 6/6개, dQw4w9WgXcQ는 8/8개 전부 m3u8).
// 그 URL을 <video>에 물리니 당연히 재생이 안 됐다.
//
// 그래서 "빼고 싶은 걸 지우는" 블랙리스트가 아니라 "쓸 수 있는 것만 통과시키는" 화이트리스트로
// 판정한다. 유튜브가 나중에 http_dash_segments 같은 새 프로토콜을 추가해도 자동으로 걸러진다.
// protocol 문자열만 믿지 않고 URL 모양(.m3u8 / /manifest/)까지 같이 보는 건, 같은 https
// 프로토콜로 표시되면서 실제 내용은 매니페스트인 항목을 방어하기 위해서다.
//
// ⚠️ canPlayType() 기반 판정은 쓰지 않는다 — 크롬이 HLS MIME 타입에 대해 "maybe"를 돌려주는
// 게 실측으로 확인됐다(실제론 재생 못 하면서). 브라우저 자기 신고를 믿으면 안 되는 자리다.
function isProgressiveFormat(f) {
  if (!f || !f.url) return false;
  if (f.protocol !== 'https' && f.protocol !== 'http') return false;
  if (f.url.includes('.m3u8')) return false;
  if (f.url.includes('/manifest/')) return false;
  return true;
}

async function getDirectStreamUrls(videoId) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const json = await ytdlp(['--no-playlist', '--dump-json', '--no-warnings', ytUrl]);
  const info = JSON.parse(json);

  const allFormats = info.formats || [];
  const progressive = allFormats.filter(isProgressiveFormat);

  const heights = {};
  for (const f of progressive) {
    if (f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && f.height) {
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
  for (const f of progressive) {
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      if (!bestAudio || (f.abr || 0) > (bestAudio.abr || 0)) bestAudio = f;
    }
  }

  // 진행형이 하나도 없다 = 라이브 방송처럼 HLS로만 서빙되는 영상. 렌더러가 "재생 실패"로
  // 뭉뚱그리지 않고 "실시간 방송이라 재생 불가"라고 정확히 안내할 수 있게 사유를 같이 넘긴다.
  // (isLive는 참고용 — 라이브가 아닌데 HLS만 있는 경우도 같은 분기로 보낸다.)
  const hlsOnly = qualities.length === 0 && allFormats.length > 0;

  return {
    qualities,
    audioUrl: bestAudio ? bestAudio.url : null,
    duration: info.duration,
    hlsOnly,
    isLive: !!(info.is_live || info.live_status === 'is_live'),
  };
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

// 우회재생이 실패했을 때 렌더러가 부르는 두 통로(2026-08-27).
//
// ① 진짜로 브라우저에서 열기 — 렌더러에서 <a target="_blank">로 유튜브 주소를 열면
// setWindowOpenHandler가 가로채서 "K-Tube 안에서 재생"으로 되돌려버린다. 재생이 안 돼서
// 띄운 안내창의 [YouTube에서 열기]가 그 경로를 타면 같은 실패로 되돌아오는 무한루프가 되므로,
// 핸들러를 우회해서 진짜 기본 브라우저로 넘기는 전용 통로가 필요하다.
// 렌더러에 임의 URL 열기 권한을 주지 않도록 유튜브 영상 주소만 통과시킨다.
ipcMain.handle('open-external-youtube', (_, videoId) => {
  if (typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return false;
  shell.openExternal(`https://www.youtube.com/watch?v=${videoId}`);
  return true;
});

// ② 실패 사유 기록 — updater-error.log와 같은 방식으로 userData 아래에 남긴다.
// 형 PC에서 재현된 실패를 나중에 확인할 수 있어야 해서 콘솔 말고 파일로도 남김.
// ⚠️ videoId와 기술적 상태값만 기록한다(제목/검색어/계정 등 개인정보 금지).
ipcMain.handle('log-playback-error', (_, payload) => {
  try {
    const p = payload || {};
    const line = [
      `videoId=${String(p.videoId || '').slice(0, 11)}`,
      `kind=${String(p.kind || '').slice(0, 24)}`,
      `mediaErrorCode=${p.code == null ? '-' : p.code}`,
      `networkState=${p.networkState == null ? '-' : p.networkState}`,
      `readyState=${p.readyState == null ? '-' : p.readyState}`,
      `quality=${p.quality == null ? '-' : p.quality}`,
      `qualityCount=${p.qualityCount == null ? '-' : p.qualityCount}`,
      `element=${String(p.element || '-').slice(0, 8)}`,
      `detail=${String(p.detail || '').replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
    ].join(' ');
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'playback-error.log'),
      `[${new Date().toISOString()}] ${line}\n`
    );
  } catch (e) {}
  return true;
});

// ── userData 이사 (구 kris-tube → 신 K-Tube, 2026-08-27) ──────────────────
// package.json에 top-level productName: "K-Tube"를 추가하면서 Electron이 계산하는
// userData 경로도 같이 바뀐다(app.getName()이 곧 폴더 이름 — K-Drawlog에서 실측 확인된
// 패턴, `kris_draw/app/main.js`의 migrateLegacyUserData와 같은 구조). 그냥 두면 형이
// 이미 넣어둔 API 키/관심주제/yt-dlp override/로그인 쿠키가 구 폴더에 남아 "설정이
// 사라진 것처럼" 보인다.
//
// ⚠ 옮기지 않고 '복사'한다(rename 금지) — 실패해도 구 폴더가 그대로 남아 있어야
//   되돌릴 수 있다. 새 폴더에 이미 같은 이름의 파일이 있으면 절대 덮어쓰지 않고
//   skip한다(새 폴더 쪽이 최신이라는 뜻, 파일 단위 멱등 — 재기동해도 중복복사 없음).
// ⚠ 캐시류(Cache/Code Cache/GPUCache/Dawn*Cache/blob_storage/Shared Dictionary/
//   Trust Tokens/Singleton*/DevToolsActivePort)는 아래 화이트리스트에 없으므로
//   자동 제외된다 — 통째로 복사하면 첫 실행이 오래 걸릴 수 있다(K-Music 실측 Cache 88MB).
const LEGACY_USERDATA_DIR = 'kris-tube';
// userData 루트 바로 아래의 단일 파일들
const MIGRATE_FILES = ['ktube_config.json', 'Cookies', 'Preferences', 'updater-error.log', 'playback-error.log'];
// userData 루트 아래의 하위 경로에 있는 단일 파일(중첩 폴더는 필요한 파일 자리까지만 만든다)
const MIGRATE_NESTED_FILES = [['bin', 'yt-dlp.exe']];
// 재귀 복사가 필요한 폴더 전체(내부 파일 단위로 skip 판정)
const MIGRATE_DIRS = ['Local Storage'];

// 반환값 = 실제로 새로 복사한 파일 개수(재기동 시 "복사함" 로그가 매번 찍히는 걸 막기 위함 — 이미
// 다 있으면 0을 돌려주고 호출부에서 로그를 생략한다)
function copyDirRecursiveSkipExisting(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirRecursiveSkipExisting(src, dst);
    } else if (entry.isFile()) {
      if (fs.existsSync(dst)) continue; // 멱등 — 새 쪽에 이미 있으면 안 건드림
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  return copied;
}

function migrateLegacyUserData() {
  try {
    const target = app.getPath('userData');
    const parent = path.dirname(target);
    const legacy = path.join(parent, LEGACY_USERDATA_DIR);
    if (legacy === target || !fs.existsSync(legacy)) return; // 구 폴더 자체가 없으면 할 일 없음
    fs.mkdirSync(target, { recursive: true });

    for (const f of MIGRATE_FILES) {
      const src = path.join(legacy, f);
      const dst = path.join(target, f);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.copyFileSync(src, dst);
        console.log('[ktube] 이전 설정 폴더에서 복사:', f);
      } catch (e) { console.error('[ktube] 파일 복사 실패(무시):', f, e.message); }
    }

    for (const nested of MIGRATE_NESTED_FILES) {
      const src = path.join(legacy, ...nested);
      const dst = path.join(target, ...nested);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        console.log('[ktube] 이전 설정 폴더에서 복사:', nested.join('/'));
      } catch (e) { console.error('[ktube] 파일 복사 실패(무시):', nested.join('/'), e.message); }
    }

    for (const d of MIGRATE_DIRS) {
      const src = path.join(legacy, d);
      const dst = path.join(target, d);
      if (!fs.existsSync(src)) continue;
      try {
        const n = copyDirRecursiveSkipExisting(src, dst);
        if (n > 0) console.log('[ktube] 이전 설정 폴더에서 복사:', d + '/', `(${n}개 파일)`);
      } catch (e) { console.error('[ktube] 폴더 복사 실패(무시):', d, e.message); }
    }
  } catch (e) {
    // 실패해도 앱은 그냥 기본값으로 시작한다 — 구 폴더는 손대지 않았으므로 복구 가능.
    console.error('[ktube] userData 이사 실패(무시):', e.message);
  }
}

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
    migrateLegacyUserData();   // ★ 어떤 설정도 읽기 전에 먼저 — loadConfig()는 createWindow 안에서 처음 불린다
    createWindow();
    setupTray();
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; if (localServer) localServer.close(); });
app.on('activate', () => { if (!mainWin) createWindow(); });
