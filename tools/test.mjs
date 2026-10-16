/**
 * P1 确定性内核测试。
 *
 * 「世界状态是 (种子, 步数) 的纯函数」这句话**只能靠算出来验证**。
 * 这个脚本把 `core/` 里跟模拟有关的部分打包成 ESM 丢给 Node 跑，
 * 不需要浏览器、不需要扩展、几毫秒出结果。
 *
 * 覆盖的断言：
 *   1. 同种子 → 逐位一致；不同种子 → 分岔
 *   2. 批量快进 === 逐帧推进（这两条路径生产里都会走）
 *   3. 快照往返后继续推进 === 一直没有中断过
 *   4. 24 小时一次性快进 === 分段快进 === 逐帧推进
 *   5. 模拟代码里没有实现相关的数学函数（静态扫描）
 *   6. 生态确实活着（有界、不灭绝、会涨落）
 *
 * 用法：
 *   node tools/test.mjs            # 跑断言
 *   node tools/test.mjs --trace    # 附带打印 7 天的生态轨迹
 */

import * as esbuild from 'esbuild';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const trace = process.argv.includes('--trace');
// 天数可调：调生态参数时要看多个周期，7 天不够
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : 7;

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

/** 把 core 里跟模拟有关的部分打包成 ESM，交给 Node 直接跑。 */
async function loadSim() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export * from './src/core/world.ts';
        export * from './src/core/clock.ts';
        export * from './src/core/fixed.ts';
        export * from './src/core/flora.ts';
        export * from './src/core/genome.ts';
        export * from './src/core/school.ts';
        export * from './src/core/wave.ts';
        export * from './src/core/actions.ts';
        export * from './src/core/share.ts';
        export * from './src/core/adaptive.ts';
        export * from './src/core/rng.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'warning',
  });

  const dir = await mkdtemp(path.join(tmpdir(), 'aqua-test-'));
  const file = path.join(dir, 'sim.mjs');
  await writeFile(file, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const SEED = 'reef-7f3a91c2';
const T0 = 1_700_000_000_000; // 固定的纪元，测试里不能用 Date.now()

// ————————————————————————————————————————————————————————————

/** 1. 同种子一致、不同种子分岔 */
function testDeterminism(sim) {
  section('1. 确定性与种子');

  const a = sim.createWorld(SEED, T0);
  const b = sim.createWorld(SEED, T0);

  sim.advanceWorld(a, 30 * 60 * 60); // 6 小时
  sim.advanceWorld(b, 30 * 60 * 60);

  assertEq(sim.worldFingerprint(a), sim.worldFingerprint(b), '同种子推进 6 小时后逐位一致');
  assertEq(sim.worldHash(a), sim.worldHash(b), 'worldHash 一致');

  const c = sim.createWorld('kelp-00000001', T0);
  sim.advanceWorld(c, 30 * 60 * 60);
  assertTrue(
    sim.worldFingerprint(a) !== sim.worldFingerprint(c),
    '不同种子得到不同的世界（模拟不是常函数）',
  );
}

/** 2. 批量快进与逐帧推进必须一致 */
function testBulkVsIncremental(sim) {
  section('2. 批量快进 === 逐帧推进');

  const start = sim.createWorld(SEED, T0);
  sim.advanceWorld(start, 30 * 3600); // 先跑 1 小时，让状态离开初值

  const ticks = 30 * 60 * 90; // 90 分钟

  const bulk = sim.cloneWorld(start);
  sim.advanceWorld(bulk, start.tick + ticks);

  const slow = sim.cloneWorld(start);
  for (let t = start.tick + 1; t <= start.tick + ticks; t++) sim.stepWorld(slow, t);

  assertEq(sim.worldFingerprint(bulk), sim.worldFingerprint(slow), `跨 ${ticks} 步两条路径一致`);

  // 边界：正好落在环境步进的整点上
  const aligned = sim.createWorld(SEED, T0);
  const envTicks = sim.ENV_INTERVAL_TICKS;
  const bulkAligned = sim.cloneWorld(aligned);
  sim.advanceWorld(bulkAligned, envTicks * 5);
  const slowAligned = sim.cloneWorld(aligned);
  for (let t = 1; t <= envTicks * 5; t++) sim.stepWorld(slowAligned, t);
  assertEq(
    sim.worldFingerprint(bulkAligned),
    sim.worldFingerprint(slowAligned),
    '恰好停在环境步进整点上时也一致',
  );

  // 边界：零步与倒退都不该改变世界
  const noop = sim.cloneWorld(start);
  sim.advanceWorld(noop, start.tick);
  assertEq(sim.worldFingerprint(noop), sim.worldFingerprint(start), '推进到当前步号是无操作');
  sim.advanceWorld(noop, start.tick - 1000);
  assertEq(sim.worldFingerprint(noop), sim.worldFingerprint(start), '倒退步号是无操作');
}

/** 3. 快照往返（序列化 → 校验 → 恢复 → 继续） */
function testSnapshotRoundTrip(sim) {
  section('3. 快照往返');

  const direct = sim.createWorld(SEED, T0);

  // 中途「存盘」再「读盘」
  sim.advanceWorld(direct, 30 * 3600 * 2);
  const serialized = JSON.parse(JSON.stringify(direct));
  const restoredRaw = sim.sanitizeWorld(serialized);
  assertTrue(restoredRaw !== null, 'sanitizeWorld 接受自己序列化出来的状态');
  const restored = restoredRaw;

  // 一条路继续跑，另一条路从快照继续跑
  sim.advanceWorld(direct, 30 * 3600 * 4);
  sim.advanceWorld(restored, 30 * 3600 * 4);

  assertEq(
    sim.worldFingerprint(direct),
    sim.worldFingerprint(restored),
    '快照往返后继续推进的结果与不中断完全一致',
  );

  // 坏数据必须被拒绝，而不是污染模拟
  assertEq(sim.sanitizeWorld(null), null, '拒绝 null');
  assertEq(sim.sanitizeWorld({}), null, '拒绝空对象');
  assertEq(sim.sanitizeWorld({ ...serialized, version: 999 }), null, '拒绝版本不匹配');
  assertEq(sim.sanitizeWorld({ ...serialized, algae: NaN }), null, '拒绝 NaN');
  assertEq(sim.sanitizeWorld({ ...serialized, seed: '' }), null, '拒绝空种子');
}

/** 4. 24 小时快进：一次性 vs 分段 vs 逐帧 */
function testFastForward(sim) {
  section('4. 24 小时快进');

  const oneDayMs = 24 * 3600 * 1000;
  const manyTicks = Math.floor(oneDayMs / sim.SIM_DT_MS);

  const oneShot = sim.createWorld(SEED, T0);
  sim.advanceWorld(oneShot, manyTicks);

  const stepped = sim.createWorld(SEED, T0);
  for (let t = 1; t <= manyTicks; t++) sim.stepWorld(stepped, t);

  assertEq(sim.worldFingerprint(oneShot), sim.worldFingerprint(stepped), '一次性快进 24h === 逐帧推进 24h');

  // 分段（模拟标签页开开合合）
  const chunked = sim.createWorld(SEED, T0);
  const chunk = 30 * 60 * 17; // 17 分钟一段，故意不是 60 的整数倍
  for (let t = chunk; t < manyTicks; t += chunk) sim.advanceWorld(chunked, t);
  sim.advanceWorld(chunked, manyTicks);
  assertEq(sim.worldFingerprint(oneShot), sim.worldFingerprint(chunked), '分段快进 24h === 一次性快进');

  // advanceWorldTo：纪元对齐的版本
  const viaRealTime = sim.createWorld(SEED, T0);
  sim.advanceWorldTo(viaRealTime, T0 + oneDayMs, oneDayMs * 2);
  assertEq(
    sim.worldFingerprint(viaRealTime),
    sim.worldFingerprint(oneShot),
    '按真实时间推进 24h === 按步数推进',
  );
}

/** 5. 模拟代码里不能出现实现相关的数学函数 */
async function testNoTranscendentals() {
  section('5. 静态扫描：模拟代码只用可复现的运算');

  // ECMAScript 规范说这些是 implementation-approximated，
  // 不同引擎版本可能给出不同的最后一位 —— 模拟里一个都不能有。
  const FORBIDDEN = [
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'exp', 'expm1', 'log', 'log1p', 'log2', 'log10',
    'pow', 'hypot', 'cbrt', 'sinh', 'cosh', 'tanh', 'random',
  ];

  const files = [
    'src/core/world.ts',
    'src/core/clock.ts',
    'src/core/fixed.ts',
    'src/core/flora.ts',
    'src/core/genome.ts',
    'src/core/school.ts',
    'src/core/wave.ts',
  ];
  const found = [];

  for (const rel of files) {
    const text = await readFile(path.join(ROOT, rel), 'utf8');
    // 去掉注释再扫，否则注释里提到函数名会误报
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const fn of FORBIDDEN) {
      const re = new RegExp(`Math\\s*\\.\\s*${fn}\\b`);
      if (re.test(stripped)) found.push(`${rel}: Math.${fn}`);
    }
  }

  if (found.length === 0) {
    ok(`${files.length} 个模拟文件里没有实现相关的数学函数`);
  } else {
    for (const f of found) bad(`模拟里出现了不可复现的运算：${f}`);
  }

  // 反过来确认扫描本身有效 —— 拿一个确实含 Math.sin 的文件试
  const negativeControl = 'const x = Math.sin(1) + Math.cos(2);';
  const hit = FORBIDDEN.some((fn) => new RegExp(`Math\\s*\\.\\s*${fn}\\b`).test(negativeControl));
  assertTrue(hit, '扫描逻辑本身有效（对含 Math.sin 的样本能报出来）');
}

/** 6. 生态确实活着 */
function testEcologyAlive(sim) {
  section('6. 生态的动态');

  const world = sim.createWorld(SEED, T0);
  const days = DAYS;
  const ticks = Math.floor((days * 24 * 3600 * 1000) / sim.SIM_DT_MS);

  let minAlgae = Infinity;
  let maxAlgae = -Infinity;
  let minNut = Infinity;
  let maxNut = -Infinity;
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  let nan = false;

  const rows = [];
  const sampleEvery = Math.floor(ticks / (days * (days > 14 ? 2 : 8)));

  for (let t = 1; t <= ticks; t++) {
    sim.stepWorld(world, t);
    const v = sim.envView(world);

    if (!Number.isFinite(v.algae) || !Number.isFinite(v.nutrients) || !Number.isFinite(v.temperatureC)) {
      nan = true;
      break;
    }
    if (v.algae < minAlgae) minAlgae = v.algae;
    if (v.algae > maxAlgae) maxAlgae = v.algae;
    if (v.nutrients < minNut) minNut = v.nutrients;
    if (v.nutrients > maxNut) maxNut = v.nutrients;
    if (v.temperatureC < minTemp) minTemp = v.temperatureC;
    if (v.temperatureC > maxTemp) maxTemp = v.temperatureC;

    if (t % sampleEvery === 0) rows.push(v);
  }

  assertTrue(!nan, `${days} 天里没有出现 NaN / Infinity`);

  assertTrue(
    maxAlgae > 0.02 && minAlgae < maxAlgae,
    '藻类有生长（不是一条平线）',
    `范围 ${minAlgae.toFixed(4)} … ${maxAlgae.toFixed(4)}`,
  );

  // 新缸综合征：开缸的头一天会爆一次藻，然后自稳。
  // 这是真实鱼缸的行为，不是巧合 —— 初值里有少量藻、营养充足、没有竞争者，
  // 于是先冲高；等营养被抽干，增长与死亡达到平衡。
  // 戏剧性的藻华/崩溃需要**外部扰动源**（投食、鱼、事件），那是 P4 的活。
  const end = sim.envView(world);
  assertTrue(
    end.algae > 0.02 && end.algae < 0.92,
    '长期收敛到一个不退化也不饱和的平衡',
    `终态藻类 ${end.algae.toFixed(4)}，无机盐 ${end.nutrients.toFixed(4)} mg/L`,
  );
  assertTrue(
    end.nutrients > 0.002,
    '平衡态下无机盐没有被彻底抽干（没有发生数值灭绝）',
    `${end.nutrients.toFixed(4)} mg/L`,
  );
  assertTrue(
    end.detritus < 0.999,
    '碎屑没有顶到上限（矿化与沉降是平衡的）',
    `${end.detritus.toFixed(4)}`,
  );
  assertTrue(
    maxNut > 0.02 && maxNut < 20,
    '无机盐保持有界',
    `范围 ${minNut.toFixed(3)} … ${maxNut.toFixed(3)} mg/L`,
  );
  assertTrue(
    minTemp > 15 && maxTemp < 35,
    '水温落在合理区间',
    `${minTemp.toFixed(2)} … ${maxTemp.toFixed(2)} °C`,
  );
  assertTrue(
    maxTemp - minTemp > 0.15,
    '水温随光照有可观察的日变化（热惯性没有大到抹平昼夜）',
    `振幅 ${(maxTemp - minTemp).toFixed(3)} °C`,
  );

  if (trace) {
    console.log('\n  世界时间  光照   水温    无机盐   藻类     碎屑     溶氧');
    for (const v of rows) {
      console.log(
        `  ${String(v.clock).padStart(5)}     ` +
          `${v.light.toFixed(3)}  ${v.temperatureC.toFixed(2)}°C  ` +
          `${v.nutrients.toFixed(3)}   ${v.algae.toFixed(4)}   ` +
          `${v.detritus.toFixed(4)}   ${v.oxygen.toFixed(3)}`,
      );
    }
    console.log(
      `\n  （后段数值几乎不动是正常的：资源-消费者系统收敛到了稳定平衡。）\n` +
        `   开缸第一天会先爆一次藻 —— 这就是真实鱼缸的「新缸综合征」。`,
    );
  }
}

/**
 * 7a. 整数开方。
 *
 * 单独测它，因为它是那种「错了也不会报错、只会让结果时好时坏」的函数。
 * 第一版用位运算求初值，在参数超过 2^31 时被静默截断 ——
 * 症状是有的珊瑚长到 60 个节点、有的一根都不长。这种 bug
 * 必须由针对性的单元测试来抓，靠端到端的形态检查是碰运气。
 */
function testIsqrt(sim) {
  section('7a. 整数开方');

  const cases = [
    [0, 0], [1, 1], [2, 1], [3, 1], [4, 2], [8, 2], [9, 3],
    [15, 3], [16, 4], [1e6, 1000], [1e8, 10000],
    // 这几个是关键：参数超过 2^31，位运算版本正是在这里崩的
    [2147483647, 46340], [2147483648, 46340], [4e9, 63245],
    [1e12, 1000000], [999999999999, 999999],
  ];

  let bad = 0;
  for (const [n, want] of cases) {
    const got = sim.isqrt(n);
    if (got !== want) {
      bad++;
      bad_detail(`${n} → ${got}（应为 ${want}）`);
    }
  }
  function bad_detail(msg) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m isqrt 错误：${msg}`);
  }
  assertTrue(bad === 0, `${cases.length} 个已知值全部正确（含超过 2^31 的大输入）`);

  // 性质检查：x² ≤ n < (x+1)²
  let propertyOk = true;
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(Math.random() * 1e12);
    const x = sim.isqrt(n);
    if (!(x * x <= n && (x + 1) * (x + 1) > n)) propertyOk = false;
  }
  assertTrue(propertyOk, '500 个随机输入都满足 x² ≤ n < (x+1)²');
}

/** 7. 植物景观生成 */
function testFlora(sim) {
  section('7. 植物景观生成');

  const a = sim.generateFlora(SEED);
  const b = sim.generateFlora(SEED);
  assertEq(a.fingerprint, b.fingerprint, '同种子生成完全相同的植物骨架');

  const c = sim.generateFlora('kelp-00000001');
  assertTrue(a.fingerprint !== c.fingerprint, '不同种子得到不同的植物');

  // 子流隔离：改一个种子只该影响一整套，且各子流独立
  const stats = sim.floraStats(a);
  assertTrue(stats.plants > 0 && stats.nodes > 0, `生成了 ${stats.plants} 株 / ${stats.nodes} 个节点`);
  assertTrue(
    (stats.byKind.coral ?? 0) > 0 && (stats.byKind.grass ?? 0) > 0 && (stats.byKind.kelp ?? 0) > 0,
    '三种植物都有',
    JSON.stringify(stats.byKind),
  );

  // 空间殖民的标志：珊瑚必须**分叉**，否则就是一根直棍
  let branched = 0;
  let maxNodes = 0;
  for (const plant of a.plants) {
    if (plant.kind !== 'coral') continue;
    const children = new Map();
    for (const n of plant.nodes) {
      if (n.parent >= 0) children.set(n.parent, (children.get(n.parent) ?? 0) + 1);
    }
    let forks = 0;
    for (const count of children.values()) if (count >= 2) forks++;
    if (forks >= 2) branched++;
    if (plant.nodes.length > maxNodes) maxNodes = plant.nodes.length;
  }
  assertTrue(branched >= 1, `有 ${branched} 株珊瑚产生了分叉（不是直棍）`);

  // 每一株都必须真的长起来。这条断言就是为 isqrt 那个 bug 加的：
  // 它当时的表现正是「有的长得很好，有的一个节点都不长」。
  const stunted = a.plants.filter((p) => p.kind === 'coral' && p.nodes.length < 12);
  assertTrue(
    stunted.length === 0,
    '每一株珊瑚都真的长起来了（没有停滞的）',
    stunted.length ? `停滞：${stunted.map((p) => p.nodes.length).join(', ')} 个节点` : '',
  );

  // 节点必须落在缸内，而且根要贴着砂线
  let outOfBounds = 0;
  let worstRoot = 0;
  for (const plant of a.plants) {
    const root = plant.nodes[0];
    const sand = sim.substrateHeightAt(sim.unfx(root.x), sim.hashString(SEED) % 100000);
    worstRoot = Math.max(worstRoot, Math.abs(sim.unfx(root.y) - sand));
    for (const n of plant.nodes) {
      const x = sim.unfx(n.x);
      const y = sim.unfx(n.y);
      if (x < -0.01 || x > 1.01 || y < -0.01 || y > 1.01) outOfBounds++;
    }
  }
  assertTrue(outOfBounds === 0, '所有节点都在缸内', `越界 ${outOfBounds} 个`);
  assertTrue(worstRoot < 0.05, '根都长在砂线附近', `最差偏离 ${worstRoot.toFixed(4)}`);

  // 生长顺序必须单调，否则开场动画会闪烁
  let orderOk = true;
  for (const plant of a.plants) {
    for (let i = 1; i < plant.nodes.length; i++) {
      if (plant.nodes[i].order < plant.nodes[i - 1].order) orderOk = false;
    }
  }
  assertTrue(orderOk, '生长顺序随节点索引单调不减（开场动画不会闪回）');

  if (trace) {
    console.log(`\n  植物骨架：${stats.plants} 株 / ${stats.nodes} 节点`);
    for (const plant of a.plants.slice(0, 14)) {
      const xs = plant.nodes.map((n) => sim.unfx(n.x));
      const ys = plant.nodes.map((n) => sim.unfx(n.y));
      console.log(
        `    ${plant.kind.padEnd(6)} ${String(plant.nodes.length).padStart(3)} 节点  ` +
          `x ${Math.min(...xs).toFixed(3)}…${Math.max(...xs).toFixed(3)}  ` +
          `y ${Math.min(...ys).toFixed(3)}…${Math.max(...ys).toFixed(3)}`,
      );
    }
    console.log(`    最长一株珊瑚：${maxNodes} 节点`);
  }
}

/** 8. 鱼类基因组 */
function testGenome(sim) {
  section('8. 鱼类基因组');

  const a = sim.generateGenomePool(SEED, 8);
  const b = sim.generateGenomePool(SEED, 8);
  assertEq(a.length, 8, '生成了 8 个基因组');
  assertEq(
    a.map(sim.genomeFingerprint).join('#'),
    b.map(sim.genomeFingerprint).join('#'),
    '同种子生成完全相同的基因组池',
  );

  const c = sim.generateGenomePool('kelp-00000001', 8);
  assertTrue(
    a.map(sim.genomeFingerprint).join('#') !== c.map(sim.genomeFingerprint).join('#'),
    '不同种子得到不同的鱼',
  );

  // 个体之间必须真的不同，否则「一池鱼」就是复制品
  const unique = new Set(a.map(sim.genomeFingerprint));
  assertEq(unique.size, a.length, '池内 8 条鱼互不相同');

  // 取值落在合理范围
  let bad = [];
  for (const g of a) {
    const m = g.morphology;
    const b2 = g.behavior;
    if (m.spineSegments < 8 || m.spineSegments > 18) bad.push(`spineSegments=${m.spineSegments}`);
    if (m.length <= 0 || m.length > sim.FX) bad.push(`length=${m.length}`);
    if (m.heightFront <= 0 || m.heightFront > sim.FX) bad.push(`heightFront=${m.heightFront}`);
    if (m.heightFront <= m.heightBack) bad.push('体高没有向尾部收细');
    if (b2.cruiseSpeed <= 0) bad.push('cruiseSpeed <= 0');
  }
  assertTrue(bad.length === 0, '所有形态参数都在合理范围内', bad.slice(0, 3).join('; '));

  // 高长比应该真的做出胖瘦差别，而不是挤在一个值附近
  const aspects = a.map((g) => sim.unfx(g.morphology.heightFront) / sim.unfx(g.morphology.length));
  const spread = Math.max(...aspects) - Math.min(...aspects);
  assertTrue(spread > 0.06, `体型有明显胖瘦差异`, `高长比跨度 ${spread.toFixed(3)}`);

  // 子流隔离：加一条鱼不应该改动已存在的鱼
  const nine = sim.generateGenomePool(SEED, 9);
  assertEq(
    nine.slice(0, 8).map(sim.genomeFingerprint).join('#'),
    a.map(sim.genomeFingerprint).join('#'),
    '把池子从 8 条扩到 9 条，前 8 条纹丝不动（命名子流隔离）',
  );

  // ——— 育种算子（P5 会用到，P3 先测好）———
  const rng = sim.Rng.fromSeed('breed-test');
  const child = sim.crossover(a[0], a[1], rng, 100);
  assertEq(child.parents.join(','), `${a[0].id},${a[1].id}`, '交叉记录了父母');
  assertEq(child.generation, Math.max(a[0].generation, a[1].generation) + 1, '世代数递增');
  // 后代必须落在父母之间（大体上），而不是跑到别处去
  const lo = Math.min(a[0].morphology.length, a[1].morphology.length);
  const hi = Math.max(a[0].morphology.length, a[1].morphology.length);
  assertTrue(
    child.morphology.length >= lo && child.morphology.length <= hi,
    '后代的体长落在父母之间（是混合而不是乱跳）',
    `${child.morphology.length} ∈ [${lo}, ${hi}]`,
  );

  const mutated = sim.mutate(a[0], sim.Rng.fromSeed('mutate-test'), 1.0);
  assertTrue(
    sim.genomeFingerprint(mutated) !== sim.genomeFingerprint(a[0]),
    '变异确实改变了基因组',
  );
  assertTrue(
    mutated.morphology.spineSegments >= 8 && mutated.morphology.spineSegments <= 18,
    '变异后结构基因仍在合法范围内',
  );

  if (trace) {
    console.log('\n  序号  段数  体长    高长比  巡游速度  胆量  合群  食性');
    for (const g of a) {
      const m = g.morphology;
      const b2 = g.behavior;
      console.log(
        `   ${String(g.id).padStart(2)}   ${String(m.spineSegments).padStart(3)}  ` +
          `${sim.unfx(m.length).toFixed(3)}  ` +
          `${(sim.unfx(m.heightFront) / sim.unfx(m.length)).toFixed(3)}   ` +
          `${sim.unfx(b2.cruiseSpeed).toFixed(4)}   ` +
          `${sim.unfx(b2.boldness).toFixed(2)}  ${sim.unfx(b2.sociability).toFixed(2)}  ` +
          `${sim.unfx(b2.diet).toFixed(2)}`,
      );
    }
  }
}

/** 9. 鱼群运动 */
function testSchool(sim) {
  section('9. 鱼群运动');

  const genomes = sim.generateGenomePool(SEED, 6);
  const seeds = sim.generateSchool(SEED, genomes, 18);
  assertEq(seeds.length, 18, '生成了 18 条鱼');

  const p1 = sim.allocatePose(18);
  const p2 = sim.allocatePose(18);

  // 纯函数：同一时刻求值两次必须完全一致
  sim.computeSchool(seeds, genomes, 12.5, p1);
  sim.computeSchool(seeds, genomes, 12.5, p2);
  assertEq(sim.poseFingerprint(p1), sim.poseFingerprint(p2), '同一时刻求值两次结果完全一致');

  // **关键性质**：可以直接跳到任意时刻求值，不需要从头推进。
  // 这正是它取代积分的原因 —— 快进一天和快进一秒一样便宜。
  const pJump = sim.allocatePose(18);
  sim.computeSchool(seeds, genomes, 86400, pJump);
  const pJump2 = sim.allocatePose(18);
  sim.computeSchool(seeds, genomes, 86400, pJump2);
  assertEq(sim.poseFingerprint(pJump), sim.poseFingerprint(pJump2), '跳到 24 小时后求值依然一致');

  // 边界
  let outOfBounds = 0;
  const pb = sim.allocatePose(18);
  for (let t = 0; t < 600; t += 7) {
    sim.computeSchool(seeds, genomes, t, pb);
    for (let i = 0; i < 18; i++) {
      const x = pb.pos[i * 2];
      const y = pb.pos[i * 2 + 1];
      if (
        x < sim.SWIM_BOUNDS.minX - 1e-6 || x > sim.SWIM_BOUNDS.maxX + 1e-6 ||
        y < sim.SWIM_BOUNDS.minY - 1e-6 || y > sim.SWIM_BOUNDS.maxY + 1e-6
      ) outOfBounds++;
    }
  }
  assertTrue(outOfBounds === 0, '600 秒里没有鱼游出活动范围', `越界 ${outOfBounds} 次`);

  // 分离：统计任意时刻的最小间距
  let worstGap = Infinity;
  for (let t = 0; t < 300; t += 3) {
    sim.computeSchool(seeds, genomes, t, pb);
    for (let i = 0; i < 18; i++) {
      for (let j = i + 1; j < 18; j++) {
        const dx = pb.pos[j * 2] - pb.pos[i * 2];
        const dy = pb.pos[j * 2 + 1] - pb.pos[i * 2 + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < worstGap) worstGap = d;
      }
    }
  }
  assertTrue(
    worstGap > 0.012,
    '分离松弛有效：没有鱼叠在一起',
    `最小间距 ${worstGap.toFixed(4)}（分离半径 ${0.052}）`,
  );

  // 运动连续性：小步长下位置不会跳变
  let maxStep = 0;
  sim.computeSchool(seeds, genomes, 50, p1);
  sim.computeSchool(seeds, genomes, 50 + 1 / 30, p2);
  for (let i = 0; i < 18; i++) {
    const dx = p2.pos[i * 2] - p1.pos[i * 2];
    const dy = p2.pos[i * 2 + 1] - p1.pos[i * 2 + 1];
    maxStep = Math.max(maxStep, Math.sqrt(dx * dx + dy * dy));
  }
  assertTrue(maxStep < 0.01, '单帧位移很小（运动是连续的）', `最大 ${maxStep.toFixed(5)}`);

  // 朝向必须是单位向量
  let badDir = 0;
  for (let i = 0; i < 18; i++) {
    const dx = p1.dir[i * 2];
    const dy = p1.dir[i * 2 + 1];
    if (Math.abs(Math.sqrt(dx * dx + dy * dy) - 1) > 0.02) badDir++;
  }
  assertTrue(badDir === 0, '所有朝向都是单位向量', `异常 ${badDir} 条`);

  // 鱼确实在动，不是杵在原地
  const spread = (() => {
    let d = 0;
    for (let i = 0; i < 18; i++) {
      d = Math.max(d, Math.abs(pJump.pos[i * 2] - p1.pos[i * 2]));
    }
    return d;
  })();
  assertTrue(spread > 0.01, '24 小时后的位置确实变了（不是静止的）', `最大位移 ${spread.toFixed(3)}`);

  if (trace) {
    console.log(`\n  18 条鱼，最小间距 ${worstGap.toFixed(4)}，单帧最大位移 ${maxStep.toFixed(5)}`);
    sim.computeSchool(seeds, genomes, 0, p1);
    console.log('  初始位置：');
    for (let i = 0; i < 6; i++) {
      console.log(
        `    #${i}  (${p1.pos[i * 2].toFixed(3)}, ${p1.pos[i * 2 + 1].toFixed(3)})  ` +
          `朝向 (${p1.dir[i * 2].toFixed(2)}, ${p1.dir[i * 2 + 1].toFixed(2)})  ` +
          `基因组 #${seeds[i].genome}`,
      );
    }
  }
}

/** 10. 生态循环（P4） */
function testEcologyCycle(sim) {
  section('10. 生态循环');

  const dayTicks = Math.floor((24 * 3600 * 1000) / sim.SIM_DT_MS);

  // ——— 确定性：带着鱼的世界依然逐位可复现 ———
  const w1 = sim.createWorld(SEED, T0);
  const w2 = sim.createWorld(SEED, T0);
  sim.advanceWorld(w1, dayTicks * 3);
  sim.advanceWorld(w2, dayTicks * 3);
  assertEq(sim.worldFingerprint(w1), sim.worldFingerprint(w2), '3 天后两个同种子的世界逐位一致（含鱼群）');

  // 批量与逐帧两条路径在有了生态之后仍然必须一致
  const base = sim.createWorld(SEED, T0);
  sim.advanceWorld(base, dayTicks);
  const bulk = sim.cloneWorld(base);
  sim.advanceWorld(bulk, base.tick + 30 * 60 * 200);
  const slow = sim.cloneWorld(base);
  for (let t = base.tick + 1; t <= base.tick + 30 * 60 * 200; t++) sim.stepWorld(slow, t);
  assertEq(
    sim.worldFingerprint(bulk),
    sim.worldFingerprint(slow),
    '有了鱼之后，批量快进与逐帧推进依然一致',
  );

  // ——— 长期动态 ———
  const world = sim.createWorld(SEED, T0);
  const days = 21;
  const ticks = dayTicks * days;

  let minPop = Infinity, maxPop = -Infinity;
  let minAlgae = Infinity, maxAlgae = -Infinity;
  let minNut = Infinity, maxNut = -Infinity;
  let nan = false;
  const rows = [];

  const sampleEvery = Math.floor(ticks / days);
  for (let t = 1; t <= ticks; t++) {
    sim.stepWorld(world, t);
    if (t % sampleEvery === 0) {
      const v = sim.envView(world);
      if (!Number.isFinite(v.population) || !Number.isFinite(v.algae) || !Number.isFinite(v.nutrients)) {
        nan = true;
        break;
      }
      rows.push({ day: Math.round(t / dayTicks), ...v });
    }
  }

  // 再采一遍极值（采样点可能刚好错过峰值）
  const probe = sim.createWorld(SEED, T0);
  for (let d = 0; d < days * 8; d++) {
    sim.advanceWorld(probe, probe.tick + Math.floor(dayTicks / 8));
    const v = sim.envView(probe);
    minPop = Math.min(minPop, v.population);
    maxPop = Math.max(maxPop, v.population);
    minAlgae = Math.min(minAlgae, v.algae);
    maxAlgae = Math.max(maxAlgae, v.algae);
    minNut = Math.min(minNut, v.nutrients);
    maxNut = Math.max(maxNut, v.nutrients);
  }

  assertTrue(!nan, `${days} 天里没有出现 NaN / Infinity`);

  const end = sim.envView(world);
  assertTrue(
    end.population > 0,
    '种群没有灭绝',
    `终态 ${end.population} 条，累计出生 ${end.births} 死亡 ${end.deaths}`,
  );
  assertTrue(
    maxPop < 34,
    '种群没有顶到承载上限（说明是饿死/老死调节的，不是硬截断）',
    `峰值 ${maxPop}`,
  );
  assertTrue(
    end.births > 0,
    '确实发生了繁殖',
    `累计出生 ${end.births}`,
  );
  assertTrue(
    end.deaths > 0,
    '确实发生了死亡',
    `累计死亡 ${end.deaths}`,
  );
  assertTrue(
    end.genePool > 5,
    '基因池随繁殖增长（新基因组被创造出来了）',
    `池大小 ${end.genePool}`,
  );

  // 藻类避难所：无论鱼怎么吃，藻类都不该归零
  assertTrue(
    minAlgae > 0.004,
    '藻类没有被吃绝（避难所生效）',
    `最低 ${minAlgae.toFixed(4)}`,
  );
  // 藻类会被鱼**调节**到一个稳定的共存平衡点，而不是自发振荡。
  //
  // 这是 Holling II 型功能反应 + 避难所共同决定的：搜寻时间项和避难所
  // 都是**稳定化**的。真实鱼缸也是这样 —— 成熟之后会稳下来，
  // 真正的藻华需要**外部扰动**（过量投食、改变光照、换水），
  // 而那正是玩家在 P5 里扮演的角色（DESIGN §5.3）。
  //
  // 所以这里检验的是「有界且没有灭绝」，而不是硬求一个振荡。
  // 硬求振荡会诱导我去调参数迎合测试，而不是把模型做对。
  assertTrue(
    minAlgae >= 0.02 && maxAlgae < 0.9,
    '藻类被维持在避难所与饱和之间的一个窄带里',
    `${minAlgae.toFixed(4)} … ${maxAlgae.toFixed(4)}`,
  );

  // ——— 捕食耦合：有鱼 vs 无鱼 ———
  //
  // 这一条检验的是**耦合是否真的存在**。一个「鱼和藻类各跑各的」的实现
  // 照样能通过上面所有断言，但它是假的生态系统。
  //
  // 用「有鱼 vs 无鱼」的对照，而不是「移除鱼之后看藻类涨不涨」：
  // 这个生态系统有韧性，移除一半的鱼之后种群会在几小时内靠繁殖补回来，
  // 释放的瞬态比我采样的间隔还短。对照实验不受这个影响，也更决定性。
  const withFish = sim.createWorld(SEED, T0);
  const withoutFish = sim.createWorld(SEED, T0);
  withoutFish.fish = [];
  sim.advanceWorld(withFish, dayTicks * 8);
  sim.advanceWorld(withoutFish, dayTicks * 8);

  const aWith = sim.envView(withFish).algae;
  const aWithout = sim.envView(withoutFish).algae;
  assertTrue(
    aWithout > aWith * 2.5,
    '有鱼与无鱼的藻类水平差出数倍（捕食耦合成立）',
    `有鱼 ${aWith.toFixed(4)} vs 无鱼 ${aWithout.toFixed(4)}`,
  );
  assertTrue(
    sim.envView(withFish).population > 0 && withFish.genomes.length > 5,
    '有鱼的世界规模更大（鱼在吃、在繁殖、基因池在增长）',
    `${sim.envView(withFish).population} 条 / ${withFish.genomes.length} 个基因组`,
  );

  assertTrue(maxNut < 20 && minNut >= 0, '无机盐有界', `${minNut.toFixed(3)} … ${maxNut.toFixed(3)}`);

  if (trace) {
    console.log('\n  天  种群  尸体  均能  基因池  出生  死亡   藻类    无机盐');
    for (const r of rows) {
      console.log(
        `  ${String(r.day).padStart(2)}  ${String(r.population).padStart(4)}  ` +
          `${String(r.corpses).padStart(4)}  ${r.meanEnergy.toFixed(2)}  ` +
          `${String(r.genePool).padStart(6)}  ${String(r.births).padStart(4)}  ` +
          `${String(r.deaths).padStart(4)}   ${r.algae.toFixed(4)}  ${r.nutrients.toFixed(3)}`,
      );
    }
  }
}

/** 11. 玩家交互与育种（P5） */
function testInteraction(sim) {
  section('11. 玩家交互与育种');

  const hour = 3600 * 1000;
  const envStep = sim.ENV_INTERVAL_TICKS * sim.SIM_DT_MS;

  // ——— 投食确实改变了世界 ———
  const fed = sim.createWorld(SEED, T0);
  const unfed = sim.createWorld(SEED, T0);
  const tickAt = (h) => Math.floor((h * hour) / sim.SIM_DT_MS);

  sim.advanceWorld(fed, tickAt(1));
  sim.advanceWorld(unfed, tickAt(1));
  const before = sim.envView(fed).nutrients;

  // ⚠️ 动作的时刻必须落在**推进窗口之内**，否则它根本不会被应用。
  // 第一版把时刻写在了窗口之外，测出来「投食没有效果」——
  // 那是测试写错了，不是代码坏了。
  const action = {
    seq: 1,
    atMs: T0 + 1.2 * hour,
    kind: 'feed',
    x: 300000,
    y: 400000,
    amount: sim.fx(3.0),
  };
  sim.advanceWorld(fed, tickAt(3), [action]);
  sim.advanceWorld(unfed, tickAt(3), []);

  const fedNut = sim.envView(fed).nutrients;
  const unfedNut = sim.envView(unfed).nutrients;
  assertTrue(
    fedNut > unfedNut,
    '投食确实抬高了无机盐（外源能量注入了系统）',
    `投食 ${fedNut.toFixed(3)} vs 不投 ${unfedNut.toFixed(3)}（投食前 ${before.toFixed(3)}）`,
  );
  assertTrue(
    sim.worldFingerprint(fed) !== sim.worldFingerprint(unfed),
    '投食与不投食得到不同的世界',
  );

  // ——— 重放的确定性 ———
  const r1 = sim.createWorld(SEED, T0);
  const r2 = sim.createWorld(SEED, T0);
  sim.advanceWorld(r1, 30 * 60 * 60);
  sim.advanceWorld(r2, 30 * 60 * 60);
  const journal = [
    { seq: 1, atMs: T0 + 1.1 * hour, kind: 'feed', x: 300000, y: 400000, amount: sim.fx(0.55) },
    { seq: 2, atMs: T0 + 1.4 * hour, kind: 'feed', x: 700000, y: 300000, amount: sim.fx(0.55) },
    { seq: 3, atMs: T0 + 2.2 * hour, kind: 'feed', x: 500000, y: 500000, amount: sim.fx(0.55) },
  ];
  sim.advanceWorld(r1, r1.tick + Math.floor(3 * hour / sim.SIM_DT_MS), journal);
  sim.advanceWorld(r2, r2.tick + Math.floor(3 * hour / sim.SIM_DT_MS), journal);
  assertEq(sim.worldFingerprint(r1), sim.worldFingerprint(r2), '同一份日志重放两次，世界逐位一致');

  // ——— 快进时动作落在正确的时刻 ———
  //
  // 这是整个设计的核心断言。如果动作不是落在「它发生的时刻」而是
  // 「读到它的时刻」，那么关掉标签页三天再回来，这三天的投食会全部
  // 挤在恢复的那一瞬间 —— 世界的轨迹完全不同。
  const oneShot = sim.createWorld(SEED, T0);
  sim.advanceWorld(oneShot, 30 * 60 * 60);
  const stepped = sim.cloneWorld(oneShot);
  const oneShotStart = oneShot.tick;

  // 一次性快进 3 小时
  sim.advanceWorld(oneShot, oneShotStart + Math.floor(3 * hour / sim.SIM_DT_MS), journal);
  // 分成 11 段推进
  const chunk = Math.floor((3 * hour / sim.SIM_DT_MS) / 11);
  for (let k = 1; k <= 10; k++) {
    sim.advanceWorld(stepped, oneShotStart + chunk * k, journal);
  }
  sim.advanceWorld(stepped, oneShotStart + Math.floor(3 * hour / sim.SIM_DT_MS), journal);

  assertEq(
    sim.worldFingerprint(oneShot),
    sim.worldFingerprint(stepped),
    '一次性快进与分段快进下，动作都落在同一个时刻',
  );

  // 幂等：同一份日志重复喂进去不会应用两次
  const idem = sim.cloneWorld(oneShot);
  sim.advanceWorld(idem, idem.tick, journal);
  assertEq(sim.worldFingerprint(idem), sim.worldFingerprint(oneShot), '重复提供同一份日志是幂等的');

  // ——— 杂交 ———
  const breedWorld = sim.createWorld(SEED, T0);
  sim.advanceWorld(breedWorld, 30 * 60 * 60 * 6);
  const alive = breedWorld.fish.filter((f) => f.decay <= 0);
  assertTrue(alive.length >= 2, `准备杂交：${alive.length} 条活鱼`);
  const pa = alive[0];
  const pb = alive[1];
  const genomesBefore = breedWorld.genomes.length;
  const popBefore = breedWorld.fish.length;

  const breedAction = {
    seq: 500,
    atMs: T0 + breedWorld.tick * sim.SIM_DT_MS + 60000,
    kind: 'breed',
    parentA: pa.id,
    parentB: pb.id,
  };
  sim.advanceWorld(breedWorld, breedWorld.tick + 30 * 60 * 5, [breedAction]);

  assertTrue(
    breedWorld.genomes.length > genomesBefore,
    '杂交创造了新的基因组',
    `${genomesBefore} → ${breedWorld.genomes.length}`,
  );
  assertTrue(breedWorld.fish.length > popBefore, '杂交产生了新个体', `${popBefore} → ${breedWorld.fish.length}`);

  const child = breedWorld.genomes[breedWorld.genomes.length - 1];
  assertEq(child.parents.join(','), `${pa.id},${pb.id}`, '后代的谱系记录了父母');
  assertEq(
    child.generation,
    Math.max(breedWorld.genomes[pa.genome].generation, breedWorld.genomes[pb.genome].generation) + 1,
    '后代世代数递增',
  );

  // 后代必须落在父母之间（是混合，不是复制）
  const ga = breedWorld.genomes[pa.genome];
  const gb = breedWorld.genomes[pb.genome];
  const lo = Math.min(ga.morphology.length, gb.morphology.length);
  const hi = Math.max(ga.morphology.length, gb.morphology.length);
  assertTrue(
    child.morphology.length >= lo && child.morphology.length <= hi,
    '后代体长落在父母之间',
    `${child.morphology.length} ∈ [${lo}, ${hi}]`,
  );
  // 结构基因整段继承，必须是父母之一的段数
  assertTrue(
    child.morphology.spineSegments === ga.morphology.spineSegments ||
      child.morphology.spineSegments === gb.morphology.spineSegments,
    '结构基因（脊柱段数）整段继承自父母之一，没有被插值',
  );

  // 杂交的重放也必须确定
  const b1 = sim.createWorld(SEED, T0);
  const b2 = sim.createWorld(SEED, T0);
  sim.advanceWorld(b1, 30 * 60 * 60 * 6);
  sim.advanceWorld(b2, 30 * 60 * 60 * 6);
  const ba = b1.fish.filter((f) => f.decay <= 0)[0];
  const bb = b1.fish.filter((f) => f.decay <= 0)[1];
  const sameBreed = {
    seq: 500,
    atMs: T0 + b1.tick * sim.SIM_DT_MS + 60000,
    kind: 'breed',
    parentA: ba.id,
    parentB: bb.id,
  };
  sim.advanceWorld(b1, b1.tick + 30 * 60 * 5, [sameBreed]);
  sim.advanceWorld(b2, b2.tick + 30 * 60 * 5, [sameBreed]);
  assertEq(sim.worldFingerprint(b1), sim.worldFingerprint(b2), '杂交的重放同样逐位一致');

  // ——— 亲本已死：静默失败，而不是崩溃或生出幽灵 ———
  const deadWorld = sim.createWorld(SEED, T0);
  sim.advanceWorld(deadWorld, 30 * 60 * 60);
  const ghosts = {
    seq: 900,
    atMs: T0 + 2 * hour,
    kind: 'breed',
    parentA: 99999,
    parentB: 99998,
  };
  const genomesBefore2 = deadWorld.genomes.length;
  sim.advanceWorld(deadWorld, deadWorld.tick + 30 * 60 * 30, [ghosts]);
  assertEq(deadWorld.genomes.length, genomesBefore2, '亲本不存在时杂交静默失败，不产生幽灵后代');

  // ——— 动作顺序 ———
  // 日志里时间靠后的动作不能抢在靠前的之前生效
  const ord = sim.createWorld(SEED, T0);
  sim.advanceWorld(ord, tickAt(1));
  const ordered = [
    { seq: 10, atMs: T0 + 1.0 * hour, kind: 'feed', x: 100000, y: 300000, amount: sim.fx(1.0) },
    { seq: 11, atMs: T0 + 2.6 * hour, kind: 'feed', x: 900000, y: 300000, amount: sim.fx(1.0) },
  ];
  // 推进到 2 小时：只有 1.0h 那条该生效，2.6h 那条还没到
  sim.advanceWorld(ord, tickAt(2), ordered);
  assertTrue(ord.lastActionSeq === 10, '只应用了已到时刻的那一条', `lastActionSeq=${ord.lastActionSeq}`);
  // 再推进到 3 小时：第二条生效
  sim.advanceWorld(ord, tickAt(3), ordered);
  assertTrue(ord.lastActionSeq === 11, '时刻到了之后第二条才生效', `lastActionSeq=${ord.lastActionSeq}`);

  // ——— 日志整理 ———
  const messy = [ordered[1], ordered[0], ordered[0], { junk: true }, null];
  const cleaned = sim.normalizeJournal(messy);
  assertEq(cleaned.length, 2, 'normalizeJournal 去重、丢弃坏记录');
  assertTrue(cleaned[0].seq < cleaned[1].seq, 'normalizeJournal 按时间排序');

  if (trace) {
    console.log(
      `\n  投食 ${before.toFixed(3)} → ${fedNut.toFixed(3)} mg/L（不投则 ${unfedNut.toFixed(3)}）`,
    );
    console.log(
      `  杂交：${ga.morphology.spineSegments}/${ga.morphology.length} × ` +
        `${gb.morphology.spineSegments}/${gb.morphology.length} → ` +
        `${child.morphology.spineSegments}/${child.morphology.length}（第 ${child.generation} 代）`,
    );
  }
}

/** 12. 自适应画质（P6） */
function testAdaptive(sim) {
  section('12. 自适应画质');

  const budget = 16.7;

  // ——— 超预算就降 ———
  const a = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 400; i++) a.observe(26, 26, budget); // CPU 26ms，远超 16.7
  assertTrue(a.snapshot(budget).scale < 0.75, '持续超预算会把渲染缩放降下来', `scale=${a.snapshot(budget).scale.toFixed(2)}`);
  assertTrue(a.snapshot(budget).downgrades > 0, `发生了 ${a.snapshot(budget).downgrades} 次降档`);

  // ——— 降到下限就停 ———
  const b = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 4000; i++) b.observe(200, 200, budget);
  assertEq(b.snapshot(budget).scale, sim.MIN_SCALE, '降档停在下限，不会一直降下去');

  // ——— 有余量就升回去 ———
  const c = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 300; i++) c.observe(30, 30, budget);
  const low = c.snapshot(budget).scale;
  for (let i = 0; i < 3000; i++) c.observe(2, 2, budget);
  assertTrue(c.snapshot(budget).scale > low, '预算有余量时会升回去', `${low.toFixed(2)} → ${c.snapshot(budget).scale.toFixed(2)}`);
  assertTrue(c.snapshot(budget).scale <= 1, '升档不会超过 1');

  // ——— GPU 瓶颈也要能感知 ———
  //
  // 这个用例是整个类存在的理由：CPU 只用了 2ms，但下一帧 40ms 才来 ——
  // 说明真正的开销在 GPU 那边。只看 CPU 时间的实现会以为一切良好。
  const d = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 400; i++) d.observe(2, 40, budget);
  assertTrue(
    d.snapshot(budget).scale < 0.8,
    'CPU 很快但帧来得晚（GPU 瓶颈）时同样会降档',
    `scale=${d.snapshot(budget).scale.toFixed(2)}`,
  );

  // ——— 迟滞：稳态下不该来回抖 ———
  const e = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 500; i++) e.observe(15, 16, budget); // 刚好在预算内
  const changes = e.snapshot(budget).downgrades + e.snapshot(budget).upgrades;
  assertTrue(changes <= 2, '稳态下几乎不调整（不会来回抖）', `调整了 ${changes} 次`);

  // ——— 预热期 ———
  const f = new sim.AdaptiveQuality(1);
  for (let i = 0; i < 20; i++) f.observe(100, 100, budget);
  assertEq(f.snapshot(budget).scale, 1, '预热期内不降档（避开着色器编译与纹理上传的尖刺）');

  if (trace) {
    console.log(
      `\n  超预算 400 帧后 scale=${a.snapshot(budget).scale.toFixed(2)}，` +
        `GPU 瓶颈 400 帧后 scale=${d.snapshot(budget).scale.toFixed(2)}`,
    );
  }
}

/** 13. 分享编码（P6） */
function testShare(sim) {
  section('13. 分享编码');

  const world = sim.createWorld(SEED, T0);
  sim.advanceWorld(world, Math.floor((24 * 3600 * 1000) / sim.SIM_DT_MS) * 4);
  assertTrue(world.genomes.length > 5, `准备：${world.genomes.length} 个基因组 / ${world.fish.length} 条鱼`);

  // ——— 往返 ———
  const code = sim.encodeTank(world);
  const back = sim.decodeTank(code);
  assertTrue(back !== null, '分享码能被解回来');
  assertTrue(sim.tankEquivalent(world, back), '往返之后缸的状态完全等价');
  assertEq(sim.worldFingerprint(back), sim.worldFingerprint(world), '往返之后世界指纹一致');

  // ——— 紧凑度 ———
  const json = JSON.stringify(world);
  const ratio = code.length / json.length;
  assertTrue(ratio < 0.5, '分享码明显比 JSON 紧凑', `${code.length} vs ${json.length} 字符（${(ratio * 100).toFixed(0)}%）`);

  // ——— 坏码必须被拒绝 ———
  //
  // 分享码要经过剪贴板、聊天软件、地址栏。宁可拒绝，也不要让一份
  // 被改坏的档案污染别人的模拟。
  assertEq(sim.decodeTank(''), null, '拒绝空串');
  assertEq(sim.decodeTank('hello world'), null, '拒绝没有前缀的串');
  assertEq(sim.decodeTank(code.slice(0, code.length - 12)), null, '拒绝被截断的码');
  assertEq(sim.decodeTank(code.slice(0, 60)), null, '拒绝只保留前半段的码');
  assertEq(sim.decodeTank(code + 'ZZZZ'), null, '拒绝尾部多了内容的码');

  // 翻转中间一个字符：绝大多数情况下应当被拒绝
  const mid = Math.floor(code.length / 2);
  const flipped = code.slice(0, mid) + (code[mid] === 'A' ? 'B' : 'A') + code.slice(mid + 1);
  assertEq(sim.decodeTank(flipped), null, '拒绝中间被改过一个字符的码');

  // 允许粘贴时带空白和换行
  const wrapped = `${code.slice(0, 40)}\n  ${code.slice(40)}\n`;
  assertTrue(sim.decodeTank(wrapped) !== null, '容忍粘贴时带入的空白与换行');

  // ——— 单条鱼 ———
  const g = world.genomes[world.genomes.length - 1];
  const gcode = sim.encodeGenome(g);
  const gback = sim.decodeGenome(gcode);
  assertTrue(gback !== null, '鱼的种子串能被解回来');
  assertEq(sim.genomeFingerprint(gback), sim.genomeFingerprint(g), '往返之后基因组指纹一致');
  assertEq(sim.decodeGenome(gcode + 'X'), null, '拒绝尾部多一个字符的鱼码');
  assertEq(sim.decodeGenome('F1'), null, '拒绝空载荷');
  assertEq(sim.decodeGenome(gcode.slice(0, gcode.length - 3)), null, '拒绝被截断的鱼码');

  // ——— 谱系 ———
  const nodes = sim.buildLineage(world);
  assertEq(nodes.length, world.genomes.length, '谱系覆盖了池子里的每个基因组');
  let sorted = true;
  for (let i = 1; i < nodes.length; i++) {
    const p0 = nodes[i - 1];
    const p1 = nodes[i];
    if (p1.depth < p0.depth || (p1.depth === p0.depth && p1.genome.id < p0.genome.id)) sorted = false;
  }
  assertTrue(sorted, '谱系按 (深度, id) 排序 —— 确定性，同一个缸每次打开都一样');
  assertTrue(
    nodes.some((n) => n.depth > 0),
    '池子里确实有后代（深度 > 0）',
    `最大深度 ${nodes.reduce((m, n) => Math.max(m, n.depth), 0)}`,
  );
  // 后代必须排在父母之后
  let parentsFirst = true;
  const seen = new Set();
  for (const n of nodes) {
    if (n.genome.parents) {
      for (const pid of n.genome.parents) {
        if (world.genomes.some((g) => g.id === pid) && !seen.has(pid)) parentsFirst = false;
      }
    }
    seen.add(n.genome.id);
  }
  assertTrue(parentsFirst, '父母在谱系里排在子女之前');
  assertTrue(sim.renderLineage(world).includes('代'), '谱系能渲染成文本');
  assertEq(sim.renderLineage(world), sim.renderLineage(world), '谱系渲染是确定性的');

  // ——— 分享链接 ———
  const url = sim.shareUrlForSeed('reef-7f3a91c2', 'chrome-extension://abc/newtab/index.html');
  assertTrue(url.includes('seed=reef-7f3a91c2'), '分享链接带上了种子', url);

  // ——— 解出来的缸可以继续演化 ———
  const cont = sim.decodeTank(code);
  const orig = sim.cloneWorld(world);
  const steps = Math.floor((3600 * 1000) / sim.SIM_DT_MS);
  sim.advanceWorld(orig, orig.tick + steps);
  sim.advanceWorld(cont, cont.tick + steps);
  assertEq(
    sim.worldFingerprint(orig),
    sim.worldFingerprint(cont),
    '从分享码恢复的缸，之后与原件走出完全相同的轨迹',
  );

  if (trace) {
    console.log(
      `\n  缸的档案：${code.length} 字符（JSON 是 ${json.length}，压缩到 ${(ratio * 100).toFixed(0)}%）`,
    );
    console.log(`  单条鱼：${gcode.length} 字符`);
    console.log(`  ${sim.describeTank(world)}`);
  }
}

// ————————————————————————————————————————————————————————————

async function main() {
  console.log('\x1b[1m计算水族箱 · P1 确定性内核测试\x1b[0m');

  const { mod: sim, cleanup } = await loadSim();
  const sim2 = sim;
  try {
    testDeterminism(sim);
    testBulkVsIncremental(sim);
    testSnapshotRoundTrip(sim);
    testFastForward(sim);
    await testNoTranscendentals();
    testEcologyAlive(sim);
    testIsqrt(sim);
    testFlora(sim);
    testGenome(sim);
    testSchool(sim);
    testEcologyCycle(sim, sim2);
    testInteraction(sim);
    testAdaptive(sim);
    testShare(sim);
  } finally {
    await cleanup();
  }

  console.log('');
  if (failures === 0) console.log('\x1b[32m全部通过\x1b[0m');
  else console.log(`\x1b[31m${failures} 项失败\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试脚本自身出错：', err);
  process.exit(1);
});
