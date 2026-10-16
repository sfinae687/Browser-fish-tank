/**
 * 主题与调色板。
 *
 * 调色板不只是五个预设 —— 每个主题还会被种子**再生成一次**：
 * 色相轻微旋转、饱和度与明度扰动。所以同一套 `reef` 主题，
 * 不同种子会长出不一样的珊瑚色与水体色，但仍然一眼认得出是 `reef`。
 *
 * 「连调色板也是算出来的。」
 */

import { Rng, hashString } from './rng.js';

export type ThemeName = 'reef' | 'planted' | 'blackwater' | 'lagoon' | 'abyss';

export const THEME_NAMES: readonly ThemeName[] = [
  'reef',
  'planted',
  'blackwater',
  'lagoon',
  'abyss',
];

export const THEME_LABELS: Record<ThemeName, string> = {
  reef: '珊瑚礁 · 明亮热带',
  planted: '水草造景 · 淡水绿',
  blackwater: '黑水 · 茶色幽暗',
  lagoon: '泻湖 · 青绿通透',
  abyss: '深渊 · 冷蓝夜行',
};

export type RGB = readonly [number, number, number];

export interface Palette {
  theme: ThemeName;
  /** 水体顶端颜色 */
  waterTop: RGB;
  /** 水体底端颜色 */
  waterBottom: RGB;
  /** 远景水雾，向它收敛 */
  fog: RGB;
  /** 主光源颜色 */
  light: RGB;
  /** 焦散高光颜色 */
  caustic: RGB;
  /** 底砂亮部 / 暗部 */
  substrate: RGB;
  substrateDark: RGB;
  /** 玻璃色调（真实缸玻璃断面是绿的） */
  glassTint: RGB;
  /** UI 强调色 */
  accent: RGB;
  /** 环境光强度 0..1 */
  ambient: number;
  /** 水体浑浊度 0..1，影响远景衰减速度 */
  turbidity: number;
}

type PaletteSpec = Omit<Palette, 'theme'>;

/**
 * 各主题的基调。
 *
 * 美术方向是**几何光影 · 梦幻**，不是写实水族摄影。所以这里刻意不追求
 * 「真实水体是暗的」——水是发光的介质，颜色可以亮、可以偏、可以甜。
 * 层次靠光（体积光、焦散、辉光、光斑）来拉开，而不是靠压暗。
 *
 * 这些数值直接进着色器相加再经 tonemap 输出，属于**显示空间**。
 * 唯一的硬约束是别让大面积亮部把画面重心抢走 —— 那靠的是渐变层次，
 * 不是把整体调暗。
 */
const SPECS: Record<ThemeName, PaletteSpec> = {
  reef: {
    // 浅梦：青蓝的水 + 珊瑚粉的点缀
    waterTop: [0.138, 0.276, 0.322],
    waterBottom: [0.031, 0.088, 0.158],
    fog: [0.120, 0.212, 0.276],
    light: [1.0, 0.98, 0.93],
    caustic: [0.88, 1.0, 1.0],
    substrate: [0.336, 0.300, 0.276],
    substrateDark: [0.139, 0.116, 0.151],
    glassTint: [0.64, 0.86, 0.82],
    accent: [1.0, 0.55, 0.46],
    ambient: 1.0,
    turbidity: 0.26,
  },
  planted: {
    // 青苔：鼠尾草绿 + 暖砂
    waterTop: [0.156, 0.285, 0.239],
    waterBottom: [0.031, 0.097, 0.088],
    fog: [0.120, 0.212, 0.175],
    light: [1.0, 0.99, 0.90],
    caustic: [0.86, 0.98, 0.84],
    substrate: [0.312, 0.264, 0.192],
    substrateDark: [0.104, 0.128, 0.093],
    glassTint: [0.58, 0.82, 0.68],
    accent: [1.0, 0.80, 0.54],
    ambient: 0.96,
    turbidity: 0.30,
  },
  blackwater: {
    // 琥珀：暖橙棕 + 玫瑰
    waterTop: [0.267, 0.184, 0.120],
    waterBottom: [0.044, 0.022, 0.018],
    fog: [0.166, 0.110, 0.074],
    light: [1.0, 0.90, 0.74],
    caustic: [1.0, 0.86, 0.60],
    substrate: [0.264, 0.192, 0.132],
    substrateDark: [0.087, 0.052, 0.046],
    glassTint: [0.60, 0.62, 0.50],
    accent: [1.0, 0.54, 0.62],
    ambient: 0.72,
    turbidity: 0.46,
  },
  lagoon: {
    // 薄荷：通透的绿松石 + 奶油
    waterTop: [0.156, 0.313, 0.285],
    waterBottom: [0.031, 0.114, 0.141],
    fog: [0.110, 0.239, 0.239],
    light: [1.0, 1.0, 0.96],
    caustic: [0.80, 1.0, 1.0],
    substrate: [0.360, 0.336, 0.276],
    substrateDark: [0.128, 0.151, 0.162],
    glassTint: [0.60, 0.88, 0.80],
    accent: [1.0, 0.86, 0.62],
    ambient: 1.0,
    turbidity: 0.18,
  },
  abyss: {
    // 夜蓝：靛蓝 + 紫的幽光
    waterTop: [0.092, 0.110, 0.267],
    waterBottom: [0.011, 0.013, 0.062],
    fog: [0.064, 0.074, 0.193],
    light: [0.86, 0.90, 1.0],
    caustic: [0.62, 0.76, 1.0],
    substrate: [0.180, 0.192, 0.288],
    substrateDark: [0.041, 0.046, 0.104],
    glassTint: [0.50, 0.58, 0.82],
    accent: [0.82, 0.58, 1.0],
    ambient: 0.62,
    turbidity: 0.38,
  },
};

// —— 颜色工具（在 HSL 空间操作，因为「扰动色相」在 RGB 里很别扭） ——

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function tint(c: RGB, [dh, ds, dl]: [number, number, number]): RGB {
  const [h, s, l] = rgbToHsl(c);
  return hslToRgb([
    (h + dh + 1) % 1,
    Math.min(1, Math.max(0, s * (1 + ds))),
    Math.min(1, Math.max(0, l * (1 + dl))),
  ]);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * 按种子生成这个主题的具体调色板。
 *
 * 同一主题 + 同一种子 → 完全一致；换种子 → 水体色相漂移几度、
 * 饱和度与明度各自扰动，得到「同一片海的不同角落」。
 */
export function paletteFor(theme: ThemeName, seed: string): Palette {
  const spec = SPECS[theme] ?? SPECS.reef;
  const rng = Rng.fromSeed(seed).stream(`palette.${theme}`);

  // 水体整体色相漂移 ±4%，饱和度 ±12%，明度 ±7%
  const waterShift: [number, number, number] = [
    rng.range(-0.04, 0.04),
    rng.range(-0.12, 0.12),
    rng.range(-0.07, 0.07),
  ];
  // 光源与焦散只做很小扰动，避免偏色到不像灯
  const lightShift: [number, number, number] = [
    rng.range(-0.02, 0.02),
    rng.range(-0.06, 0.06),
    rng.range(-0.03, 0.03),
  ];
  // 底砂单独扰动：同一主题下有的偏暖有的偏灰
  const sandShift: [number, number, number] = [
    rng.range(-0.03, 0.03),
    rng.range(-0.1, 0.1),
    rng.range(-0.08, 0.08),
  ];

  const ambient = clamp01(spec.ambient * rng.jitter(0.06));
  const turbidity = clamp01(spec.turbidity * rng.jitter(0.15));

  return {
    theme,
    waterTop: tint(spec.waterTop, waterShift),
    waterBottom: tint(spec.waterBottom, waterShift),
    fog: tint(spec.fog, waterShift),
    light: tint(spec.light, lightShift),
    caustic: tint(spec.caustic, lightShift),
    substrate: tint(spec.substrate, sandShift),
    substrateDark: tint(spec.substrateDark, sandShift),
    glassTint: spec.glassTint,
    accent: spec.accent,
    ambient,
    turbidity,
  };
}

/** 把 RGB 元组展平成着色器 uniform 用的数组。 */
export function flatten(c: RGB): [number, number, number] {
  return [c[0], c[1], c[2]];
}

/** 供 CSS 使用的十六进制色。 */
export function cssColor(c: RGB): string {
  const to255 = (x: number) => Math.round(clamp01(x) * 255);
  return `rgb(${to255(c[0])} ${to255(c[1])} ${to255(c[2])})`;
}

/** 主题的稳定数值 id，方便传给着色器。 */
export function themeId(theme: ThemeName): number {
  return hashString(theme) % 1000;
}
