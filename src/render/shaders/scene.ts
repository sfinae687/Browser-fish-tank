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
