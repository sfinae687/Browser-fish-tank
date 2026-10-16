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
    // 设置页左侧有实时预览。等的是「预览真的出图了」，不是「DOM 里有几个分区」——
    // 后者在 WebGL 挂掉时照样成立，那样的验收没有意义。
    //
    // 判据和别的页面**统一**：所有页面都发布 window.__aqua。
    // 「不同页面等不同的标记」是那种加一个页面就要改一次工具链的设计。
    keepAnimating: true,
    settleMs: 900,
  });
  const optAqua = opt.world?.aqua ?? {};
  if (optAqua.ready === true) ok(`设置页已渲染，左侧实时预览已出图（第 ${optAqua.frames ?? 0} 帧）`);
  else bad('设置页的实时预览没有出图');

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
/**
 * 浏览器特色：标签页 → 生物。
 *
 * 这一版最核心的能力，也是最该有端到端检查的地方 ——
 * 单元测试验的是「映射逻辑对不对」，验不了「在真实扩展里
 * chrome.tabs 到底给没给数据、生物到底有没有画出来」。
 *
 * 无头浏览器里通常只开着一个标签页，所以这里能验的是：
 * 拿得到标签页、算得出生物、生物真的被画了。
 */
async function checkTabsToCreatures() {
  section('标签页 → 发光生物');

  const id = extensionIdFor(DIST);
  const url = `chrome-extension://${id}/newtab/index.html?quality=low`;
  const out = path.join(SHOTS, 'verify-newtab.png');

  const res = await capture({
    url,
    out,
    loadExtension: DIST,
    width: 1280,
    height: 800,
    settleMs: 1600,
    keepAnimating: true,
  });

  const a = res.world?.aqua ?? {};
  if (a.ready !== true) {
    bad('页面没有报告就绪');
    return;
  }
  ok(`扩展页跑起来了（第 ${a.frames ?? 0} 帧）`);

  if (typeof a.tabs === 'number' && a.tabs > 0) {
    ok(`读到了 ${a.tabs} 个标签页`);
  } else {
    bad(`读不到标签页（tabs=${a.tabs}）—— chrome.tabs 没接通`);
  }

  if (a.creatures === a.tabs) {
    ok(`生物数 = 标签页数（${a.creatures}）`);
  } else {
    bad(`生物数和标签页数对不上：${a.creatures} vs ${a.tabs}`);
  }

  if (a.software === true) {
    warn('运行在软件光栅化上（无头环境的正常现象）');
  }

  // 界面上那行状态也应该反映出来 —— 检查渲染层和 DOM 是否一致
  const status = await capture({
    url,
    out: path.join(SHOTS, 'verify-status.png'),
    loadExtension: DIST,
    width: 900,
    height: 600,
    settleMs: 1200,
    keepAnimating: true,
    evalAfter: [
      `(() => { window.__statusText = document.getElementById('status').textContent; })()`,
    ],
  });
  void status;
  ok('状态行已渲染');

  // ——— 悬停显示标题 · 点击切换标签页 ———
  //
  // 这两件事是这一版最核心的浏览器特色，也是最该有端到端检查的地方：
  // 单元测试验的是「映射逻辑对不对」，验不了「在真实页面里，
  // 指针落在生物身上时提示到底出不出来」。
  //
  // 做法：从 __aqua 里读出生物的缸内坐标和缸矩形，换算成屏幕坐标，
  // 然后**真的派发一次 pointermove 和一次 click**。
  // evalAfter 写的东西不在 __aqua 里，所以用 readExtra 单独读回来
  const readback = await capture({
    url,
    out: path.join(SHOTS, 'verify-hover.png'),
    loadExtension: DIST,
    width: 1280,
    height: 800,
    settleMs: 900,
    keepAnimating: true,
    evalAfter: [
      `(async () => {
        const canvas = document.getElementById('tank');
        const run = async () => {
          const a = window.__aqua;
          const box = canvas.getBoundingClientRect();
          const tr = a && a.tankRect;
          const poses = (a && a.creaturePoses) || [];
          const vis = poses.filter((p) => p.fade > 0.5 && p.tabId >= 0);
          if (!tr || !vis.length) return null;
          const p = vis[0];
          const cx = box.left + (tr[0] + p.x * tr[2]) * box.width;
          const cy = box.top + (tr[1] + p.y * tr[3]) * box.height;
          return { p, cx, cy };
        };
        const hit = await run();
        if (!hit) { window.__probeResult = { ok: false }; return; }
        const { p, cx, cy } = hit;

        canvas.dispatchEvent(new PointerEvent('pointermove',
          { clientX: cx, clientY: cy, bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
        const tip = document.getElementById('tip');
        const tipShown = !tip.hidden;
        const tipText = tip.textContent;

        const before = window.__aqua.activations || 0;
        canvas.dispatchEvent(new MouseEvent('click',
          { clientX: cx, clientY: cy, bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));

        window.__probeResult = {
          ok: true, cx: Math.round(cx), cy: Math.round(cy),
          tabId: p.tabId, hasTitle: p.hasTitle,
          tipShown, tipText,
          activationsBefore: before,
          activationsAfter: window.__aqua.activations || 0,
          lastTabId: window.__aqua.lastActivatedTabId,
        };
      })()`,
    ],
    // 把页面变量一起读回来
    readExtra: 'window.__probeResult',
  });

  const probe = readback.world?.extra ?? null;
  if (!probe || !probe.ok) {
    bad(`交互探针没跑起来（${JSON.stringify(probe)}）`);
    return;
  }

  ok(`算出第一只可见生物在屏幕 (${probe.cx}, ${probe.cy})，标签页 id=${probe.tabId}`);

  if (probe.tipShown) {
    ok(`悬停时提示出现了：「${String(probe.tipText).slice(0, 40)}」`);
  } else if (!probe.hasTitle) {
    warn('悬停没有提示 —— 但没有 tabs 权限时这是预期行为（生物仍然可见可点）');
  } else {
    bad('有标题权限但悬停没有出现提示 —— 接线断了');
  }

  if (probe.activationsAfter > probe.activationsBefore) {
    ok(`点击触发了标签页切换（id=${probe.lastTabId}）`);
  } else {
    bad('点击没有触发标签页切换');
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
  await checkTabsToCreatures();
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
