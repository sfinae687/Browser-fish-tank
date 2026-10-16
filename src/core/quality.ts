/**
 * 画质档位解析。
 *
 * 用户的 `quality: 'auto'` 在这里被翻译成一组**具体的**渲染参数。
 * 集中在一处的理由是：电量是这个项目的首要约束（DESIGN.md §7），
 * 而省电的决定分散在十个文件里是没法调优的。
 */

import type { Quality, SurfaceConfig } from './config.js';

export interface RenderBudget {
  tier: 'low' | 'medium' | 'high';
  /** 场景 pass 的渲染缩放。低档先降分辨率，再降效果 —— 分辨率对观感伤害最小。 */
  renderScale: number;
  /** 实际使用的设备像素比 */
  pixelRatio: number;
  fpsCap: number;
  /** 传给着色器的细节档位 0..2，控制噪声倍频数与焦散层数 */
  detail: number;
  bloom: boolean;
  bloomStrength: number;
}

const TIERS: Record<RenderBudget['tier'], Omit<RenderBudget, 'tier' | 'pixelRatio' | 'fpsCap'>> = {
  low: {
    renderScale: 0.62,
    detail: 1,
    bloom: false,
    bloomStrength: 0,
  },
  medium: {
    renderScale: 0.82,
    detail: 1,
    bloom: true,
    bloomStrength: 0.52,
  },
  high: {
    renderScale: 1.0,
    detail: 2,
    bloom: true,
    bloomStrength: 0.52,
  },
};

export function resolveQuality(
  quality: Quality,
  deviceTier: RenderBudget['tier'],
  surface: Pick<SurfaceConfig, 'fpsCap' | 'pixelRatioCap'>,
): RenderBudget {
  const tier = quality === 'auto' ? deviceTier : quality;
  const base = TIERS[tier];

  // 设备像素比上限：视网膜屏上按 DPR=3 渲染一个全屏着色器
  // 意味着 9 倍的像素量，而人眼根本看不出区别。
  const deviceDpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const pixelRatio = Math.max(1, Math.min(deviceDpr, surface.pixelRatioCap));

  return {
    tier,
    ...base,
    pixelRatio,
    fpsCap: surface.fpsCap,
  };
}

/**
 * 渲染尺寸。
 *
 * 注意 `renderScale` 只作用于**场景与辉光的离屏目标**，
 * 最终合成仍然按完整的画布分辨率进行 —— 否则玻璃边缘和颗粒会糊掉，
 * 而这两样恰恰是最需要锐利的地方。
 */
export function sceneResolution(
  cssWidth: number,
  cssHeight: number,
  budget: RenderBudget,
): { width: number; height: number } {
  const w = Math.max(1, Math.floor(cssWidth * budget.pixelRatio * budget.renderScale));
  const h = Math.max(1, Math.floor(cssHeight * budget.pixelRatio * budget.renderScale));
  return { width: w, height: h };
}

export function canvasResolution(
  cssWidth: number,
  cssHeight: number,
  budget: RenderBudget,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(cssWidth * budget.pixelRatio)),
    height: Math.max(1, Math.floor(cssHeight * budget.pixelRatio)),
  };
}
