/**
 * 新架构的测试。
 *
 * 上一版的测试是为「世界状态是 (种子, 步数) 的纯函数」写的 ——
 * 那一整套断言（逐位一致、快进、快照往返、禁用三角函数）随着模拟一起消失了。
 *
 * 这一版要验的东西不一样，因为**没有任何累积状态**：
 *
 *   1. 身份稳定 —— 同一个标签页永远是同一只生物
 *   2. 状态映射 —— 休眠/出声/固定各自对应正确的亮度与体型
 *   3. 状态变化**不碰身份** —— 这是这一层最容易写错的地方
 *   4. 生物群的生命周期 —— 新建渐入、关闭渐出、超量按优先级筛选
 *   5. 运动是纯函数且有界
 *   6. 网格不超容量（超了会被静默截断，画面却「看起来还行」）
 *   7. GLSL 模板串里没有反引号（这个坑踩过三次）
 *
 * 用法：
 *   node tools/test.mjs
 *   node tools/test.mjs --trace
 */

import * as esbuild from 'esbuild';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const trace = process.argv.includes('--trace');

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);

function assertEq(actual, expected, label) {
  if (actual === expected) ok(label);
  else bad(`${label}\n      期望 ${expected}\n      实际 ${actual}`);
}

function assertTrue(cond, label, detail = '') {
  if (cond) ok(label);
  else bad(`${label}${detail ? `  ${detail}` : ''}`);
}

// ————————————————————————————————————————————————————————————
// 装载
// ————————————————————————————————————————————————————————————

async function loadModules() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aqua-test-'));
  await esbuild.build({
    stdin: {
      contents: `
        export * from './src/core/creatures.ts';
        export * from './src/core/tabs.ts';
        export { SHAPES, SHAPE_NAMES, buildCreatureMesh, halfHeight,
                 MAX_CREATURE_VERTICES, MAX_CREATURE_INDICES } from './src/render/creature-mesh.ts';
        export { paletteFor, THEMES, THEME_NAMES } from './src/core/theme.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: path.join(dir, 'bundle.mjs'),
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(path.join(dir, 'bundle.mjs')).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const mkTab = (over = {}) => ({
  id: 1,
  title: '标签页',
  pinned: false,
  audible: false,
  discarded: false,
  active: false,
  index: 0,
  windowId: 1,
  ...over,
});

// ————————————————————————————————————————————————————————————

function testMesh(sim) {
  section('1. 形状与网格');

  assertEq(sim.SHAPE_NAMES.length, 4, '有 4 个手写体型');

  let allOk = true;
  const detail = [];
  for (const name of sim.SHAPE_NAMES) {
    const shape = sim.SHAPES[name];
    // 剖面必须非负 —— 半高跑到负数会让网格自交
    let minH = Infinity;
    for (let i = 0; i <= 40; i++) minH = Math.min(minH, sim.halfHeight(shape, i / 40));
    const data = sim.buildCreatureMesh(shape);
    const vCount = data.vertices.length / 8;
    const iCount = data.bodyIndexCount + data.haloIndexCount;
    if (minH < 0 || vCount > sim.MAX_CREATURE_VERTICES || iCount > sim.MAX_CREATURE_INDICES) {
      allOk = false;
    }
    detail.push(`${shape.label} ${vCount}v/${iCount}i 最细处 ${minH.toFixed(3)}`);
  }
  assertTrue(allOk, '四个体型的剖面非负、网格不超容量');
  if (trace) for (const d of detail) console.log(`      ${d}`);

  // 体高不能超过体长的一半 —— 这就是上一版「一缸圆球」的成因
  const fat = [];
  for (const name of sim.SHAPE_NAMES) {
    const s = sim.SHAPES[name];
    const ratio = (s.height * 2) / s.length;
    if (ratio > 0.5) fat.push(`${s.label} ${ratio.toFixed(2)}`);
  }
  assertTrue(fat.length === 0, '没有体型胖到失真（体高 < 体长的一半）', fat.join(' '));

  // 拓扑：片元必须有一个能变化的归一化半径，否则边缘光会糊满全身。
  // 这一条是从「两行顶点导致 aEdge 恒等于 1」那个 bug 来的。
  const lantern = sim.buildCreatureMesh(sim.SHAPES.lantern);
  const edges = new Set();
  for (let i = 0; i < lantern.vertices.length; i += 8) edges.add(lantern.vertices[i + 7]);
  assertTrue(
    edges.size >= 3,
    '顶点带着多个不同的归一化半径（边缘光才可能是窄带）',
    `只有 ${edges.size} 种`,
  );
}

function testIdentity(sim) {
  section('2. 身份稳定与状态映射');

  const base = {
    id: 4242,
    tabId: 4242,
    title: '文档',
    pinned: false,
    audible: false,
    discarded: false,
    active: false,
  };
  const a = sim.makeCreature(base);
  const b = sim.makeCreature(base);
  assertEq(a.shape, b.shape, '同一 id 两次创建得到同一个体型');
  assertEq(a.homeX, b.homeX, '同一 id 两次创建得到同一个巡游中心');
  assertEq(a.w1, b.w1, '同一 id 两次创建得到同一组路径参数');

  const other = sim.makeCreature({ ...base, id: 4243, tabId: 4243 });
  assertTrue(
    a.homeX !== other.homeX || a.shape !== other.shape || a.w1 !== other.w1,
    '不同 id 得到不同的生物',
  );

  const normal = sim.makeCreature(base);
  sim.applyTabState(normal, mkTab({ id: 4242 }));
  const pinned = sim.makeCreature(base);
  sim.applyTabState(pinned, mkTab({ id: 4242, pinned: true }));
  const audible = sim.makeCreature(base);
  sim.applyTabState(audible, mkTab({ id: 4242, audible: true }));
  const discarded = sim.makeCreature(base);
  sim.applyTabState(discarded, mkTab({ id: 4242, discarded: true }));

  assertTrue(
    pinned.scale > normal.scale,
    '固定标签页体型更大',
    `${pinned.scale.toFixed(2)} > ${normal.scale.toFixed(2)}`,
  );
  assertTrue(
    audible.energy > normal.energy,
    '出声标签页更亮',
    `${audible.energy.toFixed(2)} > ${normal.energy.toFixed(2)}`,
  );
  assertTrue(
    discarded.energy < normal.energy * 0.5,
    '休眠标签页明显更暗',
    `${discarded.energy.toFixed(2)}`,
  );

  // ——— 最关键的一条：状态变化不能碰身份 ———
  const c = sim.makeCreature(base);
  const before = {
    shape: c.shape, homeX: c.homeX, homeY: c.homeY,
    w1: c.w1, w2: c.w2, w3: c.w3, p1: c.p1, speed: c.speed, alt: c.alt,
    baseScale: c.baseScale,
  };
  sim.applyTabState(c, mkTab({ id: 4242, pinned: true, audible: true, discarded: true, active: true }));
  sim.applyTabState(c, mkTab({ id: 4242 }));
  let same = true;
  for (const k of Object.keys(before)) if (c[k] !== before[k]) same = false;
  assertTrue(same, '状态反复变化之后，身份字段逐位不变（不然生物会「跳」一下）');
}

function testMotion(sim) {
  section('3. 运动');

  const c = sim.makeCreature({
    id: 77, tabId: 77, title: '', pinned: false, audible: false,
    discarded: false, active: false,
  });

  const p1 = sim.poseAt(c, 12.34, { x: 0, y: 0, dx: 0, dy: 0 });
  const p2 = sim.poseAt(c, 12.34, { x: 0, y: 0, dx: 0, dy: 0 });
  assertEq(p1.x, p2.x, '运动是纯函数（同一时刻两次求值一致）');
  assertEq(p1.y, p2.y, '运动是纯函数（纵坐标也一致）');

  const len = Math.hypot(p1.dx, p1.dy);
  assertTrue(Math.abs(len - 1) < 1e-9, '朝向是单位向量', len.toFixed(12));

  let outOfBounds = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < 4000; t += 0.37) {
    const p = sim.poseAt(c, t, { x: 0, y: 0, dx: 0, dy: 0 });
    if (p.x < -0.35 || p.x > 1.35 || p.y < -0.15 || p.y > 1.15) outOfBounds++;
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  assertEq(outOfBounds, 0, '1100 秒内位置不越界');
  assertTrue(maxY - minY > 0.03, '确实在游动（纵向有行程）', `${(maxY - minY).toFixed(3)}`);
}

function testFlock(sim) {
  section('4. 生物群');

  const flock = new sim.Flock({ maxCreatures: 5 });

  flock.sync([mkTab({ id: 1 }), mkTab({ id: 2, index: 1 })], 0.05);
  assertEq(flock.count, 2, '两个标签页 → 两只生物');
  assertTrue(flock.list.every((c) => c.fade < 1), '新生物从半透明开始（渐入）');

  for (let k = 0; k < 40; k++) flock.sync([mkTab({ id: 1 }), mkTab({ id: 2, index: 1 })], 0.05);
  assertEq(flock.list[0].fade, 1, '渐入之后不透明度封顶在 1');

  flock.sync([mkTab({ id: 1 })], 0.05);
  assertEq(flock.count, 2, '标签页关掉之后生物先留着（渐出）');
  assertTrue(flock.list.some((c) => c.tabId === 2 && c.fade < 1), '它正在变淡');
  for (let k = 0; k < 80; k++) flock.sync([mkTab({ id: 1 })], 0.05);
  assertEq(flock.count, 1, '渐出结束后被移除');
  assertEq(flock.byTabId(2), undefined, '映射表里也清掉了');

  // ——— 上限与优先级 ———
  const many = [];
  for (let i = 0; i < 12; i++) many.push(mkTab({ id: 100 + i, index: i }));
  many[9].pinned = true;
  many[10].audible = true;
  many[11].active = true;

  const capped = new sim.Flock({ maxCreatures: 5 });
  capped.sync(many, 0.05);
  assertTrue(capped.count <= 5, `数量不超过上限（${capped.count} ≤ 5）`);
  const shown = new Set(capped.list.map((c) => c.tabId));
  assertTrue(
    shown.has(109) && shown.has(110) && shown.has(111),
    '固定 / 出声 / 当前 的标签页优先留下',
    [...shown].join(','),
  );

  // ——— 状态变化时身份不变（跨同步） ———
  const f2 = new sim.Flock({ maxCreatures: 5 });
  f2.sync([mkTab({ id: 5 })], 0.05);
  const beforeShape = f2.list[0].shape;
  const beforeX = f2.list[0].homeX;
  f2.sync([mkTab({ id: 5, pinned: true, audible: true })], 0.05);
  assertEq(f2.list[0].shape, beforeShape, '同步之后体型不变');
  assertEq(f2.list[0].homeX, beforeX, '同步之后位置不变');
  assertTrue(f2.list[0].energy > 1, '同步之后亮度跟着出声状态变了');
}

function testTheme(sim) {
  section('5. 调色板');

  let darkEnough = true;
  let glowBrighter = true;
  const rows = [];
  for (const name of sim.THEME_NAMES) {
    const p = sim.paletteFor(name);
    assertTrue(!!p, `主题 ${name} 存在`);
    const deep = Math.max(...p.waterDeep);
    const glow = Math.max(...p.glow);
    const top = Math.max(...p.waterTop);
    if (deep > 0.05) darkEnough = false;
    if (glow <= top) glowBrighter = false;
    rows.push(`${name} 深${deep.toFixed(3)} 顶${top.toFixed(3)} 辉${glow.toFixed(2)}`);
  }
  assertTrue(darkEnough, '所有主题的深处都足够黑（< 0.05）—— 亮是稀缺资源');
  assertTrue(glowBrighter, '所有主题的辉光都比水体亮 —— 冷底 + 亮点这条硬规则');
  if (trace) for (const r of rows) console.log(`      ${r}`);
}

async function testShaderTemplates() {
  section('6. GLSL 模板串');

  // 这个坑踩过三次：GLSL 写在 JS 模板字面量里，注释中出现一个反引号
  // 就会把模板截断，而报错信息离现场很远。
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.ts')) files.push(full);
    }
  };
  await walk(path.join(ROOT, 'src'));

  // ⚠️ 不能用「解析出模板内容、再看里面有没有反引号」这种写法。
  //
  // 反引号一旦被注入，它**自己就把模板截断了** —— 正则匹配到的是
  // 「反引号之前的那段」，里面当然不含反引号。用解析模板的办法去检测
  // 模板里的反引号，逻辑上不可能成立。（这个 linter 第一版就是这样，
  // 注入违规之后它照样报「全部通过」。）
  //
  // 有效的判据是**奇偶性**：整个文件里反引号必须是成对的。
  // 注入一个就变成奇数，必然被抓住。
  const offenders = [];
  let blocks = 0;
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    if (!text.includes('/* glsl */')) continue;
    const ticks = (text.match(/`/g) ?? []).length;
    if (ticks % 2 !== 0) {
      offenders.push(`${path.relative(ROOT, f)} 反引号不成对（${ticks} 个）`);
    }
    blocks += (text.match(/\/\* glsl \*\//g) ?? []).length;
  }
  assertTrue(
    offenders.length === 0,
    `扫过 ${files.length} 个源文件 / ${blocks} 段 GLSL，没有反引号截断`,
    offenders.join('; '),
  );
}

async function main() {
  const { mod, cleanup } = await loadModules();
  try {
    testMesh(mod);
    testIdentity(mod);
    testMotion(mod);
    testFlock(mod);
    testTheme(mod);
    await testShaderTemplates();
  } finally {
    await cleanup();
  }

  console.log();
  if (failures === 0) {
    console.log('\x1b[32m全部通过\x1b[0m');
  } else {
    console.log(`\x1b[31m${failures} 项失败\x1b[0m`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试脚本自身出错：', err);
  process.exitCode = 1;
});
