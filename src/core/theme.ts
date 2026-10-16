/**
 * 深色调色板。
 *
 * ## 和上一版最大的区别：亮度不是靠「白」堆出来的
 *
 * 上一版是白天鱼缸：水体亮、底砂亮、什么都亮，最后全靠对比度撑画面，
 * 于是任何一点细节都在抢注意力。
 *
 * 这一版是深海：**画面里 90% 的像素接近黑色**，亮度只从两个地方来 ——
 * 水面上方那一点点冷光，和生物自己的辉光。于是：
 *
 *   - 生物成了唯一的视觉焦点，不需要靠饱和度去争
 *   - 「亮」变成了稀缺资源，少数几个亮点就足够撑住整个画面
 *   - 辉光（bloom）从「润色」变成了**主要的造型手段**
 *
 * ## 颜色之间的关系
 *
 * 水体永远是冷色（青 / 蓝），辉光永远比水体亮且更饱和。
 * 这个「冷底 + 亮点」的关系是整套配色唯一的硬规则 ——
 * 打破它（比如水体也发暖光）画面立刻会脏。
 *
 * 另外：**不再根据种子做色相偏移**。深海的美感来自克制，
 * 随机化色相只会让每只生物各自为政。种子的作用降级为
 * 「决定生物长什么样、在哪里」，不再决定颜色。
 *
 * @see DESIGN.md §2
 */

export type RGB = readonly [number, number, number];

export type ThemeName = 'abyss' | 'vent' | 'aurora' | 'moonlit';

export interface Palette {
  theme: ThemeName;
  /** 水体顶端（靠近水面，是画面里唯一「亮」的背景区域） */
  waterTop: RGB;
  /** 水体深处。**接近纯黑，这是整个画面面积最大的一块颜色。** */
  waterDeep: RGB;
  /** 上方透下来的光池与光柱 */
  light: RGB;
  /** 水面焦散的高光 */
  caustic: RGB;
  /** 发光生物的主辉光色 */
  glow: RGB;
  /** 少数生物用的点缀辉光色 —— 一缸里有一两只异色才不单调 */
  glowAlt: RGB;
  /** 玻璃 / 边框色调 */
  glassTint: RGB;
  /** UI 强调色 */
  accent: RGB;
  /** 环境光强度 0..1。深海应当很低。 */
  ambient: number;
  /** 水体浑浊度 0..1，影响远景衰减速度 */
  turbidity: number;
  /** 辉光强度倍率。深海场景里这是造型手段，不只是润色。 */
  bloom: number;
}

export const THEME_NAMES: readonly ThemeName[] = ['abyss', 'vent', 'aurora', 'moonlit'];

export const THEME_LABELS: Record<ThemeName, string> = {
  abyss: '深渊 · 近黑水体青辉光',
  vent: '热泉 · 黑水琥珀色',
  aurora: '极光 · 黑水绿紫',
  moonlit: '月夜 · 银蓝（最亮的一档）',
};

/**
 * 四个主题。
 *
 * 差别刻意做得很小 —— 都在「近黑水体 + 冷光 + 发光生物」这个框架内，
 * 只是光色和辉光色不同。主题的作用是换气氛，不是换风格。
 */
export const THEMES: Record<ThemeName, Palette> = {
  // 最经典的深海。近黑的水，青色辉光，一两只暖色点缀。
  abyss: {
    theme: 'abyss',
    waterTop: [0.020, 0.058, 0.082],
    waterDeep: [0.002, 0.006, 0.012],
    light: [0.34, 0.62, 0.72],
    caustic: [0.30, 0.68, 0.78],
    glow: [0.22, 0.86, 0.90],
    glowAlt: [0.96, 0.62, 0.34],
    glassTint: [0.06, 0.2, 0.2],
    accent: [0.45, 0.88, 0.92],
    ambient: 0.34,
    turbidity: 0.3,
    bloom: 1.0,
  },

  // 黑水 + 热液口的琥珀色。暖色调的深海，比较少见。
  vent: {
    theme: 'vent',
    waterTop: [0.04, 0.028, 0.026],
    waterDeep: [0.007, 0.004, 0.004],
    light: [0.7, 0.42, 0.24],
    caustic: [0.82, 0.5, 0.24],
    glow: [1.0, 0.58, 0.24],
    glowAlt: [0.42, 0.86, 0.72],
    glassTint: [0.2, 0.12, 0.07],
    accent: [1.0, 0.66, 0.34],
    ambient: 0.3,
    turbidity: 0.46,
    bloom: 1.15,
  },

  // 黑水 + 高空绿紫。冷调里带一点紫，适合深夜。
  aurora: {
    theme: 'aurora',
    waterTop: [0.016, 0.04, 0.062],
    waterDeep: [0.002, 0.005, 0.014],
    light: [0.3, 0.66, 0.58],
    caustic: [0.36, 0.74, 0.64],
    glow: [0.34, 0.94, 0.68],
    glowAlt: [0.66, 0.52, 0.98],
    glassTint: [0.08, 0.16, 0.2],
    accent: [0.52, 0.94, 0.74],
    ambient: 0.32,
    turbidity: 0.26,
    bloom: 1.1,
  },

  // 唯一稍微亮一点的一档。银色光，适合不喜欢太暗的人。
  moonlit: {
    theme: 'moonlit',
    waterTop: [0.052, 0.078, 0.104],
    waterDeep: [0.008, 0.014, 0.024],
    light: [0.62, 0.74, 0.86],
    caustic: [0.56, 0.7, 0.84],
    glow: [0.7, 0.88, 1.0],
    glowAlt: [0.94, 0.76, 0.56],
    glassTint: [0.12, 0.16, 0.22],
    accent: [0.76, 0.88, 1.0],
    ambient: 0.46,
    turbidity: 0.34,
    bloom: 0.85,
  },
};

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && v in THEMES;
}

export function paletteFor(theme: ThemeName): Palette {
  return THEMES[theme] ?? (THEMES.abyss as Palette);
}

/** 供 CSS 用：把调色板里的关键色转成 `rgb()` 字符串。 */
export function cssVars(p: Palette): Record<string, string> {
  const rgb = (c: RGB): string =>
    `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;
  return {
    '--glow': rgb(p.glow),
    '--accent': rgb(p.accent),
    '--deep': rgb(p.waterDeep),
  };
}
