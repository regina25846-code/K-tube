/* ══════════════════════════════════════════════════════════════════════════
   K-Tube — 배포판 소스 보호 빌드 (PND-0113)

   무엇을 하는가
     이 폴더의 소스를 "무대(stage)" 폴더로 복사하면서 아래를 적용한다.
       ① main.js · preload.js · renderer/about-preload.js 를 terser(자바스크립트
          파서)로 다시 써서 주석을 전부 없애고 이름을 한 글자로 바꾼다.
       ② renderer/*.html 안의 <script> 는 주석을 없애고 함수 안쪽 이름만 바꾼다.
          ⚠ 최상위(전역) 이름은 일부러 그대로 둔다 — 아래 "왜 전역은 안 바꾸나" 참고.
       ③ renderer/*.html 안의 <style> 은 주석만 없앤다(값·순서는 그대로).
       ④ HTML 자체의 <!-- 주석 --> 을 없앤다(파서 기반, 정규식 아님).
     그 다음 그 무대 폴더에서 electron-builder 를 돌린다.

   ⚠ 원본 소스는 한 글자도 건드리지 않는다. 주석은 다음에 이 코드를 고칠 사람에게
     꼭 필요한 자산이라 저장소에는 그대로 남고, 배포 산출물에서만 빠진다.

   ⚠ 정규식으로 주석을 지우지 않는다. 문자열 안의 "//"(유튜브 주소 등)나 정규식
     리터럴을 주석으로 오인해 코드를 깨뜨리기 때문이다. JS 는 terser(진짜 파서),
     HTML 은 html-minifier-terser(진짜 파서), CSS 는 아래의 상태기계 렉서를 쓴다.

   ── 왜 index.html 의 전역 이름은 안 바꾸나 ────────────────────────────────
   이 앱의 화면 코드는 별도 .js 파일이 아니라 index.html 안에 통째로 들어 있고,
   버튼이 `onclick="switchTab('home')"` 처럼 HTML 속성으로 전역 함수를 부른다.
   게다가 그런 onclick 을 담은 HTML 을 자바스크립트 문자열로 만들어 화면에 꽂는
   자리가 수십 곳이다(예: `onclick="removeSavedChannel('...')"`).
   전역 이름을 바꾸면 그 문자열 안의 이름은 같이 안 바뀌므로 버튼이 조용히 죽는다.
   "조용히 안 도는 것"이 가장 위험하므로 전역은 남기고 함수 안쪽만 바꾼다.
   ⇒ 없어지는 것: 주석 전부(설계 판단·요청 원문). 남는 것: 전역 함수 이름.

   ── K-Tube 특유의 주의점 ─────────────────────────────────────────────────
   이 앱은 외부 실행파일(yt-dlp.exe)을 부르고 파일 경로를 다룬다. 그래서
     · 문자열은 terser 가 절대 안 건드린다(경로·명령행 인자 안전).
     · mangle.properties 를 쓰지 않는다 — IPC 채널 이름, preload 의 api.* 이름,
       설정 파일(ktube_config.json) 의 키가 전부 속성이라 손대면 설정이 날아간다.
     · bin/ 은 asar 밖(extraResources)이라 손대지 않는다.

   사용법
     node build/protect.js            # 무대만 만든다(검증용)
     node build/protect.js --build    # 무대를 만들고 electron-builder 까지 돌린다
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { minify: terserMinify } = require('terser');
const { minify: htmlMinify } = require('html-minifier-terser');

const APP = path.resolve(__dirname, '..');
const STAGE = process.env.KTUBE_STAGE || '/private/tmp/ktube-protected-stage';
const MAPDIR = path.join(APP, 'dist', 'sourcemaps');

/* 통째로 terser 에 넘기는 파일 (전역 이름까지 바꾼다 — HTML 이 참조하지 않는다) */
const JS_FILES = ['main.js', 'preload.js', 'renderer/about-preload.js'];
/* <script>/<style> 를 안에 품은 파일 (전역 이름은 남긴다) */
const HTML_FILES = ['renderer/index.html', 'renderer/about.html'];
/* 그대로 나르는 것 */
const COPY_DIRS = ['assets', 'build', 'bin'];
const COPY_FILES = ['package.json'];

/* ── CSS 주석 제거 (상태기계 렉서 — 정규식 아님) ───────────────────────
   CSS 에는 정규식 리터럴이 없으므로 신경 쓸 상태는 ' " 문자열과 주석뿐이다. */
function stripCssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      /* 주석 안의 줄바꿈 수는 유지한다 — 줄 번호가 밀리면 나중에 문제 위치를 못 찾는다 */
      const nl = src.slice(i, stop).split('\n').length - 1;
      out += '\n'.repeat(nl);
      i = stop;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* ── <tag> ... </tag> 블록을 순서대로 찾는다 (src= 가 붙은 <script> 는 건너뛴다) */
function findBlocks(src, tag) {
  const blocks = [];
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let m;
  while ((m = openRe.exec(src))) {
    const attrs = m[1] || '';
    const bodyStart = m.index + m[0].length;
    const closeIdx = src.toLowerCase().indexOf(`</${tag}>`, bodyStart);
    if (closeIdx < 0) continue;
    if (/\ssrc\s*=/i.test(attrs)) { openRe.lastIndex = closeIdx; continue; }
    blocks.push({ start: bodyStart, end: closeIdx, body: src.slice(bodyStart, closeIdx) });
    openRe.lastIndex = closeIdx;
  }
  return blocks;
}

/* 찾은 블록들을 뒤에서부터 갈아끼운다(앞에서 하면 인덱스가 밀린다) */
function replaceBlocks(src, blocks, newBodies) {
  let out = src;
  for (let i = blocks.length - 1; i >= 0; i--) {
    out = out.slice(0, blocks[i].start) + newBodies[i] + out.slice(blocks[i].end);
  }
  return out;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function ensure(p) { fs.mkdirSync(p, { recursive: true }); }

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  ensure(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'protect.js' || e.name === 'verify_protected.js') continue; // 빌드 도구 자신은 안 나른다
    if (e.name === '.DS_Store') continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const build = process.argv.includes('--build');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const mapOut = path.join(MAPDIR, pkg.version);

  console.log('[protect] stage =', STAGE);
  rmrf(STAGE); ensure(STAGE);
  rmrf(mapOut); ensure(mapOut);

  /* ① 독립 JS — terser, 전역 이름까지 바꾼다 */
  for (const rel of JS_FILES) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    const res = await terserMinify({ [path.basename(rel)]: src }, {
      ecma: 2020,
      module: false,
      /* toplevel: true 라야 최상위 함수·변수 이름까지 바뀐다.
         이 세 파일은 eval / new Function / class / Function.name 을 한 곳도 쓰지
         않는다(2026-09-05 전수 확인) — 이름을 바꿔도 참조가 깨질 통로가 없다.
         HTML 이 이 파일의 이름을 부르지도 않는다(preload 는 contextBridge 로만 노출). */
      compress: { passes: 2, drop_debugger: true },
      mangle: { toplevel: true },
      /* 속성 이름(mangle.properties)은 절대 건드리지 않는다.
         IPC 채널 이름 · preload 의 api.* · ktube_config.json 의 설정 키가 전부
         속성이라 손대는 순간 렌더러 통신과 사용자 설정이 깨진다. */
      format: { comments: false },
      sourceMap: { filename: path.basename(rel), url: false },
    });
    if (res.error) throw res.error;
    const dst = path.join(STAGE, rel);
    ensure(path.dirname(dst));
    fs.writeFileSync(dst, res.code, 'utf8');
    fs.writeFileSync(path.join(mapOut, rel.replace(/[\\/]/g, '__') + '.map'), res.map, 'utf8');
    const b = Buffer.byteLength(src), a = Buffer.byteLength(res.code);
    console.log(`[protect] js   ${rel.padEnd(26)} ${b} → ${a} (${(a / b * 100).toFixed(0)}%)`);
  }

  /* ②③④ HTML — 안의 <script>/<style> 을 먼저 손보고, 마지막에 HTML 주석 제거 */
  for (const rel of HTML_FILES) {
    const srcPath = path.join(APP, rel);
    const src = fs.readFileSync(srcPath, 'utf8');

    /* ③ <style> — 주석만 제거 */
    const styles = findBlocks(src, 'style');
    let out = replaceBlocks(src, styles, styles.map((b) => stripCssComments(b.body)));

    /* ② <script> — 주석 제거 + 함수 안쪽 이름만 변경 */
    const scripts = findBlocks(out, 'script');
    const newScripts = [];
    for (let i = 0; i < scripts.length; i++) {
      const name = `${path.basename(rel)}#${i}`;
      const res = await terserMinify({ [name]: scripts[i].body }, {
        ecma: 2020,
        module: false,
        /* compress 는 하되 toplevel 은 손대지 않는다 — 안 쓰이는 것처럼 보이는
           전역 함수(실제로는 HTML 의 onclick 이 부른다)를 지워버리면 안 된다. */
        compress: { passes: 2, drop_debugger: true, toplevel: false },
        /* ⚠ toplevel: false — 위 "왜 index.html 의 전역 이름은 안 바꾸나" 참고 */
        mangle: { toplevel: false },
        format: { comments: false },
        sourceMap: { filename: name, url: false },
      });
      if (res.error) throw res.error;
      newScripts.push('\n' + res.code + '\n');
      fs.writeFileSync(
        path.join(mapOut, (rel.replace(/[\\/]/g, '__') + `.script${i}.map`)),
        res.map, 'utf8');
      const b = Buffer.byteLength(scripts[i].body), a = Buffer.byteLength(res.code);
      console.log(`[protect] js   ${(rel + ' <script#' + i + '>').padEnd(26)} ${b} → ${a} (${(a / b * 100).toFixed(0)}%)`);
    }
    out = replaceBlocks(out, scripts, newScripts);

    /* ④ HTML 주석 — 파서 기반 제거. 레이아웃에 영향 줄 수 있는 옵션은 전부 끈다. */
    out = await htmlMinify(out, {
      removeComments: true,
      collapseWhitespace: false,
      conservativeCollapse: false,
      minifyJS: false,
      minifyCSS: false,
      caseSensitive: true,
      keepClosingSlash: true,
      html5: true,
      /* 이 옵션이 없으면 파서가 disabled → disabled="disabled" 로 다시 써 버린다. */
      collapseBooleanAttributes: true,
      removeAttributeQuotes: false,
      removeEmptyAttributes: false,
      removeRedundantAttributes: false,
      sortAttributes: false,
      sortClassName: false,
    });

    const dst = path.join(STAGE, rel);
    ensure(path.dirname(dst));
    fs.writeFileSync(dst, out, 'utf8');
    console.log(`[protect] html ${rel.padEnd(26)} ${Buffer.byteLength(src)} → ${Buffer.byteLength(out)}`);
  }

  /* ⑤ 그대로 나르는 것 */
  for (const rel of COPY_DIRS) copyDir(path.join(APP, rel), path.join(STAGE, rel));
  for (const rel of COPY_FILES) fs.copyFileSync(path.join(APP, rel), path.join(STAGE, rel));

  /* ⑥ 무대용 package.json
       · files 를 못 박아 무대 밖 파일이 섞여 들어가는 것을 막는다.
       · asar 를 켠다 — 암호화는 아니지만 메모장으로 바로 열리는 상태는 면한다.
         (원래 배포는 asar:false 였다. 기존 `npm run build` 는 그대로 두고
          보호빌드에서만 켠다.)
       · 산출물은 원래 위치(dist/)에 그대로 떨어뜨린다. */
  const spkg = JSON.parse(fs.readFileSync(path.join(STAGE, 'package.json'), 'utf8'));
  spkg.build.asar = true;
  spkg.build.files = [
    'main.js', 'preload.js',
    'renderer/**/*', 'assets/**/*',
    'package.json',
  ];
  spkg.build.directories = Object.assign({}, spkg.build.directories, {
    output: path.join(APP, 'dist'),
    buildResources: 'build',
  });
  delete spkg.scripts;
  /* 개발용 메모(PND 번호 등)는 배포되는 package.json 에 남기지 않는다 */
  delete spkg['//'];
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(spkg, null, 2), 'utf8');

  /* ⑦ node_modules 는 심볼릭 링크로 빌려 쓴다(복사하면 수백 MB) */
  const nm = path.join(STAGE, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(APP, 'node_modules'), nm, 'dir');

  console.log('[protect] 소스맵 보관 =', mapOut);
  console.log('[protect] 무대 준비 완료');

  if (build) {
    console.log('[protect] electron-builder 시작…');
    execFileSync(path.join(APP, 'node_modules/.bin/electron-builder'),
      ['--win', '--x64', '--publish', 'never'],
      { cwd: STAGE, stdio: 'inherit' });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
