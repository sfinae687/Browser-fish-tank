/**
 * 公共 GLSL 片段。
 *
 * 深色场景对噪声的要求和明亮场景**不一样**：这里绝大部分像素接近黑色，
 * 任何一点噪声都会被辉光放大成可见的脏点。所以：
 *
 *   - 噪声只用来做**大尺度的柔和起伏**（光池、水色不均），不做细节纹理
 *   - 高频的东西（焦散、微粒）必须**稀疏**，宁可少也不要密
 *   - 一切都要经过 smoothstep 压掉尾巴，不留硬边
 */

export const COMMON_GLSL = /* glsl */ `
#define PI  3.141592653589793
#define TAU 6.283185307179586

/**
 * 反向 smoothstep：x <= e1 时为 1，x >= e0 时为 0（要求 e0 > e1）。
 *
 * 存在的理由：GLSL 规范明说 smoothstep(e0, e1, x) 在 e0 >= e1 时
 * **结果未定义**。我们有好几处需要「向上衰减」的遮罩，
 * 直接调换参数在多数驱动上碰巧能跑，但结果可能因显卡而异。
 */
float sstepDown(float e0, float e1, float x) {
  return 1.0 - smoothstep(e1, e0, x);
}

// ————————————————————————————————————————————————————————————
// 哈希与噪声
// ————————————————————————————————————————————————————————————

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

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

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += vnoise(p) * amp;
    norm += amp;
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// ————————————————————————————————————————————————————————————
// 水面
// ————————————————————————————————————————————————————————————

/**
 * 焦散。
 *
 * 深海里的焦散只在**靠近水面**的地方可见 —— 光还没被水吸收完的时候。
 * 所以调用方必须按深度把它们衰减掉，否则整片水体都在闪，
 * 那就从「深海」变成了「游泳池」。
 *
 * 用脊状噪声而不是 fbm：焦散的形态是**细亮的网**，不是云。
 */
float causticNet(vec2 p, float t) {
  vec2 q = p;
  float a = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 off = vec2(t * (0.021 + fi * 0.011), -t * (0.016 + fi * 0.008));
    float n = fbm(q + off, 3);
    // 折叠成脊：1 - |2n - 1|
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    a += ridge * ridge;
    q = q * 1.7 + vec2(5.2, 1.3);
  }
  return a * 0.5;
}

/**
 * 从上方斜射下来的光柱。
 *
 * 关键是**要宽、要软、要少**。上一版的光柱又窄又密，
 * 结果画面像被划了很多道 —— 深海的光柱应该是三两条模糊的宽带。
 */
float lightShaft(vec2 uv, float t, float seed) {
  // 斜向坐标：光柱顺着这个轴分层
  float x = uv.x + uv.y * 0.42;
  float sum = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float s = fi * 7.31 + seed;
    float drift = sin(t * 0.018 + s) * 0.06;
    float band = fract(x * (0.6 + fi * 0.37) + drift + s * 0.31);
    // 一个很软的钟形
    float w = smoothstep(0.0, 0.5, band) * smoothstep(1.0, 0.5, band);
    sum += pow(w, 2.2);
  }
  return sum / 3.0;
}

/**
 * 悬浮微粒（海雪）。
 *
 * 深色场景里这是**性价比最高的一个元素** —— 几个发光小点就能
 * 让整片水有体积感和纵深感，而成本几乎为零。
 *
 * 用格点而不是逐粒子循环：每格至多一个粒子，便宜且视觉上够用。
 */
float marineSnow(vec2 uv, float t, float density) {
  vec2 p = vec2(uv.x, uv.y * 0.6);
  vec2 gv = p * density;
  vec2 id = floor(gv);
  vec2 f = fract(gv) - 0.5;

  float h = hash21(id);
  if (h > 0.34) return 0.0; // 大部分格子是空的 —— 稀疏才有深海感

  float fall = fract(h * 13.7 + t * (0.006 + h * 0.010));
  vec2 pos = vec2((h - 0.5) * 0.7 + sin(t * 0.1 + h * 20.0) * 0.06, fall - 0.5);

  float d = length(f - pos);
  float r = 0.012 + h * 0.010;
  return smoothstep(r, 0.0, d) * (0.35 + h * 0.65);
}

// ————————————————————————————————————————————————————————————
// 通用
// ————————————————————————————————————————————————————————————

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`;
