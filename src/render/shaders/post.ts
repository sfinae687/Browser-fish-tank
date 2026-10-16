/**
 * 后期。三个 pass：提亮部 → 模糊 → 合成。
 *
 * ## 辉光在这套美术里的地位
 *
 * 上一版辉光是「润色」—— 阈值 0.76，几乎只有高光会漏一点出来。
 * 这一版它是**造型手段**：深色场景里「亮」是稀缺资源，
 * 发光生物之所以看起来在发光，靠的就是亮部向外溢出。
 * 所以阈值压得很低、半径给得大。
 *
 * ## 三个容易做错的地方
 *
 * **一、阈值要软。** 硬阈值会让辉光的边界出现一圈突兀的切线 ——
 * 亮部边缘突然有光、旁边突然没有，一眼就看出来是后处理。
 *
 * **二、模糊要分离式。** 二维高斯直接卷积是 O(n²)；
 * 拆成横竖两次是一维的 O(2n)，视觉上没有区别。
 *
 * **三、在低分辨率上模糊。** 辉光本来就是低频的，在半分辨率甚至
 * 四分之一分辨率上做，成本降一个数量级而观感几乎不变。
 */

import { COMMON_GLSL } from './common.js';

/** 提亮部。输出到低分辨率目标。 */
export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // 软阈值：在 [threshold, threshold + knee] 之间平滑过渡。
  // 硬阈值会在亮部边缘留下一圈突兀的切线。
  float w = smoothstep(uThreshold, uThreshold + uKnee, l);

  fragColor = vec4(c * w, 1.0);
}
`;

/**
 * 一维高斯模糊。
 *
 * `uDir` 是 (1,0) 或 (0,1)，同一个程序跑两遍。
 * 固定 9 抽样，权重取自标准差约 2.6 的高斯 ——
 * 比重心坐标那类花哨做法简单，而且够用。
 */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDir;

void main() {
  const float w0 = 0.227027;
  const float w1 = 0.194594;
  const float w2 = 0.121622;
  const float w3 = 0.054054;
  const float w4 = 0.016216;

  vec3 sum = texture(uSource, vUv).rgb * w0;
  sum += texture(uSource, vUv + uDir * 1.0).rgb * w1;
  sum += texture(uSource, vUv - uDir * 1.0).rgb * w1;
  sum += texture(uSource, vUv + uDir * 2.0).rgb * w2;
  sum += texture(uSource, vUv - uDir * 2.0).rgb * w2;
  sum += texture(uSource, vUv + uDir * 3.0).rgb * w3;
  sum += texture(uSource, vUv - uDir * 3.0).rgb * w3;
  sum += texture(uSource, vUv + uDir * 4.0).rgb * w4;
  sum += texture(uSource, vUv - uDir * 4.0).rgb * w4;

  fragColor = vec4(sum, 1.0);
}
`;

/**
 * 合成：场景 + 辉光，外加整体不透明度。
 *
 * 注意**不在这里做色调映射**。深色场景本来就该让亮部过曝一点点 ——
 * 那是「在发光」的观感来源之一。压回去反而会显得灰。
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;

uniform vec4  uTankRect;
uniform float uTime;
uniform float uBloomStrength;
uniform float uOpacity;
/** 水面在缸内的 y。水面之上是空气，不该和水里一样亮。 */
uniform float uWaterLine;

${COMMON_GLSL}

void main() {
  // 缸内坐标。矩形之外输出透明 —— 覆盖层要能和页面合成。
  vec2 t = (vUv - uTankRect.xy) / max(vec2(1e-5), uTankRect.zw);
  float inside =
    step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);

  vec3 col = texture(uScene, vUv).rgb;
  col += texture(uBloom, vUv).rgb * uBloomStrength;

  if (uWaterLine > 0.0) {
    float above = smoothstep(uWaterLine, uWaterLine * 0.25, t.y);
    col *= mix(1.0, 0.55, above);
  }

  // 抖动：暗色渐变在 8 位色深下会带状分层。
  // 幅度取 1/255 量级 —— 足够打散量化误差，又完全看不见噪点。
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) / 255.0;

  fragColor = vec4(col + dither, uOpacity * inside);
}
`;
