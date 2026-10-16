/**
 * 共享 GLSL 函数库。
 *
 * 所有 pass 都拼上这一段。里面的每个函数都是为了「看起来是对的」
 * 而挑的，不是随手抓的噪声 —— 逐条注明来源意图。
 */

export const COMMON_GLSL = /* glsl */ `
#define PI  3.141592653589793
#define TAU 6.283185307179586

/**
 * 反向 smoothstep：x <= e1 时为 1，x >= e0 时为 0（要求 e0 > e1）。
 *
 * 存在的理由：GLSL 规范明说 smoothstep(e0, e1, x) 在 e0 >= e1 时
 * **结果未定义**。我们有好几处需要「向上衰减」的遮罩，
 * 直接调换参数在多数驱动上碰巧能跑，但结果可能因显卡而异 ——
 * 对一个以「同种子必须得到同一缸」为根基的项目，这是不能接受的。
 */
float sstepDown(float e0, float e1, float x) {
  return 1.0 - smoothstep(e1, e0, x);
}

// ————————————————————————————————————————————————————————————
// 哈希
// ————————————————————————————————————————————————————————————

/**
 * 便宜的 2D -> 1D 哈希。
 * 常数经过挑选，在 UV 尺度到 1e3 量级时不会出现明显的轴向条纹。
 */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash23(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// ————————————————————————————————————————————————————————————
// 噪声
// ————————————————————————————————————————————————————————————

/** 值噪声，用 smoothstep 做双线性插值。比梯度噪声便宜，对水介质足够。 */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * 分形叠加噪声。
 *
 * 每层乘一个旋转矩阵再缩放 —— 不加旋转的话，所有倍频的网格对齐，
 * 会看到明显的十字形伪影，这是 fbm 最常见的翻车点。
 */
float fbm(vec2 p, int octaves) {
  float v = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < octaves; i++) {
    v += amp * vnoise(p);
    norm += amp;
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return norm > 0.0 ? v / norm : 0.0;
}

/** 域扭曲：用噪声去偏移采样坐标，得到流动、丝缕状的形态。 */
float warpedFbm(vec2 p, float t, int octaves) {
  vec2 q = vec2(
    fbm(p + vec2(0.0, t * 0.05), 2),
    fbm(p + vec2(5.2, 1.3) - vec2(0.0, t * 0.04), 2)
  );
  return fbm(p + 2.4 * q, octaves);
}

// ————————————————————————————————————————————————————————————
// 焦散
// ————————————————————————————————————————————————————————————

/**
 * 焦散的物理直觉：水面的波纹起透镜作用，把光**聚焦**成细亮的线。
 * 聚焦处对应波面曲率的极值点，也就是某个高度场的**脊线**。
 *
 * 所以焦散 = 1 - |梯度|，再取高次幂压出细线。
 * 这比直接拿噪声当焦散像得多 —— 噪声是块状的，焦散是线状的。
 */
float causticRidge(vec2 p, int octaves) {
  float e = 0.035;
  float n  = fbm(p, octaves);
  float nx = fbm(p + vec2(e, 0.0), octaves);
  float ny = fbm(p + vec2(0.0, e), octaves);
  vec2 g = vec2(nx - n, ny - n) / e;
  float ridge = 1.0 - clamp(length(g) * 0.22, 0.0, 1.0);
  return pow(ridge, 8.0);
}

/**
 * 经典的水底光网：扭曲网格 + 到最近格点的距离。
 * 与脊线叠加后，一个给「线」一个给「网」，合起来才是真实焦散的样子。
 */
float causticNet(vec2 p, float t) {
  p += 0.35 * vec2(
    fbm(p + vec2(t * 0.05, 0.0), 2),
    fbm(p - vec2(0.0, t * 0.04) + 9.1, 2)
  );
  vec2 i = floor(p);
  vec2 f = fract(p);
  float md = 1e9;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(i + g);
      vec2 r = g + o - f;
      md = min(md, dot(r, r));
    }
  }
  return sstepDown(0.32, 0.0, sqrt(md));
}

float caustics(vec2 uv, float t, int detail) {
  // 两层不同尺度、不同漂移方向。只做一层的话，一眼看出是同一个图案在平移。
  float a = causticRidge(uv * 5.0 + vec2(t * 0.05, -t * 0.035), 3);
  float b = causticRidge(uv * 9.3 + vec2(-t * 0.04, t * 0.055) + 17.3, 3);
  float line = a * 0.72 + b * 0.5 + a * b * 0.85;

  if (detail < 1) return line;

  float net = causticNet(uv * 4.0 + vec2(t * 0.02, -t * 0.015), t);
  return line + net * 0.55 * (1.0 - clamp(line, 0.0, 1.0));
}

// ————————————————————————————————————————————————————————————
// 几何
// ————————————————————————————————————————————————————————————

/**
 * 二维圆角矩形的有符号距离。几何景观的基本积木。
 * 返回负值表示在形状内部，绝对值是到边界的距离。
 */
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// ————————————————————————————————————————————————————————————
// 失焦光斑
// ————————————————————————————————————————————————————————————

/**
 * 大而软的 bokeh。
 *
 * 「梦幻」这个观感里性价比最高的一个元素就是它 —— 而且它**物理上说得通**：
 * 真实镜头失焦时点光源会散成柔和的正圆，水里本来就有无数被照亮的悬浮微粒，
 * 所以它不是硬贴上去的效果，是这缸水本来就该有的东西。
 *
 * 与 marineSnow 的区别：那个是「看得清的细小颗粒」，这个是「看不清的柔和光团」。
 * 两者叠在一起，画面的景深就出来了。
 */
float bokehField(vec2 uv, float t, float density, float seed) {
  float acc = 0.0;
  vec2 p = uv * density;
  // 极缓慢的整体漂移，加上按行错开的横向摆动 ——
  // 完全同向的平移看起来像贴图在滑，错开之后才像水在动
  p.y -= t * 0.045;
  p.x += 0.10 * sin(t * 0.06 + floor(p.y) * 1.7);

  vec2 i = floor(p);
  vec2 f = fract(p);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = i + g + seed;
      vec2 o = hash22(cell);
      vec2 r = g + o - f;
      float d = length(r);
      float radius = 0.12 + 0.28 * hash21(cell + 7.3);
      // 软盘：中心亮，边缘平滑消失。平方一次让芯更集中。
      float disc = sstepDown(radius, radius * 0.10, d);
      acc += disc * disc * (0.30 + 0.70 * hash21(cell + 2.1));
    }
  }
  return acc;
}

// ————————————————————————————————————————————————————————————
// 水下悬浮物 / 光柱
// ————————————————————————————————————————————————————————————

/**
 * 「海雪」——水族箱里永远飘着的那层细小碎屑。
 * 它本身几乎看不见，但**没有它水体就显得是空的**。
 * 用抖动网格采 3x3 邻域，避免逐粒子循环。
 */
float marineSnow(vec2 uv, float t, float density, float seed, float sizeScale) {
  float acc = 0.0;
  vec2 p = uv * density;
  p.y -= t * 0.35; // 缓慢下沉
  vec2 i = floor(p);
  vec2 f = fract(p);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = i + g + seed;
      vec2 o = hash22(cell);
      vec2 r = g + o - f;
      float d = length(r);
      float sz = (0.012 + 0.05 * hash21(cell + 3.7)) * sizeScale;
      // 用亮度而非硬边，模拟失焦的小颗粒
      acc += sstepDown(sz, 0.0, d) * (0.35 + 0.65 * hash21(cell + 11.1));
    }
  }
  return acc;
}

/**
 * 水下光柱。
 *
 * **不要**在极坐标里对角度做噪声来「从光源放射」—— 角度域上噪声的周期
 * 会变成一圈硬边的扇形花瓣，看起来像风扇而不是光。真实水下光柱是
 * 水面波纹把阳光折射后形成的**一组近乎平行的光轴**。
 *
 * 正确做法：在垂直于光方向的坐标上做一维噪声，得到条带；
 * 越深越弱，并在横向缓慢漂移模拟水面晃动。
 */
float lightShafts(vec2 uv, float t, vec2 lightDir) {
  // 把坐标投影到「垂直于光方向」的轴上 —— 光轴沿这个轴分布
  vec2 n = normalize(vec2(-lightDir.y, lightDir.x) + vec2(1e-5));
  float perp = dot(uv, n);

  // 两层不同粗细的条带。粗的一层决定光柱形态，细的一层加细节。
  float coarse = fbm(vec2(perp * 2.6, uv.y * 0.35 - t * 0.05), 3);
  float fine = fbm(vec2(perp * 8.0 + 31.7, uv.y * 0.9 - t * 0.11), 3);
  float shaft = clamp(coarse * 0.78 + fine * 0.34, 0.0, 1.0);

  // 只有亮部才是光柱，暗部就是普通的水
  shaft = pow(shaft, 3.0);

  // 越深越弱，且要随水面晃动整体横向漂移
  float drift = 0.05 * sin(t * 0.13 + uv.y * 1.7);
  shaft *= exp(-uv.y * 2.1) * (0.6 + 0.4 * cos(perp * 5.0 + drift * 6.0));

  return max(shaft, 0.0);
}

// ————————————————————————————————————————————————————————————
// 杂项
// ————————————————————————————————————————————————————————————

/** 水面的低频波高，用于水线处的起伏。 */
float surfaceWave(vec2 uv, float t) {
  float w = 0.0;
  w += 0.50 * sin(uv.x * 11.0 + t * 0.9);
  w += 0.28 * sin(uv.x * 23.0 - t * 1.4 + 1.7);
  w += 0.14 * sin(uv.x * 47.0 + t * 2.1 + 4.2);
  return w * 0.5 + 0.5;
}


/** 把 sRGB 输入当作近似线性处理，做一次便宜的提亮/压暗。 */
vec3 contrast(vec3 c, float amount) {
  return clamp((c - 0.5) * amount + 0.5, 0.0, 1.0);
}

vec3 saturateColor(vec3 c, float amount) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3(l), c, amount), 0.0, 1.0);
}
`;
