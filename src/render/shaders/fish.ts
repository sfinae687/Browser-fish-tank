/**
 * 鱼的着色器。
 *
 * 这是全项目第一处**顶点管线**。植物用的是「烘焙成纹理」，因为它们的形态
 * 生成一次就不变了；而鱼**每帧都在变形**，烘焙这条路对它们不成立。
 *
 * 分工：
 *   - 网格的**局部形状**（体高剖面、各鳍的轮廓）在 CPU 上按基因组算好，一次
 *   - **脊柱动画**在顶点着色器里做：CPU 每帧只上传 10 来个个脊柱点作为
 *     uniform，网格本身不动
 *
 * 这样 CPU 每帧的工作量与顶点数无关，只与鱼的条数有关。
 */

/**
 * 顶点属性：
 *   aSpine  脊柱参数 t ∈ [0, 段数]
 *   aLocal  相对脊柱点的偏移（法向, 切向），缸内 uv
 *   aBody   体坐标 (u 沿体长 0..1, v 横向 +1 背 / −1 腹)，供片元着色
 *   aFlags  (是否鳍, 色调混合)
 */
export const FISH_VERTEX_LAYOUT = [
  { name: 'aSpine', size: 1 },
  { name: 'aLocal', size: 2 },
  { name: 'aBody', size: 2 },
  { name: 'aFlags', size: 2 },
] as const;

/** 脊柱点的上限。基因组的 spineSegments 上限是 18，留些余量。 */
export const MAX_SPINE_POINTS = 24;

export const FISH_VS = /* glsl */ `#version 300 es
precision highp float;

in float aSpine;
in vec2  aLocal;
in vec2  aBody;
in vec2  aFlags;

out vec2 vBody;
out vec2 vFlags;

uniform vec4  uTankRect;
/** 这一帧这条鱼的脊柱点（缸内 uv） */
uniform vec2  uSpine[${MAX_SPINE_POINTS}];
uniform float uSpineCount;

vec2 spineAt(float t) {
  float last = max(1.0, uSpineCount - 1.0);
  float i = clamp(floor(t), 0.0, last - 1.0);
  float f = clamp(t - i, 0.0, 1.0);
  vec2 a = uSpine[int(i)];
  vec2 b = uSpine[int(i + 1.0)];
  return mix(a, b, f);
}

void main() {
  vec2 p = spineAt(aSpine);

  // 切向用有限差分。e 取小一点，弯曲处才不会把切向抹平。
  float e = 0.4;
  vec2 p0 = spineAt(max(0.0, aSpine - e));
  vec2 p1 = spineAt(aSpine + e);
  vec2 tg = p1 - p0;
  float tl = length(tg);
  tg = tl > 1e-7 ? tg / tl : vec2(1.0, 0.0);

  // ⚠️ 法向必须**强制朝上**（缸内 uv 的 y 向下，所以朝上 = 负 y）。
  // 直接用 (-tg.y, tg.x) 的话，鱼一转身法向就跟着翻，
  // 它的背会跑到肚子下面去 —— 一条倒着游的鱼。
  vec2 n = vec2(-tg.y, tg.x);
  if (n.y > 0.0) n = -n;

  vec2 world = p + n * aLocal.x + tg * aLocal.y;

  // 缸内 uv → 裁剪空间（y 向下 → y 向上）
  vec2 uv = uTankRect.xy + world * uTankRect.zw;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);

  vBody = aBody;
  vFlags = aFlags;
}
`;

export const FISH_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vBody;
in vec2 vFlags;
out vec4 fragColor;

uniform vec3  uColorBack;
uniform vec3  uColorBelly;
uniform vec3  uFinColor;
uniform vec3  uLight;
uniform vec3  uFog;

uniform float uStripeFreq;
uniform float uStripeSharp;
uniform float uFinAlpha;
uniform float uEyePos;
uniform float uEyeRadius;
uniform float uDaylight;
uniform float uDepthFog;
uniform float uOpacity;
/** 活力 0..1（能量 / 上限）。饿着的鱼发灰发暗。 */
uniform float uVitality;
/** 腐坏 0..1。尸体更灰、更透明。 */
uniform float uDecay;

void main() {
  float u = vBody.x;
  float v = vBody.y; // +1 背，−1 腹
  bool isFin = vFlags.x > 0.5;

  // 背深腹浅 —— 这是鱼最普遍的一条配色规律，也是水下伪装的基本原理：
  // 从上看下去肚子和天光混在一起，从下往上看背和河底混在一起。
  vec3 base = mix(uColorBelly, uColorBack, smoothstep(-1.0, 0.75, v));

  // ——— 条纹 ———
  if (!isFin && uStripeFreq > 0.05) {
    float s = sin(u * uStripeFreq * 6.2831853) * 0.5 + 0.5;
    // sharp 越大条纹越细、越像竖线而不是渐变
    s = pow(s, mix(1.0, 5.0, uStripeSharp));
    base = mix(base, base * 1.55 + 0.015, s * 0.45);
  }

  // ——— 眼睛 ———
  // 用体坐标算而不是建几何：省三角形，而且随便怎么变形都贴着身体
  if (!isFin) {
    vec2 e = vec2((u - uEyePos) / max(0.004, uEyeRadius), (v - 0.45) / max(0.004, uEyeRadius * 1.5));
    float ed = length(e);
    if (ed < 1.35) {
      base = mix(vec3(0.035, 0.04, 0.055), base, smoothstep(0.58, 1.0, ed));
      // 一点高光，眼睛立刻有神
      base += vec3(1.0) * smoothstep(0.26, 0.0, length(e - vec2(-0.32, -0.32))) * 0.55;
    }
  }

  // ——— 鳍 ———
  float alpha = 1.0;
  if (isFin) {
    base = mix(base, uFinColor, 0.78);
    alpha = uFinAlpha;
    // 鳍条：细密的放射纹。没有它鳍就是一块塑料片。
    float rib = sin(u * 58.0 + v * 7.0) * 0.5 + 0.5;
    base *= 0.88 + 0.24 * rib;
  }

  // ——— 生态状态 ———
  // 这是「模拟真的影响画面」最直接的一处：不用看 HUD，
  // 一眼就能看出这一缸过得怎么样。
  // 活力低 → 去饱和、压暗；正在腐坏 → 进一步发灰并变透明。
  float desat = clamp((1.0 - uVitality) * 0.75 + uDecay * 0.55, 0.0, 1.0);
  float grey = dot(base, vec3(0.2126, 0.7152, 0.0722));
  base = mix(base, vec3(grey) * 0.85, desat);
  base *= mix(1.0, 0.72, clamp(1.0 - uVitality, 0.0, 1.0) * 0.8);
  alpha *= mix(1.0, 0.55, uDecay);

  // ——— 光照与水体衰减 ———
  base *= mix(0.60, 1.20, uDaylight);
  // 背脊高光：光从上面来
  base += uLight * smoothstep(0.45, 1.0, v) * (isFin ? 0.04 : 0.12) * uDaylight;
  base = mix(base, uFog, clamp(uDepthFog, 0.0, 1.0));

  fragColor = vec4(base, alpha * uOpacity);
}
`;
