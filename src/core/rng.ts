/**
 * 确定性随机数 —— xoshiro128** 与「命名子流」。
 *
 * ## 为什么不能只有一条随机流
 *
 * 如果整个程序共用一条随机序列，那么**在中间插入任何一次取随机数的操作，
 * 它之后的所有随机数都会整体错位**。对一个以「种子可复现」为根基的项目来说
 * 这是致命的：你只是给珊瑚加了一行代码，全世界所有老种子长出来的鱼就全变了。
 *
 * 因此这里提供 `stream(label)`：子流的身份由 `(rootSeed, 路径)` 决定，
 * **与取数的先后顺序完全无关**。往 `flora.coral` 里加代码，
 * 不会移动 `fauna.genome` 的任何一个比特。
 *
 * 这条纪律要从第一天就立起来，事后补救是不可能的。
 *
 * @see DESIGN.md §6.2
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32 位字符串哈希。用于把「种子字符串 + 路径」折叠成一个整数。 */
export function hashString(s: string, seed = FNV_OFFSET): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** 把若干整数折叠成一个。用于状态校验和，也用于组合种子。 */
export function hashCombine(...parts: number[]): number {
  let h = FNV_OFFSET;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, FNV_PRIME);
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32：用来从一个整数种子铺开成 xoshiro 需要的 4 个字。 */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = (t ^ (t >>> 15)) >>> 0;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * xoshiro128** —— 快、周期长（2^128-1）、状态只有 4 个 32 位整数。
 * 选它而不是 Mersenne Twister，是因为我们需要一个好序列化、
 * 好做校验和、在 JS 里不被 BigInt 拖慢的状态。
 */
export class Rng {
  /** 派生这条流的根种子。序列化时只需存它和 path。 */
  readonly rootSeed: number;
  /** 形如 `flora.coral/tip` 的路径。同一条路径永远得到同一条序列。 */
  readonly path: string;

  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(rootSeed: number, path: string, a: number, b: number, c: number, d: number) {
    this.rootSeed = rootSeed >>> 0;
    this.path = path;
    this.a = a >>> 0;
    this.b = b >>> 0;
    this.c = c >>> 0;
    this.d = d >>> 0;
  }

  /** 从种子字符串（推荐）或整数建立根流。 */
  static fromSeed(seed: string | number): Rng {
    const root = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    return Rng.fromRoot(root, '');
  }

  static fromRoot(rootSeed: number, path: string): Rng {
    const next = splitmix32(hashString(path, rootSeed >>> 0));
    return new Rng(rootSeed, path, next(), next(), next(), next());
  }

  /**
   * 取出一个命名子流。
   *
   * **顺序无关**：`r.stream('a')` 无论在第几步调用，拿到的都是同一条序列。
   * 这正是我们能在不破坏老种子的前提下持续加功能的原因。
   */
  stream(label: string): Rng {
    return Rng.fromRoot(this.rootSeed, this.path ? `${this.path}/${label}` : label);
  }

  /** [0, 2^32) 均匀整数。 */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5), 7), 9) >>> 0;
    const t = (this.b << 9) >>> 0;
    this.c = (this.c ^ this.a) >>> 0;
    this.d = (this.d ^ this.b) >>> 0;
    this.b = (this.b ^ this.c) >>> 0;
    this.a = (this.a ^ this.d) >>> 0;
    this.c = (this.c ^ t) >>> 0;
    this.d = rotl(this.d, 11);
    return result;
  }

  /** [0, 1) 均匀浮点。 */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [min, max) 均匀浮点。 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [min, max) 均匀整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: 空数组');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /**
   * 标准正态。用单次 Box-Muller（不缓存第二个值，以免引入调用顺序依赖）。
   *
   * ⚠️ **不要在世界模拟里用它。** Box-Muller 依赖 Math.log 和 Math.cos，
   * 而 ECMAScript 规范说这两个是 implementation-approximated —— 不同 V8
   * 版本理论上可以在最后一位上不同。渲染和调色板用没问题，
   * 模拟要用的随机数请走 range/int/bool/pick（它们只用整数与除法）。
   */
  gaussian(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 以 1 为中心的对数正态扰动，用来生成「差不多但不完全一样」的参数。 */
  jitter(magnitude: number): number {
    return Math.exp(this.gaussian(0, magnitude));
  }

  /** 供确定性自检使用的状态指纹。 */
  stateHash(): number {
    return hashCombine(this.a, this.b, this.c, this.d, hashString(this.path, this.rootSeed));
  }

  /** 复制当前状态。用于「试算」而不污染主线。 */
  clone(): Rng {
    return new Rng(this.rootSeed, this.path, this.a, this.b, this.c, this.d);
  }
}

/** 便于把种子呈现给用户：形如 `reef-7f3a91c2`。 */
export function randomSeedString(): string {
  const words = ['reef', 'kelp', 'tide', 'coral', 'moon', 'dune', 'mist', 'abyss', 'glass', 'salt'];
  const w = words[Math.floor(Math.random() * words.length)] as string;
  const n = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${w}-${n}`;
}

/** 校验用户手输的种子串是否可用（非空、长度合理）。 */
export function normalizeSeed(input: string): string {
  const s = input.trim().slice(0, 64);
  return s.length > 0 ? s : randomSeedString();
}
