/**
 * 配置的持久化。
 *
 * ## 为什么写多个存储区
 *
 * `chrome.storage.sync` 会跟着账号同步到别的设备，但它有配额限制
 * （单项 8KB，总共 100KB），而且**在无头浏览器 / 未登录状态下会直接失败**。
 * `local` 没有配额问题但不跨设备。
 *
 * 所以策略是「都写、读的时候按顺序找第一个有的」：
 * 写失败一个不影响另一个，读的时候总有一个能命中。
 *
 * ⚠️ 调用方如果显式给了顺序，**必须严格按那个顺序**。
 * 上一版有个 bug：读的时候无条件把某个区插到最前面，
 * 于是「写进 A、从 B 读」—— 表现是「每次打开世界都从头开始」。
 * 显式顺序是用来表达意图的，不是用来给默认值让路的。
 */

import { sanitizeConfig, type Config } from './config.js';

export const CONFIG_KEY = 'aqua.config';

export type Area = 'local' | 'sync' | 'session';

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.storage !== 'undefined' &&
    typeof chrome.storage.local !== 'undefined'
  );
}

/** 可用的存储区，按「最该用哪个」排序。 */
export function storageAreas(): Area[] {
  if (!hasChromeStorage()) return ['local'];
  const out: Area[] = ['local'];
  if (chrome.storage.sync) out.push('sync');
  if (chrome.storage.session) out.push('session');
  return out;
}

/** 当前实际生效的存储区（用于诊断显示）。 */
export function storageBackend(): Area {
  return storageAreas()[0] ?? 'local';
}

// ————————————————————————————————————————————————————————————
// 通用读写
// ————————————————————————————————————————————————————————————

/** localStorage 兜底 —— 非扩展环境（本地预览页）也能跑。 */
function webStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

async function areaGet(area: Area, key: string): Promise<unknown> {
  if (!hasChromeStorage()) {
    const raw = webStorage()?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  }
  const store = chrome.storage[area];
  if (!store) return undefined;
  const got = await store.get(key);
  return got?.[key];
}

async function areaSet(area: Area, key: string, value: unknown): Promise<void> {
  if (!hasChromeStorage()) {
    webStorage()?.setItem(key, JSON.stringify(value));
    return;
  }
  const store = chrome.storage[area];
  if (!store) throw new Error(`存储区 ${area} 不可用`);
  await store.set({ [key]: value });
}

/**
 * 依次尝试写入每个存储区，至少成功一个就算成功。
 *
 * 一个区写失败（配额、无权限、未登录）不该让整个保存失败。
 */
export async function setResilient(
  key: string,
  value: unknown,
  order?: readonly Area[],
): Promise<boolean> {
  // 显式顺序优先，且**不做任何重排** —— 见文件头
  const areas = order ?? storageAreas();
  let anyOk = false;
  for (const area of areas) {
    try {
      await areaSet(area, key, value);
      anyOk = true;
    } catch {
      // 继续试下一个
    }
  }
  return anyOk;
}

/** 按顺序找第一个有值的存储区。 */
export async function getResilient(key: string, order?: readonly Area[]): Promise<unknown> {
  for (const area of order ?? storageAreas()) {
    try {
      const v = await areaGet(area, key);
      if (v !== undefined && v !== null) return v;
    } catch {
      // 继续试下一个
    }
  }
  return undefined;
}

/** 从所有存储区删除某个键。 */
export async function removeEverywhere(key: string): Promise<void> {
  if (!hasChromeStorage()) {
    webStorage()?.removeItem(key);
    return;
  }
  for (const area of storageAreas()) {
    try {
      await chrome.storage[area].remove(key);
    } catch {
      /* 忽略 */
    }
  }
}

// ————————————————————————————————————————————————————————————
// 配置
// ————————————————————————————————————————————————————————————

export async function loadConfig(): Promise<Config> {
  const raw = await getResilient(CONFIG_KEY);
  return sanitizeConfig(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  await setResilient(CONFIG_KEY, config);
}

/** 订阅配置变更。跨表面生效 —— 设置页改的东西，新标签页立刻能看到。 */
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

  const listener = (e: StorageEvent): void => {
    if (e.key !== CONFIG_KEY || e.newValue === null) return;
    try {
      cb(sanitizeConfig(JSON.parse(e.newValue)));
    } catch {
      /* 坏数据忽略 */
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }
  return () => {};
}
