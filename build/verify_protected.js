/* ══════════════════════════════════════════════════════════════════════════
   K-Tube — 보호빌드 검증기 (PND-0113)

   무엇을 하는가
     ① 정적 검사 — build/protect.js 가 만든 "무대"를 원본과 대조한다.
        · 개발 주석(형 원문 포함)이 남아 있지 않은가
        · 화면 뼈대(HTML 태그·속성·글자)와 CSS 가 "주석만 뺀 원본"과 바이트 단위로 같은가
        · HTML 의 onclick 이 부르는 전역 함수 이름이 하나도 안 사라졌는가
        · 소스맵 주소(sourceMappingURL)가 배포물에 안 들어갔는가
     ② 실행 검사 — 무대를 Electron 으로 실제로 띄우고 CDP(크롬 개발자도구 통로)로
        화면 안에서 아래를 확인한다. 화면이 뜨는 것만으로는 통과가 아니다.
        · 화면 로딩 중 자바스크립트 오류 0건
        · 버튼이 부르는 전역 함수가 전부 실제로 존재하는가
        · 사용자 설정(ktube_config.json)이 그대로 읽히는가
        · ★ yt-dlp(외부 실행파일) 호출 경로가 실제로 도는가 — 영상 정보 조회까지

   사용법
     node build/verify_protected.js              # 무대(보호본) 검사
     node build/verify_protected.js --original   # 원본으로 같은 검사(기준선)
     환경변수 KTUBE_ELECTRON 으로 Electron 실행파일을 지정할 수 있다.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP = path.resolve(__dirname, '..');
const STAGE = process.env.KTUBE_STAGE || '/private/tmp/ktube-protected-stage';
const USERDATA = '/private/tmp/ktube-verify-userdata';
const PORT = 9333;
const USE_ORIGINAL = process.argv.includes('--original');
const TARGET = USE_ORIGINAL ? APP : STAGE;
const ELECTRON = process.env.KTUBE_ELECTRON ||
  path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const PROBE_MARK = '/private/tmp/ktube-verify-ytdlp-calls.txt';

/* 검사용 씨앗 설정 — 이 값이 화면까지 그대로 읽히면 "사용자 설정이 살아 있다"는 뜻 */
const SEED_CONFIG = {
  interests: '검증용주제A, 검증용주제B',
  theme: 'ember',
  alwaysOnTop: false,
  autoAdvance: true,
  rememberQuality: true,
  backgroundPlay: true,
  width: 1100,
  height: 700,
};
/* 외부 실행파일(yt-dlp) 경로를 실제로 타는지 확인할 때 쓰는 영상 */
const PROBE_VIDEO = 'dQw4w9WgXcQ';

let fails = 0;
function ok(msg) { console.log('  ok    ' + msg); }
function bad(msg) { fails++; console.log('  FAIL  ' + msg); }
function check(cond, msg) { cond ? ok(msg) : bad(msg); }

/* ── 공용: <tag> 본문 구간 찾기 (protect.js 와 같은 규칙) ─────────────── */
function findBlocks(src, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    const s = m.index + m[0].length;
    const e = src.toLowerCase().indexOf(`</${tag}>`, s);
    if (e < 0) continue;
    if (/\ssrc\s*=/i.test(attrs)) { re.lastIndex = e; continue; }
    out.push([s, e]);
    re.lastIndex = e;
  }
  return out;
}
function stripCssComments(src) {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2;
      out += '\n'.repeat(src.slice(i, stop).split('\n').length - 1); i = stop; continue;
    }
    out += c; i++;
  }
  return out;
}

/* HTML 이 onclick 등으로 부르는 전역 이름을 원본에서 뽑는다 */
function handlerNames() {
  const src = fs.readFileSync(path.join(APP, 'renderer/index.html'), 'utf8');
  const builtin = new Set(['window', 'document', 'event', 'Date', 'Math', 'JSON',
    'parseInt', 'parseFloat', 'String', 'Number', 'confirm', 'alert',
    'getElementById', 'stopPropagation', 'add', 'remove']);
  const names = new Set();
  for (const m of src.matchAll(/\bon\w+\s*=\s*(["'])([\s\S]*?)\1/g))
    /* 앞에 점이 붙은 것(window.api?.closeApp 등)은 전역 이름이 아니라 속성이라 뺀다 */
    for (const n of m[2].matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g))
      if (!builtin.has(n[2])) names.add(n[2]);
  return [...names].sort();
}

/* ── ① 정적 검사 ───────────────────────────────────────────────────── */
function staticChecks() {
  console.log('\n[1] 정적 검사 — 무대 =', STAGE);
  const files = ['main.js', 'preload.js', 'renderer/about-preload.js',
    'renderer/index.html', 'renderer/about.html'];

  let hyung = 0, pnd = 0, smap = 0;
  for (const rel of files) {
    const t = fs.readFileSync(path.join(STAGE, rel), 'utf8');
    hyung += (t.match(/형/g) || []).length;
    pnd += (t.match(/PND-/g) || []).length;
    smap += (t.match(/sourceMappingURL/g) || []).length;
  }
  check(hyung === 0, `배포물에 '형' 0건 (실측 ${hyung}건)`);
  check(pnd === 0, `배포물에 'PND-' 0건 (실측 ${pnd}건)`);
  check(smap === 0, `배포물에 소스맵 주소 0건 (실측 ${smap}건)`);

  /* 주석 잔존 — 원본의 주석 문구를 표본으로 뽑아 배포물에서 찾는다 */
  const origAll = files.map((r) => fs.readFileSync(path.join(APP, r), 'utf8')).join('\n');
  const samples = [...origAll.matchAll(/^\s*\/\/\s*(.{12,60}?)\s*$/gm)]
    .map((m) => m[1]).filter((s) => /[가-힣]/.test(s)).slice(0, 200);
  const stageAll = files.map((r) => fs.readFileSync(path.join(STAGE, r), 'utf8')).join('\n');
  const leaked = samples.filter((s) => stageAll.includes(s));
  check(leaked.length === 0,
    `원본 주석 표본 ${samples.length}건 중 배포물 잔존 0건 (실측 ${leaked.length}건)` +
    (leaked.length ? ' → ' + leaked.slice(0, 3).join(' | ') : ''));

  /* 화면 뼈대 + CSS 가 "주석만 뺀 원본"과 바이트 단위로 같은가 */
  for (const rel of ['renderer/index.html', 'renderer/about.html']) {
    const a0 = fs.readFileSync(path.join(APP, rel), 'utf8');
    const b0 = fs.readFileSync(path.join(STAGE, rel), 'utf8');
    const mask = (s) => {
      let out = s;
      for (const [st, en] of findBlocks(s, 'script').reverse())
        out = out.slice(0, st) + '@@S@@' + out.slice(en);
      return out;
    };
    let A = mask(a0).replace(/<!--[\s\S]*?-->/g, '');
    for (const [st, en] of findBlocks(A, 'style').reverse())
      A = A.slice(0, st) + stripCssComments(A.slice(st, en)) + A.slice(en);
    check(A === mask(b0), `${rel} — 뼈대·CSS 가 '주석만 뺀 원본'과 완전히 같음`);
  }

  /* 버튼이 부르는 전역 이름이 다 살아 있는가 */
  const prot = fs.readFileSync(path.join(STAGE, 'renderer/index.html'), 'utf8');
  const names = handlerNames();
  const gone = names.filter((n) => !new RegExp('\\b' + n + '\\b').test(prot));
  check(gone.length === 0,
    `버튼이 부르는 전역 함수 ${names.length}개 전부 생존` + (gone.length ? ' → 사라짐: ' + gone.join(', ') : ''));

  /* 이름 뭉개짐 흔적 — main.js 는 최상위까지 바꾸므로 원본 식별자가 남으면 안 된다 */
  const m = fs.readFileSync(path.join(STAGE, 'main.js'), 'utf8');
  for (const n of ['getYtDlpOverridePath', 'getDirectStreamUrls', 'startLocalServer',
    'migrateLegacyUserData', 'isProgressiveFormat'])
    check(!m.includes(n), `main.js — 원본 함수 이름 '${n}' 안 보임`);
  check(!/\n/.test(m.slice(0, 4000)) || m.split('\n').length < 40,
    `main.js — 한 줄로 압축됨 (줄 수 ${m.split('\n').length})`);

  /* 설정 파일 키·IPC 채널 이름은 반드시 살아 있어야 한다(바뀌면 설정이 날아간다) */
  const all = files.map((r) => fs.readFileSync(path.join(STAGE, r), 'utf8')).join('\n');
  for (const k of ['get-direct-stream', 'get-config', 'save-config', 'check-shorts',
    'ktube_config.json', 'alwaysOnTop', 'backgroundPlay', 'autoAdvance',
    'rememberQuality', 'interests', 'theme', 'apiKeys'])
    check(all.includes(k), `설정·통신 이름 '${k}' 보존됨`);
}

/* ── ② 실행 검사 ───────────────────────────────────────────────────── */
function seedUserData() {
  fs.mkdirSync(USERDATA, { recursive: true });
  fs.writeFileSync(path.join(USERDATA, 'ktube_config.json'),
    JSON.stringify(SEED_CONFIG, null, 2), 'utf8');

  /* ★ 사용자 폴더의 yt-dlp 갈아끼우기 통로가 살아 있는지 보기 위한 미끼.
     진짜 yt-dlp 를 부르기 전에 "불렸다"는 자국을 남기는 껍데기를 userData/bin 에 둔다.
     자국이 남으면 = 앱이 사용자 폴더 경로를 제대로 만들어 외부 실행파일을 불렀다는 뜻. */
  const real = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']
    .find((p) => fs.existsSync(p));
  fs.rmSync(PROBE_MARK, { force: true });
  const binDir = path.join(USERDATA, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (!real) { fs.rmSync(shim, { force: true }); return false; }
  fs.writeFileSync(shim,
    `#!/bin/sh\necho "$@" >> ${PROBE_MARK}\nexec ${real} "$@"\n`, 'utf8');
  fs.chmodSync(shim, 0o755);
  return true;
}

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => {
        try { res(JSON.parse(d)); } catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const p = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
      if (p && p.webSocketDebuggerUrl) return p;
    } catch (e) { /* 아직 안 떴다 */ }
    await sleep(1000);
  }
  throw new Error('창을 찾지 못했다 (개발자도구 통로 연결 실패)');
}

async function runtimeChecks() {
  console.log('\n[2] 실행 검사 — 앱 =', TARGET);
  const shimReady = seedUserData();
  const child = spawn(ELECTRON,
    [TARGET, `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  try {
    const page = await findPage();
    ok('창이 떴고 화면 주소 = ' + page.url);
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    let id = 0;
    const waiters = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown')
        pageErrors.push(msg.params?.exceptionDetails?.text + ' ' +
          (msg.params?.exceptionDetails?.exception?.description || ''));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
        pageErrors.push('console.error: ' + JSON.stringify(msg.params.args?.[0]?.value || ''));
    });
    const send = (method, params) => new Promise((res) => {
      const n = ++id; waiters.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evalJs = async (expr, awaitP = true) => {
      const r = await send('Runtime.evaluate',
        { expression: expr, awaitPromise: awaitP, returnByValue: true });
      if (r.result?.exceptionDetails)
        return { error: r.result.exceptionDetails.text + ' ' +
          (r.result.exceptionDetails.exception?.description || '') };
      return { value: r.result?.result?.value };
    };

    await send('Runtime.enable');
    await send('Page.enable');
    /* 화면이 완전히 자리잡을 때까지 */
    for (let i = 0; i < 30; i++) {
      const r = await evalJs('document.readyState', false);
      if (r.value === 'complete') break;
      await sleep(500);
    }
    await sleep(1500);

    /* 버튼이 부르는 전역 함수가 실제로 존재하는가 */
    const names = handlerNames();
    const r1 = await evalJs(
      `JSON.stringify(${JSON.stringify(names)}.filter(n => typeof window[n] !== 'function'))`, false);
    check(r1.value === '[]', `버튼이 부르는 전역 함수 ${names.length}개가 화면에 실제로 존재` +
      (r1.value !== '[]' ? ' → 없음: ' + r1.value : ''));

    /* 사용자 설정이 그대로 읽히는가 */
    const r2 = await evalJs('window.api.getConfig().then(c => JSON.stringify(c))');
    let cfg = {};
    try { cfg = JSON.parse(r2.value || '{}'); } catch (e) {}
    check(cfg.interests === SEED_CONFIG.interests && cfg.theme === SEED_CONFIG.theme,
      `사용자 설정(관심 주제·스킨)이 그대로 읽힘 → ${JSON.stringify({ interests: cfg.interests, theme: cfg.theme })}`);
    const r2b = await evalJs("document.getElementById('interestsInput') && document.getElementById('interestsInput').value");
    check(r2b.value === SEED_CONFIG.interests,
      `설정 창 입력칸에도 그 값이 들어감 → ${JSON.stringify(r2b.value)}`);

    /* ★ 외부 실행파일(yt-dlp) 경로 — 영상 정보 조회까지 실제로 돈다 */
    const r3 = await evalJs(
      `window.api.getDirectStream('${PROBE_VIDEO}').then(r => JSON.stringify({ok:!!(r&&r.ok), err:r&&r.error, n:((r&&r.qualities)||[]).length, first:((r&&r.qualities)||[])[0]&&(r.qualities[0].height+'p'), audio:!!(r&&r.audioUrl), dur:r&&r.duration}))`);
    let s = {};
    try { s = JSON.parse(r3.value || '{}'); } catch (e) {}
    check(s.ok === true && s.n > 0,
      `yt-dlp 호출 → 영상 정보 조회 성공 (화질 ${s.n}개, 첫 항목 ${s.first}, 소리 ${s.audio ? '있음' : '없음'}, 길이 ${s.dur}초)` +
      (s.err ? ' 오류=' + s.err : ''));

    /* 화면 글자가 살아 있는가(말투 통일 결과 포함) */
    const r4 = await evalJs(`document.body.innerText.includes('설정') && document.querySelector('.field-hint').textContent`, false);
    check(typeof r4.value === 'string' && r4.value.includes('전환됩니다'),
      `설정 화면 안내 문구가 그대로 보임 → ${JSON.stringify((r4.value || '').slice(0, 40))}`);

    /* 탭 전환이 실제로 도는가(전역 함수 호출) */
    const r5 = await evalJs(`switchTab('search'); document.getElementById('searchBar').style.display === 'flex' && document.getElementById('tabSearch').classList.contains('active')`, false);
    check(r5.value === true, '탭 전환(전역 함수 호출)이 실제로 동작');
    await evalJs(`switchTab('home')`, false);

    /* ★ 사용자 폴더(userData/bin)의 yt-dlp 를 실제로 집어 실행했는가 */
    if (shimReady) {
      const calls = fs.existsSync(PROBE_MARK)
        ? fs.readFileSync(PROBE_MARK, 'utf8').trim().split('\n').filter(Boolean) : [];
      check(calls.length >= 2 && calls.some((l) => l.includes('--dump-json')),
        `사용자 폴더의 yt-dlp 를 경로대로 찾아 실행함 (호출 ${calls.length}회: ${calls.map((c) => c.split(' ')[0]).join(', ')})`);
    } else {
      console.log('  skip  사용자 폴더 yt-dlp 통로 — 이 기계에 yt-dlp 가 없어 건너뜀');
    }

    check(pageErrors.length === 0,
      `화면 자바스크립트 오류 0건 (실측 ${pageErrors.length}건)` +
      (pageErrors.length ? ' → ' + pageErrors.slice(0, 3).join(' || ') : ''));

    ws.close();
  } finally {
    child.kill('SIGTERM');
    await sleep(800);
    try { child.kill('SIGKILL'); } catch (e) {}
  }
  const joined = logs.join('');
  if (/이사 실패|복사 실패/.test(joined)) bad('설정 폴더 이사 중 오류 로그가 찍힘');
  else ok('설정 폴더 처리 중 오류 로그 없음');
}

(async () => {
  if (!USE_ORIGINAL) staticChecks();
  await runtimeChecks();
  console.log(fails === 0 ? '\n[verify] 전부 통과' : `\n[verify] 실패 ${fails}건`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
