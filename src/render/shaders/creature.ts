/**
 * 发光生物的着色器。
 *
 * ## 两个 pass 用同一份网格
 *
 *   pass 0  身体：暗色剪影 + 边缘光 + 发光器
 *   pass 1  光晕：网格放大后加法混合，做出「真的在发光」的外扩辉光
 *
 * 用同一个网格、只换一个 uniform，比建两套几何简单得多，
 * 而且光晕天然和身体形状一致 —— 这是这套做法最大的好处。
 *
 * ## 「发光」和「画得亮」的区别
 *
 * 一个物体看起来在发光，需要三件事同时成立：
 *
 *   1. 它**本身比环境亮很多**（边缘光 + 发光器，对比度来自暗色身体）
 *   2. 它有**向外溢出**的光（光晕 pass）
 *   3. 溢出部分**颜色偏白**（亮到过曝的发光体中心总是趋白）
 *
 * 只做第 1 条就是「画得亮」，做完三条才是「在发光」。
 * 第 3 条最容易被忽略，但它是关键 —— 见 FS 里往白色混合的那一步。
 */

import { MAX_SPINE_POINTS } from '../creature-mesh.js';

export const CREATURE_VS = /* glsl */ `#version 300 es
precision highp float;

in float aSpine;
in vec2  aLocal;
in vec2  aBody;
in vec2  aFlags;
in float aEdge;

out vec2  vBody;
out vec2  vFlags;
out float vEdge;

uniform vec4  uTankRect;
/** 这一帧这只生物的脊柱点（缸内 uv） */
uniform vec2  uSpine[${MAX_SPINE_POINTS}];
uniform float uSpineCount;
/** 光晕 pass 把网格整体放大这个倍数 */
uniform float uHaloScale;
/** 摆尾的相位 */
uniform float uBeat;
/** 摆尾振幅（缸内 uv） */
uniform float uAmp;

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

  // 光晕 pass：整体向外撑开
  vec2 local = aLocal * uHaloScale;

  vec2 world = p + n * local.x + tg * local.y;

  vec2 uv = uTankRect.xy + world * uTankRect.zw;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);

  vBody = aBody;
  vFlags = aFlags;
  vEdge = aEdge;
}
`;

export const CREATURE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2  vBody;
in vec2  vFlags;
in float vEdge;
out vec4 fragColor;

/** 0 = 身体，1 = 光晕 */
uniform float uPass;

uniform vec3  uGlow;
/** 身体底色。**必须非常暗** —— 边缘光的对比度全靠它。 */
uniform vec3  uBodyDark;
uniform float uGlowStrength;
uniform float uHaloScale;
uniform float uHaloStrength;
uniform float uOpacity;
uniform float uTime;

void main() {
  bool isGlow = vFlags.x > 0.5;

  // ——————— 光晕 pass ———————
  if (uPass > 0.5) {
    // 放大之后原本的体表位置丢了，靠 aEdge 反推真实半径：
    //   r = 1  在体表上
    //   r > 1  在体表之外
    float r = vEdge * uHaloScale;
    // ⚠️ 别把这个变量叫 out —— 它是 GLSL ES 3.00 的保留字，
    // 报错信息只有一句「syntax error」，很难联想到是变量名的问题。
    // （另外：GLSL 字符串是 JS 模板字面量，注释里**不能出现反引号**，
    //   否则会把模板截断 —— build.mjs 里有个 linter 专门扫这个。）
    float beyond = max(0.0, r - 1.0);
    // 两个指数项相乘：近处近似线性收，远处快速消失 ——
    // 单项指数要么拖得太长（像雾），要么收得太快（像描边）
    float falloff = exp(-beyond * 2.0) * exp(-beyond * beyond * 1.1);
    float a = falloff * uHaloStrength;
    // 加法混合，颜色直接写出去
    fragColor = vec4(uGlow * a, a * uOpacity);
    return;
  }

  // ——————— 身体 pass ———————

  // 发光器：纯粹的自发光，亮度远高于周围
  if (isGlow) {
    float amt = vFlags.y;
    vec3 c = uGlow * (2.6 * amt * uGlowStrength);
    // 过曝趋白 —— 见文件头第 3 条
    c = mix(c, vec3(1.0), clamp((amt - 0.6) * 0.5, 0.0, 0.55));
    fragColor = vec4(c, 1.0 * uOpacity);
    return;
  }

  float u = vBody.x;
  float v = clamp(vBody.y, -1.0, 1.0);

  // 鳍（背鳍/胸鳍/尾鳍）不参与暗剪影，按建模时烘进来的量各自发光。
  // 没有这一项的话鳍是全黑的 —— 在深色背景上等于没有鳍。
  float fin = vFlags.y;
  if (fin > 0.02) {
    vec3 fc = uGlow * fin * uGlowStrength * 0.62;
    // 鳍的边缘比内部亮，做出「薄膜透光」的感觉
    fc *= 0.55 + 0.5 * smoothstep(0.35, 1.0, vEdge);
    fragColor = vec4(fc, mix(0.30, 0.58, fin) * uOpacity);
    return;
  }

  // ⚠️ 这里**不能**用 vEdge 做边缘光。
  //
  // 身体的网格只有背腹两条边，中间没有顶点，所以每个片元的 vEdge 都是 1.0 ——
  // 「边缘光」会糊满整个身体，把暗色剪影变成一块过曝的色斑。
  // （第一版就是这样，一缸全是发光的肥皂泡。）
  //
  // 真正的边缘光由**光晕 pass** 负责，它沿着轮廓向外衰减。
  // 身体自己的任务是当好一个暗剪影，只需要一点背腹渐变：
  // 背深、腹浅 —— 这是发光生物最普遍的一条明暗规律。

  // 腹面发光。**必须是一条贴着下缘的窄带**，不能是整个下半身 ——
  // 用 v 直接做渐变会把半个身体点亮，生物就从「暗剪影 + 亮点」
  // 变成一块发光的色斑，整个深色氛围也就没了。
  //
  // 另外注意：smoothstep(e0, e1, x) 要求 e0 < e1，反着写是未定义行为。
  // 需要「向上衰减」时写成 1.0 - smoothstep(...)。
  // （还有：GLSL 字符串是 JS 模板字面量，注释里**不能出现反引号**。）
  float belly = smoothstep(0.72, 1.0, -v) * 0.50;
  // 头部比尾部亮一点 —— 感觉器官与发光器集中在头部
  float front = smoothstep(0.30, 0.0, u) * 0.16;

  vec3 col = uBodyDark;
  col += uGlow * (belly + front) * uGlowStrength * 0.32;
  // 轮廓上压一道很窄的亮边 —— 让剪影的边缘「立」起来，
  // 不至于在近黑背景上完全糊掉。只在**最外圈**，
  // 不是第一版那种糊满全身的边缘光。
  col += uGlow * smoothstep(0.80, 1.0, vEdge) * uGlowStrength * 0.40;

  // 鳍比身体更透明一些，避免所有部件一样实
  float alpha = 1.0;
  if (abs(vBody.y) > 1.05) alpha = 0.62; // 背鳍把 v 标到了 1.4

  fragColor = vec4(col, alpha * uOpacity);
}
`;
