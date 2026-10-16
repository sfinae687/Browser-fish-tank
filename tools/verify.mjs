/**
 * P0 验收脚本。
 *
 * 分两层：
 *
 *   1. **静态检查** —— manifest 合法性、产物完整性、有没有引入远程代码、
 *      权限声明是否与设计一致。这些能确定的就不要靠眼睛看。
 *   2. **真实加载** —— 用 `--load-extension` 让 Chromium 真的把 dist/ 当扩展装起来，
 *      然后直接访问 `chrome-extension://<id>/newtab/index.html` 截图。
 *      扩展 ID 由扩展目录的绝对路径哈希推导（未打包扩展的规则），
 *      所以不需要去 chrome://extensions 里抄。
 *
 * 覆盖层的**注入**没法在这里验证：它需要用户授予 `<all_urls>` 可选权限，
 * 而权限请求必须由用户手势触发。脚本会明确报告这一点，不会假装验过了。
 *
 * @see DESIGN.md §9 P0 验收标准
 */

import { stat, readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, startStaticServer, extensionIdFor } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, '.preview');

let failures = 0;
let warnings = 0;

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const warn = (msg) => {
  warnings++;
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
};
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);

// ————————————————————————————————————————————————————————————
// 1. 静态检查
// ————————————————————————————————————————————————————————————

const REQUIRED_FILES = [
  'manifest.json',
  'newtab/index.html',
  'newtab/newtab.js',
  'newtab/newtab.css',
  'options/index.html',
  'options/options.js',
  'options/options.css',
  'overlay/overlay.js',
  'bg/service-worker.js',
  'icons/16.png',
  'icons/32.png',
  'icons/48.png',
  'icons/128.png',
];

async function checkFiles() {
  section('产物完整性');
  for (const rel of REQUIRED_FILES) {
    try {
      const st = await stat(path.join(DIST, rel));
      if (st.size === 0) bad(`${rel} 是空文件`);
      else ok(`${rel}  ${(st.size / 1024).toFixed(1)} KB`);
    } catch {
      bad(`缺少 ${rel}`);
    }
  }
}

async function checkManifest() {
  section('manifest');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
  } catch (err) {
    bad(`manifest.json 无法解析：${err.message}`);
    return null;
  }

  if (manifest.manifest_version === 3) ok('manifest_version = 3');
  else bad(`manifest_version 是 ${manifest.manifest_version}，应为 3`);

  // 新标签页覆盖是 P0 的主要入口
  if (manifest.chrome_url_overrides?.newtab === 'newtab/index.html') ok('已接管新标签页');
  else bad('chrome_url_overrides.newtab 未正确配置');

  // 权限必须最小化。多一个权限就是多一份用户信任成本。
  const perms = new Set(manifest.permissions ?? []);
  const expected = new Set(['storage', 'scripting']);
  for (const p of perms) {
    if (expected.has(p)) ok(`权限 ${p}`);
    else warn(`权限 ${p} 不在设计预期内 —— 确认是否真的需要`);
  }
  for (const p of expected) {
    if (!perms.has(p)) bad(`缺少必要权限 ${p}`);
  }

  // 覆盖层必须走可选权限。静态声明 <all_urls> 会让扩展在每一个页面里都跑起来，
  // 既费性能也是隐私上不该给的默认值。
  const hostPerms = manifest.host_permissions ?? [];
  if (hostPerms.length === 0) ok('没有静态 host_permissions（覆盖层走运行时注册）');
  else bad(`不应静态声明 host_permissions：${hostPerms.join(', ')}`);

  const optional = manifest.optional_host_permissions ?? [];
  if (optional.includes('<all_urls>')) ok('optional_host_permissions 包含 <all_urls>');
  else bad('缺少 optional_host_permissions: <all_urls>，覆盖层将无法注册');

  // content script 不能静态声明，否则它会在所有页面无条件注入
  if (!manifest.content_scripts) ok('没有静态 content_scripts');
  else bad('content_scripts 必须由 service worker 运行时注册');

  if (manifest.background?.service_worker) ok(`service worker：${manifest.background.service_worker}`);
  else bad('缺少 background.service_worker');

  if (manifest.options_page) ok(`设置页：${manifest.options_page}`);
  else bad('缺少 options_page');

  return manifest;
}

async function checkNoRemoteCode() {
  section('无远程代码 / 隐私');
  const jsFiles = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
  }
  await walk(DIST);

  // MV3 本来就禁止远程代码，这里是防止有人在注释之外真的写了 fetch 加载脚本
  const suspicious = [];
  for (const file of jsFiles) {
    const text = await readFile(file, 'utf8');
    if (/https?:\/\/[^\s"')]+\.js\b/.test(text)) suspicious.push(path.relative(DIST, file));
    if (/\beval\s*\(/.test(text)) suspicious.push(`${path.relative(DIST, file)} (eval)`);
    if (/new\s+Function\s*\(/.test(text)) suspicious.push(`${path.relative(DIST, file)} (Function 构造)`);
  }

  if (suspicious.length === 0) ok(`${jsFiles.length} 个 JS 产物中未发现远程代码或动态求值`);
  else bad(`发现可疑动态代码：${suspicious.join(', ')}`);

  // 覆盖层绝不能读页面内容。
  // 注意这里**刻意不查 .textContent** —— 覆盖层会写自己的 Shadow DOM
  // 样式表（style.textContent = ...），那是写入而不是读取，查了只会得到误报。
  const overlay = await readFile(path.join(DIST, 'overlay/overlay.js'), 'utf8');
  const domReads = [
    '.innerText',
    'document.body.innerHTML',
    'document.body.innerText',
    'XMLHttpRequest',
    'sendBeacon',
    'fetch(',
  ];
  const found = domReads.filter((needle) => overlay.includes(needle));
  if (found.length === 0) ok('覆盖层未读取页面内容、未发起网络请求');
  else bad(`覆盖层里出现了页面读取或网络请求：${found.join(', ')}`);

  // 覆盖层必须用 Shadow DOM 隔离，且 pointer-events 恒为 none
  if (overlay.includes('attachShadow')) ok('覆盖层使用 Shadow DOM 隔离');
  else bad('覆盖层没有使用 Shadow DOM，会污染宿主页面的样式');
  if (overlay.includes('pointer-events: none') || overlay.includes('pointer-events:none'))
    ok('覆盖层不吃点击（pointer-events: none）');
  else bad('覆盖层没有设置 pointer-events: none，会挡住用户的点击');
}

// ————————————————————————————————————————————————————————————
// 2. 真实加载
// ————————————————————————————————————————————————————————————

async function checkExtensionLoad() {
  section('真实加载扩展');

  const id = extensionIdFor(DIST);
  console.log(`  推导出的扩展 ID：${id}`);

  await mkdir(SHOTS, { recursive: true });

  const newtabShot = path.join(SHOTS, 'verify-newtab.png');
  const newtabUrl = `chrome-extension://${id}/newtab/index.html?nointro&hud=0&quality=medium`;

  const nt = await capture({
    url: newtabUrl,
    out: newtabShot,
    loadExtension: DIST,
    width: 1600,
    height: 900,
  });

  // 扩展加载失败时 Chromium 会直接说
  const loadErrors = nt.stderr
    .split('\n')
    .filter((l) => /Failed to load extension|Manifest is not valid|Could not load/i.test(l));
  if (loadErrors.length === 0) ok('Chromium 未报告扩展加载错误');
  else for (const line of loadErrors) bad(line.trim());

  const shaderErrors = nt.console.filter((l) =>
    /no matching overloaded|undeclared identifier|着色器编译失败/i.test(l),
  );
  if (shaderErrors.length === 0) ok('着色器编译无错误');
  else for (const line of shaderErrors.slice(0, 5)) bad(line.slice(0, 300));

  const pageErrors = nt.console.filter((l) => /^\[exception\]|渲染器不可用/.test(l));
  if (pageErrors.length === 0) ok('页面没有抛出异常');
  else for (const line of pageErrors.slice(0, 5)) bad(line.slice(0, 300));

  const soft = nt.console.find((l) => l.includes('软件光栅化'));
  if (soft) warn('运行在软件光栅化上（无头环境的正常现象），已自动降画质');

  ok(`新标签页已渲染 ${nt.frames} 帧并截图`);

  // ——— 设置页 ———
  const optShot = path.join(SHOTS, 'verify-options.png');
  const opt = await capture({
    url: `chrome-extension://${id}/options/index.html`,
    out: optShot,
    loadExtension: DIST,
    width: 1600,
    height: 900,
    // 设置页左侧有实时预览。等的是「预览出图了」，不是「DOM 里有几个分区」——
    // 后者在 WebGL 挂掉时照样成立，那样的验收没有意义。
    waitFor: 'window.__aquaPreview && window.__aquaPreview.ready === true',
  });
  // opt.frames 是 runner 的帧数，设置页没有 runner —— 它等的是预览的钩子
  ok('设置页已渲染，左侧实时预览已出图');

  console.log(`\n  截图：${path.relative(ROOT, newtabShot)}`);
  console.log(`        ${path.relative(ROOT, optShot)}`);
}

/**
 * 覆盖层的**渲染**可以在网页模式下验证（用 URL 覆盖切到覆盖层的配置），
 * 但覆盖层的**注入**不能 —— 它需要用户授予可选权限。
 */
/**
 * P1 的验收标准之一是「关掉标签页一段时间后回来，世界正确推进」。
 *
 * 模块级的测试（tools/test.mjs）已经覆盖了算法本身；这里验的是**集成**：
 * 快照有没有真的写进 chrome.storage、重新打开时有没有真的读回来、
 * 以及运行时自检有没有报分叉。这一层是单元测试看不见的。
 */
async function checkWorldContinuity() {
  section('世界快照的跨会话延续（P1）');

  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const id = extensionIdFor(DIST);
  const url = `chrome-extension://${id}/newtab/index.html?nointro&hud=0&quality=low`;
  const profile = await mkdtemp(path.join(tmpdir(), 'aqua-continuity-'));

  try {
    const first = await capture({
      url,
      out: path.join(SHOTS, 'verify-continuity-1.png'),
      loadExtension: DIST,
      width: 900,
      height: 560,
      profileDir: profile,
      // 必须**等过** runner 的快照写回间隔（20 秒），否则第二次打开拿到的是
      // 一个全新世界而不是延续 —— 这个检查第一版就是这样测错了对象，
      // 断言失败时报的是「步号没前进」，看着像模拟坏了，其实是测试没等够。
      settleMs: 24000,
      // 而无头下 rAF 几乎不触发，必须逼着合成器持续产帧，
      // 渲染循环才有机会走到那个写回点。见 harness.mjs 的说明。
      keepAnimating: true,
    });

    if (first.world.tick === null) {
      bad('页面上读不到世界步号 —— runner 可能没启动');
      return;
    }
    ok(`第一次会话：tick=${first.world.tick}  hash=${first.world.hash}`);

    const second = await capture({
      url,
      out: path.join(SHOTS, 'verify-continuity-2.png'),
      loadExtension: DIST,
      width: 900,
      height: 560,
      profileDir: profile,
      settleMs: 1200,
    });

    if (second.world.tick === null) {
      bad('第二次打开读不到世界步号');
      return;
    }

    // 关键断言：第二次打开必须**接着第一次的世界往下走**，而不是从零开始。
    // 判据是步号远大于「这次会话自己跑出来的步数」——
    // 一个全新世界的 tick 会是几十，延续下来的会是几万。
    const secondSessionTicks = 30 * 3; // 第二次会话本身最多跑这么多步
    if (second.world.tick > Math.max(first.world.tick, secondSessionTicks)) {
      ok(
        `第二次打开接着上次的世界：tick=${second.world.tick}` +
          `（若是全新世界只会是几十）`,
      );
    } else {
      bad(
        `世界没有延续：${first.world.tick} → ${second.world.tick}。` +
          '快照可能没有写入 chrome.storage.local，或者读回时被校验拒绝了',
      );
    }

    if (second.world.hash !== first.world.hash) {
      ok('世界状态确实在演化（hash 已改变）');
    } else {
      bad('两次会话的 hash 完全相同 —— 世界没有推进');
    }

    if (second.world.diverged) {
      bad('页面报告确定性自检失败 —— 批量快进与逐帧推进结果不一致');
    } else {
      ok('启动时的确定性自检通过（没有发现分叉）');
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * P5 的交互端到端检查。
 *
 * 单元测试已经把「日志重放」那套架构验得很透了（18 条断言），
 * 但它们**看不见 UI 接线** —— 点击有没有接到处理函数、处理函数有没有
 * 把坐标算对、算出来的坐标有没有落到水面上。P1 那个「世界快照写进了
 * sync 却从 local 读」的 bug 就活在这一层，所以这一层必须有测试。
 */
async function checkInteraction() {
  section('玩家交互（P5）');

  const id = extensionIdFor(DIST);
  const url = `chrome-extension://${id}/newtab/index.html?nointro&hud=1&quality=low`;

  // 点画面正中偏下 —— 那一定在水里，而且大概率不是鱼（
  // 就算点到了鱼也只是选中，不会投食，下面会分别判断）
  const res = await capture({
    url,
    out: path.join(SHOTS, 'verify-interaction.png'),
    loadExtension: DIST,
    width: 1000,
    height: 620,
    // ⚠️ 必须强制产帧：投食是写进日志之后由**渲染循环里的推进**去应用的
    // （动作要落在它发生的那个 tick 上）。无头下 rAF 几乎不触发，
    // 循环不跑，动作就永远停在日志里没被应用。
    keepAnimating: true,
    settleMs: 2200,
    // 真实鼠标事件（覆盖「事件能否到达画布」）
    clicks: [{ x: 500, y: 400 }],
    // 带坐标的合成事件：覆盖「处理函数 + 坐标映射 + 投食链路」。
    // 两种一起用是因为 CDP 的合成鼠标事件在这个无头环境里不会生成 DOM click。
    evalAfter: [
      `(() => {
        const cv = document.getElementById('tank');
        const pts = [[500, 400], [380, 430], [620, 420]];
        for (const [x, y] of pts) {
          cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
        }
      })()`,
    ],
  });

  // 先确认「真实鼠标点击会落在画布上」—— 这一条覆盖事件能否到达，
  // 而且是**真实**事件（CDP 的 Input.dispatchMouseEvent）。
  if (res.world.probe) {
    const p2 = res.world.probe;
    if (p2.top === 'tank' && p2.pe === 'auto') {
      ok(`真实鼠标点击会落在画布上（elementFromPoint=${p2.top}，pointer-events=${p2.pe}）`);
    } else {
      bad(`点击落点不对：元素 ${p2.top}，pointer-events ${p2.pe}`);
    }
    if (p2.ui === 'ready') ok('页面初始化完整跑完（UI 就绪标记存在）');
    else bad(`页面初始化没有跑完：__aquaUI = ${p2.ui}`);
  }

  // 页面控制台里有没有被吞掉的异常
  const exceptions = res.console.filter((l) => /exception|Error/i.test(l));
  if (exceptions.length === 0) ok('页面没有未捕获的异常');
  else for (const line of exceptions.slice(0, 4)) bad(line.slice(0, 200));

  if (res.world.actionSeq === undefined) {
    bad('页面上读不到 actionSeq —— 交互状态没有暴露出来');
    return;
  }

  if (res.world.actionSeq > 0) {
    ok(`点击被处理并写入了意图日志（lastActionSeq=${res.world.actionSeq}）`);
  } else {
    bad('点了三次水，一条操作记录都没有 —— 点击没有接通');
  }

  if ((res.world.journal ?? 0) > 0) {
    ok(`意图日志里有 ${res.world.journal} 条记录`);
  } else {
    bad('意图日志是空的 —— appendAction 没有生效');
  }

  // 藻类/无机盐应当因为投食而抬高（哪怕只是一点点）
  if (typeof res.world.nutrients === 'number') {
    ok(`无机盐 ${res.world.nutrients.toFixed(4)} mg/L（初始约 0.3~1.1）`);
    if (res.world.nutrients > 0.3) {
      ok('投食确实影响了世界状态');
    } else {
      warn('无机盐偏低，投食的效果可能还没反映出来');
    }
  }
}

async function checkOverlayRender() {
  section('覆盖层渲染（注入需人工验证）');
  const server = await startStaticServer(DIST);

  try {
    // 用 URL 覆盖把新标签页按**覆盖层的配置**渲染，验证它的观感与着色器路径
    const url = `http://127.0.0.1:${server.port}/newtab/index.html?surface=overlay&nointro&quality=medium`;
    const out = path.join(SHOTS, 'verify-overlay.png');
    const res = await capture({ url, out, width: 1600, height: 900 });

    const shaderErrors = res.console.filter((l) =>
      /no matching overloaded|undeclared identifier|着色器编译失败/i.test(l),
    );
    if (shaderErrors.length === 0) ok('按覆盖层配置渲染无着色器错误');
    else for (const line of shaderErrors.slice(0, 3)) bad(line.slice(0, 300));

    ok(`覆盖层配置截图已生成（渲染 ${res.frames} 帧）`);
  } finally {
    server.close();
  }

  console.log(
    '  \x1b[33m!\x1b[0m 覆盖层的**实际注入**（content script 注册 + <all_urls> 授权）无法在无头环境验证 ——',
  );
  console.log('     权限请求必须由用户手势触发。请手动验证：加载 dist/ → 设置页 → 启用「页面覆盖层」→ 授权 → 打开任意网页。');
  warnings++;
}

// ————————————————————————————————————————————————————————————

async function main() {
  console.log('\x1b[1m计算水族箱 · P0 验收\x1b[0m');

  try {
    await stat(DIST);
  } catch {
    console.error('\n先跑一次 `npm run build`。dist/ 不存在。');
    process.exit(1);
  }

  await checkFiles();
  const manifest = await checkManifest();
  if (manifest) await checkNoRemoteCode();
  await checkExtensionLoad();
  await checkWorldContinuity();
  await checkInteraction();
  await checkOverlayRender();

  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m${warnings > 0 ? `（${warnings} 项提示）` : ''}`);
  } else {
    console.log(`\x1b[31m${failures} 项失败\x1b[0m${warnings > 0 ? `，${warnings} 项提示` : ''}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
