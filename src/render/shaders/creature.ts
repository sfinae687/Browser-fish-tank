/**
 * 发光生物的着色器。鱼和水母共用。
 *
 * ## 两个 pass 用同一份网格
 *
 *   pass 0  身体：暗色剪影 / 钟体 / 触手 + 发光器
 *   pass 1  光晕：绕轮廓的同心环，加法混合，做出向外溢出的辉光
 *
 * ## 「发光」和「画得亮」的区别
 *
 * 一个物体看起来在发光，需要三件事同时成立：
 *
 *   1. 它**本身比环境亮很多** —— 对比度来自暗色剪影
 *   2. 它有**向外溢出**的光 —— 光晕环负责
 *   3. 溢出部分**颜色偏白** —— 亮到过曝的发光体中心总是趋白
 *
 * 只做第 1 条就是「画得亮」，做完三条才是「在发光」。
 *
 * ## 自发光 vs 被照亮的
 *
 * 这两个必须分开，否则生物会看起来像一块平面的贴纸：
 *
 *   - **自发光**用 `uGlow`（生物自己的颜色）
 *   - **背脊高光**用 `uLight`（从上方来的水光）
 *
 * 背脊上那道冷色的高光给出了形体的转折，是「去掉廉价感」最有效的一笔。
 */

import { MAX_SPINE_POINTS } from '../creature-mesh.js';

export const CREATURE_VS = /* glsl */ `#version 300 es
precision highp float;

in float aSpine;
in vec2  aLocal;
in vec2  aBody;
in vec2  aFlags;
in float aEdge;
in float aKind;

out vec2  vBody;
out vec2  vFlags;
out float vEdge;
out float vKind;

uniform vec4  uTankRect;
uniform vec2  uSpine[${MAX_SPINE_POINTS}];
uniform float uSpineCount;
uniform float uTime;

/** 整体尺寸倍率（配置里的 creatureScale） */
uniform float uSize;
/** 水母伞体的搏动 0..1 */
uniform float uPulse;
/** 触手摆动的幅度（缸内 uv） */
uniform float uSway;

vec2 spineAt(float t) {
  float last = max(1.0, uSpineCount - 1.0);
  float i = clamp(floor(t), 0.0, last - 1.0);
  float f = clamp(t - i, 0.0, 1.0);
  return mix(uSpine[int(i)], uSpine[int(i + 1.0)], f);
}

void main() {
  vec2 p = spineAt(aSpine);

  // 切向用有限差分
  float e = 0.4;
  vec2 tg = spineAt(aSpine + e) - spineAt(max(0.0, aSpine - e));
  float tl = length(tg);
  tg = tl > 1e-7 ? tg / tl : vec2(1.0, 0.0);

  // 法向**强制朝上**（缸内 uv 的 y 向下，所以朝上 = 负 y）。
  // 不强制的话，生物一转身法向就翻，背跑到肚子下面去。
  vec2 n = vec2(-tg.y, tg.x);
  if (n.y > 0.0) n = -n;

  vec2 local = aLocal * uSize;

  // ——————— 按部件类型做各自的形变 ———————
  if (aKind > 0.5 && aKind < 1.5) {
    // 钟体搏动：横向收、纵向略伸 —— 真实水母是收缩伞体排水前进的。
    // 收放比例不对称是有意的：收得狠、放得缓，看起来才像在游。
    local.x *= 1.0 - uPulse * 0.18;
    local.y *= 1.0 + uPulse * 0.07;
  } else if (aKind >= 1.5) {
    // 触手：越靠末端摆得越大，每条相位不同。
    // 整束一起摆会像一块布，各自错开才像触手。
    float t = aSpine / max(1.0, uSpineCount - 1.0);
    float ph = aKind - 2.0;
    local.x += sin(uTime * 1.15 + ph * 1.9 + t * 1.7) * uSway * t * t;
  }

  vec2 world = p + n * local.x + tg * local.y;

  vec2 uv = uTankRect.xy + world * uTankRect.zw;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);

  vBody = aBody;
  vFlags = aFlags;
  vEdge = aEdge;
  vKind = aKind;
}
`;

export const CREATURE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2  vBody;
in vec2  vFlags;
in float vEdge;
in float vKind;
out vec4 fragColor;

/** 0 = 身体，1 = 光晕 */
uniform float uPass;

uniform vec3  uGlow;
/** 鱼身的底色。**必须非常暗** —— 边缘光的对比度全靠它。 */
uniform vec3  uBodyDark;
/** 从上方来的水光颜色。用于背脊高光，和自发光区分开。 */
uniform vec3  uLight;
uniform float uGlowStrength;
uniform float uHaloStrength;
uniform float uOpacity;
uniform float uTime;

/**
 * 解析覆盖率。
 *
 * vEdge 是归一化半径：0 在体轴，1 在轮廓上。轮廓之外没有几何，
 * 所以只靠它做不到「边缘外侧」的覆盖 —— 但可以做到**边缘内侧一像素内的渐变**，
 * 而那一像素正是锯齿的来源。
 *
 * 做法：把「离轮廓还有多远」换算成像素数（用 fwidth），
 * 半像素以内给半透明、一像素以外给全不透明。
 *
 * 这一条是**去掉廉价感最有效的一笔**。没有它，所有轮廓都是硬锯齿，
 * 而锯齿是最典型的「程序员美术」特征。
 *
 * （另外：GLSL 写在 JS 模板字面量里，**注释中不能出现反引号** ——
 *   它会直接截断模板。这个坑踩到第四次了。）
 */
float edgeCoverage(float edge) {
  // 1.6 是过渡宽度（像素）。1.0 太窄 —— 只软化了最外那一列像素，
  // 在放大或高对比的边缘上仍然看得出台阶。
  const float AA_WIDTH = 1.6;
  float w = fwidth(edge);
  return clamp((1.0 - edge) / max(w * AA_WIDTH, 1e-5) + 0.5, 0.0, 1.0);
}

void main() {
  bool isGlow = vFlags.x > 0.5;

  // ——————— 光晕 pass ———————
  if (uPass > 0.5) {
    // 放大之后原本的体表位置丢了，靠 aEdge 反推真实半径：
    //   r = 1  在体表上，r > 1 在体表之外
    float r = vEdge;
    // 别把这个变量叫 out —— 它是 GLSL ES 3.00 的保留字
    float beyond = max(0.0, r - 1.0);
    float falloff = exp(-beyond * 2.0) * exp(-beyond * beyond * 1.1);
    // 水母的光晕要更柔更散：它们是半透明的，光本来就会溢出来
    if (vKind > 0.5) falloff = exp(-beyond * 1.25) * exp(-beyond * beyond * 0.5);
    float a = falloff * uHaloStrength;
    fragColor = vec4(uGlow * a, a * uOpacity);
    return;
  }

  // ——————— 发光器 ———————
  if (isGlow) {
    float amt = vFlags.y;
    // vEdge 在这里是「离光点中心多远」：0 = 中心，1 = 边缘。
    // 用平方衰减做出柔和的光斑，而不是一个硬菱形 ——
    // 发光体没有硬边界，这是它看起来在发光的必要条件之一。
    float d = clamp(vEdge, 0.0, 1.0);
    float core = 1.0 - d * d;
    float soft = core * core;
    // 再叠一层极小的外围光晕，让亮点不至于像贴上去的方块
    soft += smoothstep(1.0, 0.35, d) * 0.22;
    vec3 c = uGlow * (2.6 * amt * soft * uGlowStrength);
    c = mix(c, vec3(1.0), clamp((amt - 0.5) * 0.55 * soft, 0.0, 0.7));
    // 边缘淡出：这里也需要抗锯齿，否则光点会有一圈硬边
    float aa = edgeCoverage(clamp(d, 0.0, 1.0));
    fragColor = vec4(c, clamp(soft, 0.0, 1.0) * uOpacity * mix(1.0, aa, 0.5));
    return;
  }

  // ——————— 水母：钟体 ———————
  if (vKind > 0.5 && vKind < 1.5) {
    float rim = smoothstep(0.45, 1.0, vEdge);
    // 伞缘最亮（真实的发光水母发光器就长在伞缘），伞顶最薄最透
    vec3 c = uGlow * (0.18 + rim * 1.15) * uGlowStrength;
    c = mix(c, vec3(1.0), rim * 0.22);
    // 半透明 —— 水母是「看得穿」的，这一点是它像水母的关键
    float alpha = mix(0.20, 0.62, rim);
    // 抗锯齿：伞缘是这一层里对比度最高的边界，不处理会非常明显
    alpha *= edgeCoverage(clamp(vEdge, 0.0, 1.0));
    fragColor = vec4(c, alpha * uOpacity);
    return;
  }

  // ——————— 水母：触手 ———————
  if (vKind >= 1.5) {
    // vBody.y 在触手上是「横向位置」：-1 左缘 / 0 中线 / +1 右缘。
    // 用它做一维抗锯齿 —— 细带子的锯齿比身体更扎眼。
    float across = abs(clamp(vBody.y, -1.0, 1.0));
    float w = fwidth(vBody.y);
    float aa = clamp((1.0 - across) / max(w, 1e-5) + 0.5, 0.0, 1.0);
    vec3 c = uGlow * 0.55 * uGlowStrength;
    fragColor = vec4(c, 0.42 * uOpacity * aa);
    return;
  }

  // ——————— 鱼 ———————
  float u = vBody.x;
  float v = clamp(vBody.y, -1.0, 1.0);

  // 鳍：按建模时烘进来的量各自发光。没有这一项鳍是全黑的。
  float fin = vFlags.y;
  if (fin > 0.02 && abs(vBody.y) > 1.05) {
    vec3 fc = uGlow * fin * uGlowStrength * 0.62;
    fc *= 0.55 + 0.5 * smoothstep(0.35, 1.0, vEdge);
    // 鳍根要**淡出到 0**，不能一上来就是 0.3 的不透明度 ——
    // 那会在鳍和身体的交界处留下一条看得见的硬边，
    // 放大看就是「几块多边形贴在一起」的感觉。
    float root = smoothstep(0.02, 0.30, fin);
    // 鳍尖也收一点，免得像被剪断
    float tip = 1.0 - smoothstep(0.75, 1.0, vEdge) * 0.0;
    float a = mix(0.30, 0.58, fin) * root * tip * edgeCoverage(clamp(vEdge, 0.0, 1.0));
    fragColor = vec4(fc, a * uOpacity);
    return;
  }

  // 腹面发光：**贴着下缘的一条窄带**，不能是整个下半身 ——
  // 用 v 直接做渐变会把半个身体点亮，生物就从「暗剪影 + 亮点」
  // 变成一块发光的色斑。
  //
  // 注意 smoothstep(e0, e1, x) 要求 e0 < e1，反着写是未定义行为。
  float belly = smoothstep(0.72, 1.0, -v) * 0.50;
  // 头部比尾部亮一点 —— 感觉器官与发光器集中在头部
  float front = smoothstep(0.30, 0.0, u) * 0.16;

  // 身体的基础明暗：**背亮腹暗**，中间连续过渡。
  //
  // 少了这一层，身体内部是一块均匀的黑，于是背脊高光看起来就是
  // 「一条贴在黑块上的亮带子」而不是「圆柱受光」—— 廉价感的一大来源。
  // 有了它，剪影内部才有体积。
  float shade = 0.42 + 0.58 * smoothstep(-1.0, 1.0, v);
  vec3 col = uBodyDark * (0.45 + 1.15 * shade);

  col += uGlow * (belly + front) * uGlowStrength * 0.32;

  // 自发光 + 被照亮，分开算：
  // 轮廓上的窄亮边（自发光）
  col += uGlow * smoothstep(0.80, 1.0, vEdge) * uGlowStrength * 0.40;
  // 背脊高光（从上方来的水光）—— 这一笔给出形体的转折
  // 背脊高光（从上方来的水光）—— 这一笔给出形体的转折。
  //
  // ⚠️ 过渡区间要**够宽**。第一版用的是 smoothstep(0.05, 0.85, v)，
  // 在放大看时是一条边界清晰的色带 —— 那是「贴纸」而不是「形体」。
  // 真实的光照在圆柱形的身体上是余弦式的连续过渡。
  float back = smoothstep(-0.25, 1.0, v);
  col += uLight * back * back * 0.95 * uGlowStrength;
  // 腹面也有一点微弱的环境反射，让剪影不至于下半截纯黑
  col += uLight * smoothstep(-0.35, -0.95, v) * 0.16 * uGlowStrength;

  // 轮廓抗锯齿 —— 见 edgeCoverage 的说明
  float cov = edgeCoverage(clamp(vEdge, 0.0, 1.0));
  fragColor = vec4(col, cov * uOpacity);
}
`;
