/**
 * 水体。整个渲染里唯一一个全屏 pass，也是画面 90% 的面积。
 *
 * ## 这里没有地面
 *
 * 上一版有底砂、岩石、几何块、植物 —— 每一层都在和主体抢注意力。
 * 深海里没有地面：生物漂在虚空中，画面下半部分是**纯净的近黑**。
 * 这一刀砍掉了三层视觉噪音，也让「深渊」这个意象真正成立。
 *
 * ## 亮度只有一个来源
 *
 * 除了生物自身的辉光，画面里所有的亮度都来自顶部那一点冷光：
 * 光池 → 光柱 → 焦散 → 微粒被照亮。这四样都按**深度**衰减，
 * 越往下越黑。于是画面自然形成「上亮下黑」的纵深，
 * 而不需要靠画一堆东西来制造层次。
 *
 * ## 暗色渐变必须抖动
 *
 * 深色场景里最大的技术陷阱：8 位色深下，从 #01030a 到 #05121c 这种
 * 极窄的渐变会出现**肉眼可见的带状分层**。这不是显卡问题，
 * 是量化误差 —— 相邻两级的差值小于一个色阶。
 *
 * 解法是在输出前叠一个幅度约 1/255 的高频抖动，把量化误差打散成噪声。
 * 人眼对随机噪声不敏感，对规则色带极其敏感。
 *
 * 坐标约定：
 *   vUv   GL 惯例，y 向上
 *   uv    翻转后，y 向下，原点左上
 *   t     缸内坐标 [0,1]²，y 向下。0 = 水面，1 = 画面底部
 */

import { COMMON_GLSL } from './common.js';
import { FULLSCREEN_VS } from '../gl.js';

/** 图层开关位掩码。 */
export const L_SURFACE = 1 << 0;
export const L_CAUSTICS = 1 << 1;
export const L_RAYS = 1 << 2;
export const L_SNOW = 1 << 3;
export const L_VIGNETTE = 1 << 4;

/**
 * 全屏三角形用的是 `gl_VertexID`，**不需要任何顶点属性** ——
 * 见 gl.ts 的 FULLSCREEN_VS。
 *
 * ⚠️ 这里千万别自己写一个 `in vec2 aPos` 的版本。我写过一次，
 * 结果那个属性从来没人提供，三个顶点全部塌到同一点，整个 pass 什么都没画。
 * 症状极具迷惑性：**画面全黑，而且改任何着色器都毫无反应** ——
 * 因为它根本没执行。更坑的是，我当时为了排查又写了个「最简绿色着色器」
 * 的对照测试，而那个测试同样用了这个坏 VS，于是对照组和实验组一起黑，
 * 白白多花了很多时间。
 */
export const SCENE_VS = FULLSCREEN_VS;


export const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uAspect;
uniform float uTime;
uniform float uSeed;
uniform float uIntro;

uniform vec3  uWaterTop;
uniform vec3  uWaterDeep;
uniform vec3  uLight;
uniform vec3  uCaustic;

uniform float uAmbient;
uniform float uTurbidity;
uniform int   uDetail;
uniform int   uLayers;
/** 远景种类：0 开阔 / 1 海沟 / 2 沉降雪原 / 3 热泉 / 4 遗迹 */
uniform int   uBackdrop;

${COMMON_GLSL}

/**
 * 深度。0 = 水面，1 = 画面底部。
 *
 * 用 y 直接当深度是一种**风格化**处理 —— 真实深度需要摄像机与场景几何，
 * 而我们是一个正对水体的二维视口。对深海意象来说，「越往下越深」
 * 这个直觉足够准确，而且完全避免了三维的复杂度。
 */
float depthAt(vec2 t) {
  return clamp(t.y, 0.0, 1.0);
}

/**
 * 远景。
 *
 * ## 三条硬约束
 *
 * **一、剪影必须是近黑的。** 远景比近景亮会让画面**失去纵深** ——
 * 人对距离的感知很大一部分来自「远处的东西被水吸收得更狠」。
 *
 * **二、只在边缘留一点点被照亮。** 剪影平涂会像贴纸；
 * 只有左缘（朝向光源那一侧）有一线微光，它才会从水里「切」出来。
 *
 * **三、亮度上限由调用方兜底。** 这一层是**背景**，
 * 生物才是主角。远景的对比度稍微高一点，画面立刻变吵。
 *
 * 输出两个量：
 *   cover  遮挡程度，用来把水体颜色换掉（不是叠加）
 *   tint   加在遮挡结果上的颜色（边缘光、热泉的余晖）
 */
void backdropLayer(
  int kind,
  vec2 t,
  float aspect,
  float time,
  float seed,
  vec3 light,
  float ambient,
  out float cover,
  out vec3 tint
) {
  cover = 0.0;
  tint = vec3(0.0);
  if (kind == 0) return; // 开阔水域：什么都没有，最安静

  float x = t.x * aspect;

  if (kind == 1) {
    // ——— 海沟：右侧一道黑压压的崖壁 ———
    // 边缘用 fbm 扰动，免得是一条数学直线
    // 崖壁推得更远一些：占满右半屏会显得它很近，而「远处的崖壁」
    // 才是这一层想要的
    float wob = (fbm(vec2(t.y * 2.6 + seed * 1.7, 5.3), 3) - 0.5) * 0.46;
    // 再叠一层高频，免得边缘只是一条缓慢起伏的曲线
    wob += (fbm(vec2(t.y * 9.0 + seed, 17.0), 2) - 0.5) * 0.07;
    float edge = 0.74 + wob;
    cover = smoothstep(edge - 0.02, edge + 0.02, x);
    // 只有朝向光源的那一侧有边缘光，而且**沿高度明暗不均** ——
    // 一条均匀的亮边会像画上去的描边，不均匀才像岩体被斜照
    float lit = 0.45 + 0.55 * fbm(vec2(t.y * 3.4 + seed, 11.0), 3);
    float rim = smoothstep(edge - 0.045, edge, x) * (1.0 - smoothstep(edge, edge + 0.07, x));
    // 崖壁内部极淡的起伏，暗示岩体而不是一块纯黑板
    float rock = fbm(vec2(x * 11.0, t.y * 7.0 + seed), 3);
    tint = light * (rim * lit * 0.45 + rock * 0.03 * cover) * ambient;
    return;
  }

  if (kind == 2) {
    // ——— 沉降雪原：密集的有机碎屑在缓缓落下 ———
    // 这一层不遮挡，它是**加**上去的。密度比默认的海雪高得多，
    // 于是整片水看起来像在下雪 —— 这是最深的一种「下雪感」。
    vec2 p = vec2(x, t.y * 0.55);
    vec2 gv = p * 62.0;
    vec2 id = floor(gv);
    vec2 f = fract(gv) - 0.5;
    float h = hash21(id);
    if (h < 0.62) return;
    float fall = fract(h * 13.7 + time * (0.004 + h * 0.006));
    vec2 pos = vec2((h - 0.5) * 0.75 + sin(time * 0.08 + h * 20.0) * 0.08, fall - 0.5);
    float d = length(f - pos);
    float mote = smoothstep(0.05 + h * 0.03, 0.0, d) * (0.3 + h * 0.7);
    // 越深越暗，但整体比默认海雪亮一档
    tint = mix(light, uCaustic, 0.35) * mote * 0.30 * (1.0 - t.y * 0.55);
    return;
  }

  if (kind == 3) {
    // ——— 热泉喷口：几缕上升的黑烟 ———
    // 「黑烟」的关键是它**比水更黑**：遮挡水体，但自己不发光。
    // 只在最底部有一点热液口的余晖。
    float plume = 0.0;
    float glow = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float cx = 0.22 + fi * 0.27 + (hash11(fi * 3.7 + seed) - 0.5) * 0.10;
      // 烟柱往上散开
      float spread = 0.018 + t.y * 0.10;
      float dx = (x - cx) / spread;
      float n = fbm(vec2(dx * 1.7, t.y * 3.4 + time * 0.05 + fi * 5.0), 3);
      // 底浓上淡
      float body = exp(-dx * dx) * smoothstep(1.05, 0.18, t.y) * smoothstep(0.28, 0.62, n);
      plume = max(plume, body);
      // 喷口本身：贴着画面底部一点点暖光（热的矿物水在发光）
      glow = max(glow, exp(-dx * dx * 3.0) * smoothstep(0.14, 0.02, t.y));
    }
    cover = clamp(plume, 0.0, 0.85);
    tint = light * (glow * 0.55 + plume * 0.05) * ambient;
    return;
  }

  // ——— 遗迹：几根倾颓的柱子 ———
  float body = 0.0;
  float rim = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float cx = 0.16 + fi * 0.20 + (hash11(fi * 5.3 + seed) - 0.5) * 0.07;
    float w = 0.018 + hash11(fi * 9.1 + seed) * 0.016;
    // 断口高度不一 —— 齐刷刷一样高就不像废墟了
    float top = 0.34 + hash11(fi * 13.7 + seed) * 0.26;
    // 柱子越往下越收（透视）
    float halfW = w * (1.0 - t.y * 0.25);
    float inside = step(abs(x - cx), halfW) * step(top, t.y);
    body = max(body, inside);
    float edge = smoothstep(halfW + 0.006, halfW, abs(x - cx));
    rim = max(rim, edge * step(top, t.y));
  }
  cover = body;
  tint = light * (rim * 0.30 + body * 0.02) * ambient;
}

void main() {
  vec2 uv = vUv;
  vec2 t = vec2(uv.x, 1.0 - uv.y); // 转成「上 = 0」
  float depth = depthAt(t);

  // ——————— 1. 水体本身的垂直渐变 ———————
  //
  // 指数 0.65 让上半部分保持较亮的青，下半部分迅速沉入黑 ——
  // 线性渐变会让整片水都发灰，没有「深渊」的感觉。
  float g = pow(depth, 0.65);
  vec3 col = mix(uWaterTop, uWaterDeep, g);

  // 一点大尺度的水色不均，避免渐变过于「数学」
  float mottle = fbm(t * vec2(uAspect, 1.0) * 2.1 + uSeed, 3) - 0.5;
  col += mottle * uWaterTop * 0.16 * (1.0 - g * 0.7);

  // ——————— 2. 顶部光池 ———————
  //
  // 光源在画面上方略偏左。这是整个场景唯一的照明来源。
  vec2 lightPos = vec2(0.42 * uAspect, -0.28);
  vec2 lp = vec2(t.x * uAspect, t.y) - lightPos;
  float pool = exp(-dot(lp, lp) * 1.35);
  col += uLight * pool * uAmbient * 0.30;

  // ——————— 3. 焦散 ———————
  //
  // 只在靠近水面的地方可见。衰减用 pow(depth, 3) 而不是线性 ——
  // 光被水吸收得很快，焦散的存在范围比直觉上窄得多。
  if ((uLayers & ${L_CAUSTICS}) != 0) {
    float near = pow(1.0 - depth, 3.0);
    if (near > 0.002) {
      float c = causticNet(vec2(t.x * uAspect, t.y * 0.55) * 4.4, uTime);
      // 脊状噪声本身对比度很高，这里压到很低的系数 —— 焦散是**暗示**，
      // 不是主体。调高一点画面立刻变得像游泳池。
      col += uCaustic * c * near * uAmbient * 0.34;
    }
  }

  // ——————— 4. 光柱 ———————
  if ((uLayers & ${L_RAYS}) != 0) {
    float shaft = lightShaft(vec2(t.x * uAspect, t.y), uTime, uSeed);
    // 越往下越散越淡
    float falloff = pow(1.0 - depth, 1.7);
    col += uLight * shaft * falloff * uAmbient * 0.16;
  }

  // ——————— 5. 海雪 ———————
  //
  // 深色场景里性价比最高的元素：几个发光小点就撑出了体积感。
  if ((uLayers & ${L_SNOW}) != 0) {
    float density = uDetail >= 2 ? 34.0 : 20.0;
    float snow = marineSnow(vec2(t.x * uAspect, t.y), uTime, density);
    // 靠近水面的微粒被顶光照亮，深处的只留一点余光
    col += mix(uLight, uCaustic, 0.4) * snow * (1.0 - depth * 0.75) * 0.30;
  }

  // ——————— 6. 水面 ———————
  if ((uLayers & ${L_SURFACE}) != 0) {
    // 一条很淡的水面线 + 极窄的高光。深处看水面本来就几乎看不见，
    // 这里的处理是「暗示上面有水面」，不是画一条边。
    float wave = sin(t.x * uAspect * 7.0 + uTime * 0.35) * 0.0016
               + sin(t.x * uAspect * 3.1 - uTime * 0.22) * 0.0026;
    float line = smoothstep(0.010, 0.0, abs(t.y - 0.030 - wave));
    col += uLight * line * 0.10 * uAmbient;
  }

  // ——————— 6.5 远景 ———————
  //
  // 放在水体与光之后、暗角之前：远景要被水吸收（所以受浑浊度影响），
  // 但也要被暗角压住（所以不能放到最后）。
  {
    float cover;
    vec3 tint;
    backdropLayer(uBackdrop, t, uAspect, uTime, uSeed, uLight, uAmbient, cover, tint);
    if (cover > 0.001) {
      // 遮挡用的是「更黑的水」，不是纯黑 —— 纯黑在暗色背景上会显得像挖了个洞
      vec3 occluded = uWaterDeep * 0.28;
      col = mix(col, occluded, cover);
    }
    col += tint;
  }

  // ——————— 7. 浑浊与暗角 ———————
  //
  // 浑浊度在这里的作用变了：不再是「远处的雾」，而是**整体压暗**。
  // 深海里水本身就是吸收介质。
  col *= mix(1.0, 0.72, uTurbidity);

  if ((uLayers & ${L_VIGNETTE}) != 0) {
    vec2 vp = (uv - 0.5) * vec2(1.0, 0.86);
    float vig = 1.0 - smoothstep(0.34, 0.92, length(vp));
    col *= mix(0.42, 1.0, vig);
  }

  // ——————— 8. 开场 ———————
  // 从更黑的地方亮起来。深色场景的开场不需要「生长」，只需要「点亮」。
  col *= mix(0.0, 1.0, clamp(uIntro, 0.0, 1.0));

  // ——————— 9. 抖动 ———————
  //
  // 见文件头的说明：暗色渐变在 8 位色深下会带状分层。
  // 幅度取 1/255 量级 —— 足够打散量化误差，又完全看不见噪点。
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) / 255.0;

  fragColor = vec4(col + dither, 1.0);
}
`;
