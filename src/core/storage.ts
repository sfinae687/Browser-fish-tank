/**
 * 存储抽象。
 *
 * 关键设计：**同一份代码在扩展里和普通网页里都要能跑。**
 *
 * 这不是为了好看。渲染器的迭代速度快慢，取决于你能不能改一行然后立刻看到结果。
 * 如果每次都要 `chrome://extensions` → 重新加载 → 开新标签页，
 * 美术调优会痛苦十倍。所以这里探测环境：
 *
 *   chrome.storage.sync   —— 优先。跨设备同步，配置体积小，正合适
 *   chrome.storage.local  —— sync 不可用时（未登录、配额满）
 *   localStorage          —— 不在扩展里时（本地预览、自动化截图）
 *
 * 于是 `node tools/preview.mjs` 起一个静态服务器就能调着色器，
 * 完全不需要碰扩展机制。
 *
 * @see DESIGN.md §6.3
 */

import type { Config } from './config.js';
import { sanitizeConfig, defaultConfig } from './config.js';

import { sanitizeWorld, worldFingerprint, type WorldState } from './world.js';
import { normalizeJournal, JOURNAL_LIMIT, type Action } from './actions.js';

export const CONFIG_KEY = 'aqua.config';
/**
 * 世界快照的键。
 *
 * 放在 chrome.storage.local 而不是 IndexedDB：世界状态只有 ~9 个数字，
 * 一两百字节。IndexedDB 的复杂度换不来任何东西，而 chrome.storage
 * 在**所有**上下文里都能用 —— 包括运行在别人网页里的覆盖层 content script
 * （它的 IndexedDB 是宿主页面的源，和扩展不是同一个库，这会是真 bug）。
 *
 * IndexedDB 留给 P4 的事件日志与 P3 的基因组池，那些才会真的变大。
 *
 * @see DESIGN.md §6.3
 */
export const WORLD_KEY = 'aqua.world';

/**
 * 玩家意图日志的键。
 *
 * 和世界快照一样只走 local —— 它是**这台机器上这一缸**的操作历史，
 * 同步到别的设备上只会和那边的世界打架。
 */
export const JOURNAL_KEY = 'aqua.journal';
export const CLOCK_KEY = 'aqua.clock';
export const META_KEY = 'aqua.meta';

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' &&
  typeof chrome.storage !== 'undefined' &&
  chrome.storage !== null;

const hasSyncStorage = (): boolean => {
  try {
    return hasChromeStorage() && typeof chrome.storage.sync !== 'undefined';
  } catch {
    return false;
  }
};

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    // 某些隐私模式下访问 localStorage 会直接抛异常
    return false;
  }
};

type Area = 'sync' | 'local' | 'web';

/** 当前实际生效的存储后端，用于诊断面板展示。 */
export function storageBackend(): Area {
  if (hasSyncStorage()) return 'sync';
  if (hasChromeStorage()) return 'local';
  return 'web';
}

async function areaGet<T>(area: Area, key: string): Promise<T | undefined> {
  switch (area) {
    case 'sync':
    case 'local': {
      const store = area === 'sync' ? chrome.storage.sync : chrome.storage.local;
      const result = await store.get(key);
      return result[key] as T | undefined;
    }
    case 'web': {
      if (!hasLocalStorage()) return undefined;
      const raw = localStorage.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    }
  }
}

async function areaSet(area: Area, key: string, value: unknown): Promise<void> {
  switch (area) {
    case 'sync':
    case 'local': {
      const store = area === 'sync' ? chrome.storage.sync : chrome.storage.local;
      await store.set({ [key]: value });
      return;
    }
    case 'web': {
      if (!hasLocalStorage()) return;
      localStorage.setItem(key, JSON.stringify(value));
      return;
    }
  }
}

/**
 * 写入，失败时逐级降级。
 *
 * `chrome.storage.sync` 会因为未登录、配额超限、企业策略等原因失败。
 * 配置写不进去是小事，但**让整个设置页因此崩掉**是大事。
 */
async function setResilient(key: string, value: unknown, preferred?: Area[]): Promise<Area> {
  // ⚠️ 显式给了顺序就**严格照办**，不要再把「当前首选后端」插到最前面。
  //
  // 这里踩过一个很难查的坑：世界快照传的是 ['local','web']，但这段代码
  // 仍然会把 storageBackend()（扩展里是 'sync'）排在第一位，于是快照写进了
  // 同步存储，而读取固定从 local 读 —— 写和读不在同一个地方，
  // 表现为「世界每次打开都从头开始」。模块级测试完全看不到这个 bug，
  // 是两个后端之间的接缝。
  const candidates: Area[] =
    preferred ??
    (() => {
      const base: Area[] = ['sync', 'local', 'web'];
      const start = storageBackend();
      return base.includes(start) ? base : [start, ...base];
    })();

  for (const area of candidates) {
    if (area === 'web' && !hasLocalStorage()) continue;
    if (area !== 'web' && !hasChromeStorage()) continue;
    try {
      await areaSet(area, key, value);
      return area;
    } catch {
      continue;
    }
  }
  return storageBackend();
}

// ————————————————————————————————————————————————————————————
// 配置读写
// ————————————————————————————————————————————————————————————

export async function loadConfig(): Promise<Config> {
  const raw = await areaGet<unknown>(storageBackend(), CONFIG_KEY);
  return sanitizeConfig(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  await setResilient(CONFIG_KEY, config);
}

/** 配置变更订阅。跨表面生效——chrome.storage.onChanged 在所有上下文里都会触发。 */
export function onConfigChanged(cb: (config: Config) => void): () => void {
  if (hasChromeStorage()) {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (!(CONFIG_KEY in changes)) return;
      if (areaName !== 'sync' && areaName !== 'local') return;
      cb(sanitizeConfig(changes[CONFIG_KEY]?.newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  // 网页预览模式下退回 storage 事件（只在同源的其他标签页间触发）
  const listener = (e: StorageEvent): void => {
    if (e.key !== CONFIG_KEY || e.newValue === null) return;
    try {
      cb(sanitizeConfig(JSON.parse(e.newValue)));
    } catch {
      /* 忽略坏数据 */
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }
  return () => {};
}

// ————————————————————————————————————————————————————————————
// 世界快照
// ————————————————————————————————————————————————————————————

interface StoredWorld {
  savedAtMs: number;
  /** 写入时的精确指纹，用于发现存储损坏 */
  fingerprint: string;
  state: WorldState;
}

/**
 * 读取世界快照。
 *
 * 三道校验：结构合法（sanitizeWorld）、指纹与状态一致（发现损坏）、
 * 种子匹配（换了种子就当作没有快照）。任何一道不过都返回 null，
 * 让调用方退回一个全新的世界 —— 坏掉的世界状态比没有状态危险得多。
 */
/**
 * 世界状态**只走 local**，不参与 sync。
 *
 * 两个理由，都很硬：
 *   1. `chrome.storage.sync` 有写入频率配额（每分钟 120 次）。世界快照是
 *      周期性写的运行时状态，几秒钟一次，扔进 sync 会直接触发配额失败。
 *   2. 世界状态是**这台机器上这一缸**的当前状态。同步到另一台设备上
 *      只会和那边正在跑的世界打架 —— 会漫游的是配置和种子，不是水。
 */
const WORLD_AREAS: Area[] = ['local', 'web'];

export async function loadWorldSnapshot(expectedSeed?: string): Promise<WorldState | null> {
  const raw = await areaGet<unknown>(storageBackend() === 'web' ? 'web' : 'local', WORLD_KEY);
  if (typeof raw !== 'object' || raw === null) return null;

  const stored = raw as Partial<StoredWorld>;
  const state = sanitizeWorld(stored.state);
  if (!state) return null;

  if (typeof stored.fingerprint === 'string' && stored.fingerprint !== worldFingerprint(state)) {
    console.warn('[计算水族箱] 世界快照指纹不符，已丢弃（存储可能损坏）');
    return null;
  }

  if (expectedSeed !== undefined && state.seed !== expectedSeed) return null;

  return state;
}

export async function saveWorldSnapshot(state: WorldState, savedAtMs: number): Promise<void> {
  const payload: StoredWorld = {
    savedAtMs,
    fingerprint: worldFingerprint(state),
    state,
  };
  await setResilient(WORLD_KEY, payload, WORLD_AREAS);
}

// ————————————————————————————————————————————————————————————
// 玩家意图日志
// ————————————————————————————————————————————————————————————

export async function loadJournal(): Promise<Action[]> {
  const raw = await areaGet<unknown>(storageBackend() === 'web' ? 'web' : 'local', JOURNAL_KEY);
  return normalizeJournal(raw);
}

/**
 * 追加一条意图记录。
 *
 * 序号取 `max(最大序号 + 1, 当前时刻)`，于是它天然单调，而且**跨表面可比**：
 * 两个表面各自追加时不会撞号（除非在同一毫秒内并发点击 —— 用户点击的频率
 * 下这个概率可以忽略，而且真撞了也只是丢一次投食）。
 *
 * 读-改-写本身不是原子的。这里不做锁：这条记录的代价只有「一次投食」，
 * 为它引入一套跨进程锁不值得。真正不能丢的是世界状态，而那个走的是
 * 另一条路径（单调步号，last-write-wins）。
 */
export async function appendAction(action: Omit<Action, 'seq'>): Promise<Action> {
  const current = await loadJournal();
  const maxSeq = current.reduce((m, a) => Math.max(m, a.seq), 0);
  const seq = Math.max(maxSeq + 1, Date.now());
  const full: Action = { ...action, seq };

  const next = [...current, full];
  const trimmed = next.length > JOURNAL_LIMIT ? next.slice(next.length - JOURNAL_LIMIT) : next;
  await setResilient(JOURNAL_KEY, trimmed, WORLD_AREAS);
  return full;
}

/** 日志变更订阅。跨表面生效 —— 这是「在 A 里投食，B 也能看到」的通道。 */
export function onJournalChanged(cb: (actions: Action[]) => void): () => void {
  if (hasChromeStorage()) {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (!(JOURNAL_KEY in changes)) return;
      if (areaName !== 'sync' && areaName !== 'local') return;
      cb(normalizeJournal(changes[JOURNAL_KEY]?.newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  const listener = (e: StorageEvent): void => {
    if (e.key !== JOURNAL_KEY || e.newValue === null) return;
    try {
      cb(normalizeJournal(JSON.parse(e.newValue)));
    } catch {
      /* 忽略坏数据 */
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }
  return () => {};
}

/** 清空日志。设置页的「重置」会用到。 */
export async function clearJournal(): Promise<void> {
  await setResilient(JOURNAL_KEY, [], WORLD_AREAS);
}

/** 恢复出厂设置，但保留种子 —— 用户通常想留住自己这一缸。 */
export async function resetConfig(keepSeed = true): Promise<Config> {
  const current = await loadConfig();
  const fresh = defaultConfig(keepSeed ? current.world.seed : undefined);
  await saveConfig(fresh);
  return fresh;
}

export async function exportConfig(): Promise<string> {
  return JSON.stringify(await loadConfig(), null, 2);
}

/** 导入配置。坏数据会被 sanitize 兜住，而不是抛异常给 UI。 */
export async function importConfig(json: string): Promise<Config> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`不是合法的 JSON：${(e as Error).message}`);
  }
  const config = sanitizeConfig(parsed);
  await saveConfig(config);
  return config;
}
