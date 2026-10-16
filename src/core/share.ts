/**
 * 分享编码。
 *
 * 项目的地基是「一个种子 = 这一缸」（DESIGN §0）。到了 P5/P6，
 * 缸里还多了一批**演化出来的**基因组 —— 一个种子已经不足以描述
 * 你此刻这一缸了。所以需要两种分享：
 *
 *   1. **种子**（短）—— 「我这一缸是从哪来的」。放进 URL 就能分享，
 *      对方看到的是同一缸的**起点**。
 *   2. **缸的档案**（长）—— 「我这一缸此刻是什么样」。带上演化出来的
 *      基因组池与鱼群，对方看到的是同一个**此刻**。
 *
 * ## 为什么不用 JSON
 *
 * 缸的档案里有几百个数（每个都是 2^20 量级的定点整数）。
 * JSON 会把它们写成十进制的十几位字符，再套一层引号和大括号 ——
 * 比必要的大一个数量级。而分享码是要**被人复制粘贴**的东西，
 * 长度直接决定它好不好用。
 *
 * 所以：变长整数（每 7 位一个字节，负数用 zigzag）+ base64。
 * 一个几百条记录的缸从 ~20KB 的 JSON 压到 ~2KB 的分享码。
 *
 * ## 校验
 *
 * 分享码会经过剪贴板、聊天软件、地址栏，任何一处都可能截断或改坏它。
 * 所以末尾带一个 FNV-1a 校验和：**宁可拒绝一份档案，也不要让一个
 * 被截断的基因组池污染别人的模拟**。
 */

import type { Genome } from './genome.js';
import { genomeFingerprint } from './genome.js';
import { WORLD_VERSION, type FishRecord, type WorldState } from './world.js';

const MAGIC = 'AQ1'; // 分享码前缀，也顺便当作版本号

// ————————————————————————————————————————————————————————————
// 变长整数
// ————————————————————————————————————————————————————————————

/**
 * 写一个变长整数。
 *
 * 负数用 zigzag 折叠进无符号：0 → 0，-1 → 1，1 → 2，-2 → 3 …
 * 这样小负数也只占一个字节（`deathAt = -1` 是很常见的值）。
 *
 * ⚠️ 刻意**不用 `<<` 和 `|`**：JS 的位运算是 32 位的，而这里要编码
 * 时间戳（~1.7×10^12）。用位运算会静默截断 —— 这个坑在 flora 的
 * `isqrt` 里已经踩过一次了。
 */
function writeVarint(out: number[], value: number): void {
  const v0 = Math.round(value);
  let v = v0 < 0 ? -v0 * 2 - 1 : v0 * 2;
  for (;;) {
    const byte = v % 128;
    v = Math.floor(v / 128);
    out.push(v > 0 ? byte + 128 : byte);
    if (v === 0) break;
  }
}

interface Cursor {
  i: number;
}

function readVarint(bytes: Uint8Array, cur: Cursor): number {
  let acc = 0;
  let scale = 1;
  for (let guard = 0; guard < 12; guard++) {
    if (cur.i >= bytes.length) throw new Error('分享码被截断');
    const b = bytes[cur.i++] as number;
    acc += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) {
      return acc % 2 === 1 ? -(acc + 1) / 2 : acc / 2;
    }
    scale *= 128;
  }
  throw new Error('变长整数异常：超过 12 个字节');
}

// ————————————————————————————————————————————————————————————
// base64（不依赖 btoa，Node 里也能跑）
// ————————————————————————————————————————————————————————————

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '';
    out += i + 2 < bytes.length ? B64[c & 63] : '';
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = buffer * 64 + v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(Math.floor(buffer / 2 ** bits) & 0xff);
      buffer %= 2 ** bits;
    }
  }
  return new Uint8Array(out);
}

// ————————————————————————————————————————————————————————————
// 缸的档案
// ————————————————————————————————————————————————————————————

/** 每个基因组写的数字个数。**必须和 pushGenome 里实际写的数量精确相等** ——
 *  少一个就会让整份档案错位，而解码不会报错，只会得到参数全错的基因组。 */
const GENOME_NUMBERS = 30;
const FISH_NUMBERS = 13;

function pushGenome(out: number[], g: Genome): void {
  const m = g.morphology;
  const p = g.pattern;
  const b = g.behavior;
  const k = g.metabolism;
  const vals = [
    g.id,
    g.generation,
    g.parents ? g.parents.length : 0,
    g.parents && g.parents.length > 0 ? (g.parents[0] as number) : 0,
    g.parents && g.parents.length > 1 ? (g.parents[1] as number) : 0,
    m.spineSegments,
    m.length, m.heightFront, m.heightBack, m.taper,
    m.dorsalHeight, m.dorsalStart, m.caudalSpan, m.caudalFork,
    m.eyeRadius, m.eyePos,
    p.hue, p.hueBelly, p.stripeFreq, p.stripeSharp, p.finAlpha,
    b.cruiseSpeed, b.boldness, b.sociability, b.depthPref, b.diet,
    k.basal, k.maxEnergy, k.lifespan, k.maturity,
  ];
  if (vals.length !== GENOME_NUMBERS) {
    // 编码期自检。靠人肉数数组长度是不可靠的 —— 加一个字段忘了改常量，
    // 症状是「别人的缸解出来全是怪鱼」，而且没有任何报错。
    throw new Error(`基因组字段数 ${vals.length} 与常量 ${GENOME_NUMBERS} 不符`);
  }
  for (const v of vals) writeVarint(out, v);
}

function popGenome(bytes: Uint8Array, cur: Cursor): Genome {
  const v: number[] = [];
  for (let i = 0; i < GENOME_NUMBERS; i++) v.push(readVarint(bytes, cur));
  const parentCount = v[2] as number;
  const parentA = v[3] as number;
  const parentB = v[4] as number;
  return {
    id: v[0] as number,
    generation: v[1] as number,
    parents:
      parentCount >= 2 ? [parentA, parentB] : parentCount === 1 ? [parentA] : null,
    morphology: {
      spineSegments: v[5] as number,
      length: v[6] as number, heightFront: v[7] as number, heightBack: v[8] as number,
      taper: v[9] as number, dorsalHeight: v[10] as number, dorsalStart: v[11] as number,
      caudalSpan: v[12] as number, caudalFork: v[13] as number,
      eyeRadius: v[14] as number, eyePos: v[15] as number,
    },
    pattern: {
      hue: v[16] as number, hueBelly: v[17] as number, stripeFreq: v[18] as number,
      stripeSharp: v[19] as number, finAlpha: v[20] as number,
    },
    behavior: {
      cruiseSpeed: v[21] as number, boldness: v[22] as number, sociability: v[23] as number,
      depthPref: v[24] as number, diet: v[25] as number,
    },
    metabolism: {
      basal: v[26] as number, maxEnergy: v[27] as number, lifespan: v[28] as number,
      maturity: v[29] as number,
    },
  };
}

function pushFish(out: number[], f: FishRecord): void {
  for (const v of [
    f.id, f.genome, f.homeX, f.homeY, f.phase, f.speedScale, f.wanderAmp,
    f.spacing, f.radius, f.decay, f.deathAt, f.energy, f.age,
  ]) {
    writeVarint(out, v);
  }
}

function popFish(bytes: Uint8Array, cur: Cursor): FishRecord {
  const v: number[] = [];
  for (let i = 0; i < FISH_NUMBERS; i++) v.push(readVarint(bytes, cur));
  return {
    id: v[0] as number, genome: v[1] as number,
    homeX: v[2] as number, homeY: v[3] as number, phase: v[4] as number,
    speedScale: v[5] as number, wanderAmp: v[6] as number, spacing: v[7] as number,
    radius: v[8] as number, decay: v[9] as number, deathAt: v[10] as number,
    energy: v[11] as number, age: v[12] as number,
  };
}

/**
 * 把一缸的当前状态编码成分享码。
 *
 * 只带**能决定未来**的东西：环境标量、基因组池、鱼群、序号计数器。
 * 不带渲染相关的量（画质、主题、构图）—— 那些是每个表面的呈现选择，
 * 不该跟着缸一起传给别人。
 */
export function encodeTank(state: WorldState): string {
  const out: number[] = [];

  // 头部
  writeVarint(out, WORLD_VERSION);
  writeVarint(out, state.tick);
  writeVarint(out, state.epochMs);
  writeVarint(out, state.temperature);
  writeVarint(out, state.nutrients);
  writeVarint(out, state.algae);
  writeVarint(out, state.detritus);
  writeVarint(out, state.oxygen);
  writeVarint(out, state.births);
  writeVarint(out, state.deaths);
  writeVarint(out, state.nextFishId);
  writeVarint(out, state.lastActionSeq);
  writeVarint(out, state.genomes.length);
  writeVarint(out, state.fish.length);
  // 种子单独走字符串，因为它是任意文本
  writeVarint(out, state.seed.length);
  for (let i = 0; i < state.seed.length; i++) writeVarint(out, state.seed.charCodeAt(i));

  for (const g of state.genomes) pushGenome(out, g);
  for (const f of state.fish) pushFish(out, f);

  // ——— 校验和 ———
  //
  // 闭环校验（解码后重新编码比对）抓不到「种子被改了一个字符」这种情况：
  // 改掉种子里的一个字符得到的是一个**合法的、不同的**缸，重新编码当然一致。
  // 所以必须另加一段覆盖全部字节的校验和。
  let h = 0x811c9dc5;
  for (const b of out) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  writeVarint(out, h);

  return MAGIC + toBase64(out);
}

/**
 * 解码分享码。
 *
 * 任何一步不合法都返回 null —— **宁可拒绝，也不要让一份被截断的档案
 * 污染别人的模拟**。调用方应当把它当作「什么都没发生」。
 */
export function decodeTank(code: string): WorldState | null {
  try {
    const text = code.trim();
    if (!text.startsWith(MAGIC)) return null;
    const bytes = fromBase64(text.slice(MAGIC.length));
    if (bytes.length < 8) return null;

    // 校验和：最后一个 varint 是它，所以先扫一遍找到边界
    const cur: Cursor = { i: 0 };
    const version = readVarint(bytes, cur);
    if (version !== WORLD_VERSION) return null;
    const tick = readVarint(bytes, cur);
    const epochMs = readVarint(bytes, cur);
    const temperature = readVarint(bytes, cur);
    const nutrients = readVarint(bytes, cur);
    const algae = readVarint(bytes, cur);
    const detritus = readVarint(bytes, cur);
    const oxygen = readVarint(bytes, cur);
    const births = readVarint(bytes, cur);
    const deaths = readVarint(bytes, cur);
    const nextFishId = readVarint(bytes, cur);
    const lastActionSeq = readVarint(bytes, cur);
    const genomeCount = readVarint(bytes, cur);
    const fishCount = readVarint(bytes, cur);
    const seedLen = readVarint(bytes, cur);

    if (genomeCount < 0 || genomeCount > 256) return null;
    if (fishCount < 0 || fishCount > 128) return null;
    if (seedLen <= 0 || seedLen > 64) return null;

    let seed = '';
    for (let i = 0; i < seedLen; i++) seed += String.fromCharCode(readVarint(bytes, cur));

    const genomes: Genome[] = [];
    for (let i = 0; i < genomeCount; i++) genomes.push(popGenome(bytes, cur));
    const fish: FishRecord[] = [];
    for (let i = 0; i < fishCount; i++) fish.push(popFish(bytes, cur));

    const state: WorldState = {
      version: WORLD_VERSION,
      seed,
      epochMs,
      tick,
      temperature, nutrients, algae, detritus, oxygen,
      genomes, fish, births, deaths, nextFishId, lastActionSeq,
    };

    // ——— 校验和 ———
    //
    // 它覆盖全部数据字节，所以**任何**改动都会被拒 —— 包括种子里的一个字符，
    // 那是闭环校验看不见的（改掉种子得到的是一个合法的、不同的缸）。
    const checksumAt = cur.i;
    const stored = readVarint(bytes, cur);
    let h = 0x811c9dc5;
    for (let i = 0; i < checksumAt; i++) {
      h = (h ^ (bytes[i] as number)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    if (h !== stored) return null;
    // ——— 闭环校验 ———
    //
    // 把解出来的状态**重新编码一遍**，要求得到与输入完全相同的分享码。
    // 这与校验和互补：校验和挡的是「字节被改坏」，闭环挡的是
    // 「编码与解码不对称」（比如字段数不匹配导致的错位）。
    //
    // 这比另写一段校验和更可靠：它验证的是「整个编解码是双射」，
    // 而截断、错位、字段数不匹配、尾随垃圾字节**都会在这里暴露**。
    // 分享码会经过剪贴板、聊天软件、地址栏，任何一处都可能改坏它 ——
    // 宁可拒绝一份档案，也不要让一个坏掉的基因组池污染别人的模拟。
    const reencoded = encodeTank(state);
    const normalize = (v: string) => v.replace(/[^A-Za-z0-9\-_]/g, '');
    if (normalize(reencoded) !== normalize(text)) return null;

    return state;
  } catch {
    return null;
  }
}

// ————————————————————————————————————————————————————————————
// 单条鱼
// ————————————————————————————————————————————————————————————

/**
 * 把一条鱼的基因组编码成短码。
 *
 * 这是「把一条鱼发给别人」—— 比整缸的档案短得多（二三十个数字），
 * 可以贴进聊天框。
 */
export function encodeGenome(g: Genome): string {
  const out: number[] = [];
  pushGenome(out, g);
  return 'F1' + toBase64(out);
}

export function decodeGenome(code: string): Genome | null {
  try {
    const text = code.trim();
    if (!text.startsWith('F1')) return null;
    const bytes = fromBase64(text.slice(2));
    const cur: Cursor = { i: 0 };
    const g = popGenome(bytes, cur);
    if (cur.i !== bytes.length) return null; // 有多余字节，说明码不对
    return g;
  } catch {
    return null;
  }
}

// ————————————————————————————————————————————————————————————
// 种子链接
// ————————————————————————————————————————————————————————————

/** 组装一个可以直接发给别人的新标签页地址。 */
export function shareUrlForSeed(seed: string, baseUrl: string): string {
  const u = new URL(baseUrl);
  u.search = `?seed=${encodeURIComponent(seed)}`;
  return u.toString();
}

/** 分享码的可读摘要，用于在界面上显示「这是一缸什么」。 */
export function describeTank(state: WorldState): string {
  const alive = state.fish.filter((f) => f.decay <= 0).length;
  const maxGen = state.genomes.reduce((m, g) => Math.max(m, g.generation), 0);
  return (
    `种子 ${state.seed} · 第 ${maxGen} 代 · ${alive} 条活鱼 · ` +
    `${state.genomes.length} 个基因组 · 累计生 ${state.births} 亡 ${state.deaths}`
  );
}

/** 供测试：两个状态是否等价（用于往返验证）。 */
export function tankEquivalent(a: WorldState, b: WorldState): boolean {
  if (a.seed !== b.seed || a.tick !== b.tick || a.epochMs !== b.epochMs) return false;
  if (a.genomes.length !== b.genomes.length || a.fish.length !== b.fish.length) return false;
  if (a.nutrients !== b.nutrients || a.algae !== b.algae) return false;
  if (a.nextFishId !== b.nextFishId || a.lastActionSeq !== b.lastActionSeq) return false;
  if (a.births !== b.births || a.deaths !== b.deaths) return false;
  for (let i = 0; i < a.genomes.length; i++) {
    if (genomeFingerprint(a.genomes[i] as Genome) !== genomeFingerprint(b.genomes[i] as Genome)) {
      return false;
    }
  }
  for (let i = 0; i < a.fish.length; i++) {
    const fa = a.fish[i] as FishRecord;
    const fb = b.fish[i] as FishRecord;
    if (
      fa.id !== fb.id || fa.genome !== fb.genome || fa.energy !== fb.energy ||
      fa.age !== fb.age || fa.homeX !== fb.homeX || fa.homeY !== fb.homeY
    ) {
      return false;
    }
  }
  return true;
}

export interface LineageNode {
  genome: Genome;
  /** 缩进层级：野生个体是 0，后代逐级 +1 */
  depth: number;
  /** 是否还活着（有活鱼在用） */
  alive: boolean;
}

/**
 * 把基因组池整理成一棵可读的谱系。
 *
 * 池子是**平铺**的（每个基因组只记父母的下标），而人想看的是树。
 * 这里按「谁是谁的后代」排出缩进层级：先放野生个体，再逐层放它们的后代，
 * 每一层内部按 id 排序 —— **顺序必须确定**，否则同一个缸每次打开
 * 看到的谱系都不一样。
 */
export function buildLineage(state: WorldState): LineageNode[] {
  const aliveGenomes = new Set<number>();
  for (const f of state.fish) if (f.decay <= 0) aliveGenomes.add(f.genome);

  const byId = new Map<number, Genome>();
  for (const g of state.genomes) byId.set(g.id, g);

  // 深度：沿父母链上溯。带一个上限防止环（理论上不会有，但坏档案可能造出来）
  const depthCache = new Map<number, number>();
  const depthOf = (id: number, guard = 0): number => {
    if (guard > 64) return 0;
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const g = byId.get(id);
    if (!g || !g.parents) {
      depthCache.set(id, 0);
      return 0;
    }
    let d = 0;
    for (const pid of g.parents) d = Math.max(d, depthOf(pid, guard + 1) + 1);
    depthCache.set(id, d);
    return d;
  };

  const nodes: LineageNode[] = state.genomes.map((g) => ({
    genome: g,
    depth: depthOf(g.id),
    alive: aliveGenomes.has(g.id),
  }));

  // 排序键是 (深度, id)，全是整数 —— 确定性排序
  nodes.sort((a, b) => a.depth - b.depth || a.genome.id - b.genome.id);
  return nodes;
}

/** 谱系的纯文本渲染，用于设置页与诊断。 */
export function renderLineage(state: WorldState, maxRows = 40): string {
  const nodes = buildLineage(state);
  const lines: string[] = [];
  lines.push(
    `第 ${nodes.reduce((m, n) => Math.max(m, n.depth), 0)} 代 · ` +
      `${nodes.length} 个基因组 · ${nodes.filter((n) => n.alive).length} 个在用`,
  );
  for (const n of nodes.slice(0, maxRows)) {
    const g = n.genome;
    const mark = n.alive ? '●' : '○';
    const parents = g.parents
      ? g.parents.length >= 2
        ? `← #${g.parents[0] as number} × #${g.parents[1] as number}`
        : `← #${g.parents[0] as number}（无性）`
      : '（野生）';
    lines.push(
      `${'  '.repeat(Math.min(n.depth, 8))}${mark} #${g.id} ` +
        `G${g.generation} ${parents} ` +
        `段${g.morphology.spineSegments} 长${(g.morphology.length / 1048576).toFixed(3)}`,
    );
  }
  if (nodes.length > maxRows) lines.push(`… 还有 ${nodes.length - maxRows} 个`);
  return lines.join('\n');
}

/** 分享码的粗略信息量（字节）。用于界面上提示「这个码有多长」。 */
export function tankCodeSize(code: string): number {
  return new TextEncoder().encode(code).length;
}

