/**
 * URL 参数覆盖。
 *
 * 两个用途，都很实在：
 *
 *   1. **分享**：`?seed=reef-7f3a91c2&theme=lagoon` 就是一个可以直接发给别人的鱼缸。
 *      接收方打开的瞬间看到的就是你这一缸，不需要导入任何配置文件。
 *   2. **调试**：调着色器时不用每次都去设置页点一遍，
 *      直接在地址栏改参数刷新即可。
 *
 * 覆盖只作用于当前这次加载的内存副本，**绝不写回存储** ——
 * 否则你只是点开了一个分享链接，自己原来的缸就被换掉了。
 *
 * @see DESIGN.md §0
 */

import type { Config, SurfaceId } from './config.js';

const SURFACE_PARAM = 'surface';

/** 这些键会被识别。其余参数一律忽略。 */
const LIMIT = 32;

function clampNum(raw: string | null, lo: number, hi: number): number | null {
  if (raw === null) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export interface UrlOverrideResult {
  config: Config;
  /** 实际生效的覆盖项，用于在 HUD 上提示「这是被 URL 改过的状态」 */
  applied: string[];
}

/**
 * 把 `location.search` 里的参数应用到配置副本上。
 *
 * 参数一律宽松解析：写错了就忽略，绝不抛异常。
 * 一个分享链接里的笔误不该让页面白屏。
 */
export function applyUrlOverrides(
  base: Config,
  defaultSurface: SurfaceId,
  search: string = typeof location !== 'undefined' ? location.search : '',
): UrlOverrideResult {
  const params = new URLSearchParams(search);
  const applied: string[] = [];

  if ([...params.keys()].length === 0) return { config: base, applied };

  const config: Config = structuredClone(base);

  // `?surface=overlay` 可以让新标签页直接按覆盖层的配置渲染，
  // 调试覆盖层观感时不用真的去开权限注入
  const target: SurfaceId =
    params.get(SURFACE_PARAM) === 'overlay' || params.get(SURFACE_PARAM) === 'newtab'
      ? (params.get(SURFACE_PARAM) as SurfaceId)
      : defaultSurface;
  const sc = config.surfaces[target];

  const seed = params.get('seed');
  if (seed?.trim()) {
    config.world.seed = seed.trim().slice(0, LIMIT * 2);
    // URL 指定的种子是给整个共享世界的
    for (const id of ['newtab', 'overlay'] as const) {
      config.surfaces[id].separateSeed = false;
    }
    applied.push(`seed=${config.world.seed}`);
  }

  const theme = params.get('theme');
  if (
    theme === 'reef' ||
    theme === 'planted' ||
    theme === 'blackwater' ||
    theme === 'lagoon' ||
    theme === 'abyss'
  ) {
    sc.theme = theme;
    applied.push(`theme=${theme}`);
  }

  const quality = params.get('quality');
  if (quality === 'low' || quality === 'medium' || quality === 'high' || quality === 'auto') {
    sc.quality = quality;
    applied.push(`quality=${quality}`);
  }

  const opacity = clampNum(params.get('opacity'), 0, 1);
  if (opacity !== null) {
    sc.opacity = opacity;
    applied.push(`opacity=${opacity}`);
  }

  const framing = params.get('framing');
  if (
    framing === 'fill' ||
    framing === 'letterbox' ||
    framing === 'bottom' ||
    framing === 'porthole'
  ) {
    sc.framing = framing;
    applied.push(`framing=${framing}`);
  }

  const background = params.get('bg');
  if (
    background === 'tank' ||
    background === 'generative' ||
    background === 'transparent' ||
    background === 'page'
  ) {
    sc.background = background;
    applied.push(`bg=${background}`);
  }

  const motion = params.get('motion');
  if (motion === 'full' || motion === 'calm' || motion === 'reduced' || motion === 'still') {
    sc.motion = motion;
    applied.push(`motion=${motion}`);
  }

  const zoom = clampNum(params.get('zoom'), 0.4, 3);
  if (zoom !== null) {
    sc.zoom = zoom;
    applied.push(`zoom=${zoom}`);
  }

  if (params.has('nointro')) {
    sc.intro = false;
    applied.push('nointro');
  }

  // `?glass=0` 关玻璃，调试时用来对比「有没有玻璃层的差别」
  const glass = params.get('glass');
  if (glass === '0' || glass === '1') {
    sc.layers.glass = glass === '1';
    applied.push(`glass=${glass}`);
  }

  // `?hud=0` 强制隐藏状态栏。截图和录屏时用。
  if (params.get('hud') === '0') {
    sc.layers.hud = false;
    applied.push('hud=0');
  }

  // `?only=fauna,glass` 只保留列出的图层，其余全关 —— 逐层排查时非常省事
  const only = params.get('only');
  if (only) {
    const keep = new Set(
      only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const key of Object.keys(sc.layers) as Array<keyof typeof sc.layers>) {
      sc.layers[key] = keep.has(key);
    }
    applied.push(`only=${[...keep].join(',')}`);
  }

  // 让设置页也能被 URL 指向某个表面
  if (params.get(SURFACE_PARAM)) applied.push(`surface=${target}`);

  return { config, applied };
}
