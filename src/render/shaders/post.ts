/**
 * 后期链路：亮部提取 → 分离高斯模糊 → 合成（含玻璃层）。
 *
 * 玻璃放在最后而不是场景里，是因为**折射需要采样邻域像素**。
 * 场景 pass 自下而上逐层构建，拿不到「旁边是什么颜色」；
 * 合成 pass 手上有整幅画面，才做得了边缘折射。
 */

import { COMMON_GLSL } from './common.js';

/** 亮部提取 + 降采样到半分辨率。用 4 点盒式采样顺便做了抗锯齿。 */
export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSource, vUv + vec2(-o.x, -o.y)).rgb
         + texture(uSource, vUv + vec2( o.x, -o.y)).rgb
         + texture(uSource, vUv + vec2(-o.x,  o.y)).rgb
         + texture(uSource, vUv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 软膝盖：硬阈值会让亮部边界出现跳变，糊成一条明显的分界
  float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, luma - uThreshold) / max(luma, 1e-5);

  fragColor = vec4(c * contrib, 1.0);
}
`;

/**
 * 可分离高斯模糊，9 tap 用 5 次采样完成（利用线性插值一次读两个纹素）。
 * 权重是标准的高斯核。
 */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;

const float W0 = 0.2270270270;
const float W1 = 0.3162162162;
const float W2 = 0.0702702703;
const float O1 = 1.3846153846;
const float O2 = 3.2307692308;

void main() {
  vec3 col = texture(uSource, vUv).rgb * W0;
  vec2 d1 = uDirection * uTexel * O1;
  vec2 d2 = uDirection * uTexel * O2;
  col += (texture(uSource, vUv + d1).rgb + texture(uSource, vUv - d1).rgb) * W1;
  col += (texture(uSource, vUv + d2).rgb + texture(uSource, vUv - d2).rgb) * W2;
  fragColor = vec4(col, 1.0);
}
`;

/**
 * 合成 pass。
 *
 * 这里是 DESIGN.md §3.2 说的那一层 —— **最能卖出「缸」而不是「水下图」** 的地方。
 * 玻璃、水线弯月面、污渍、房间反射、箱体黑边，全在这里叠上去。
 * 少了这一段，前面画得再对也只是「水下」。
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uRes;
uniform vec4  uTankRect;
uniform float uWaterLine;
uniform int   uShape;
uniform int   uGlass;
uniform int   uFrame;
uniform int   uDetail;
uniform float uOpacity;
uniform float uTime;
uniform float uSeed;
uniform float uDaylight;
uniform float uBloomStrength;
uniform float uExposure;
uniform vec3  uLight;
uniform vec3  uGlassTint;
uniform vec3  uAccent;
uniform vec3  uFog;
uniform vec3  uCausticCol;
/** 是否绘制前景失焦光斑（对应 layers.particulates） */
uniform float uBokeh;

${COMMON_GLSL}

/** ACES 风格的软性高光压缩。比 Reinhard 更能保住亮部的颜色。 */
vec3 tonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 t = (uv - uTankRect.xy) / max(vec2(0.0001), uTankRect.zw);
  float px = uTankRect.z * uRes.x;
  float py = uTankRect.w * uRes.y;
  float aspect = px / max(1.0, py);

  // ——— 缸体遮罩（与 scene pass 完全一致，否则边缘会打架）———
  float inside;
  if (uShape == 1) {
    vec2 q = (t - 0.5) * 2.0;
    inside = sstepDown(1.02, 0.99, length(q * vec2(1.0, 1.02)));
  } else {
    vec2 edge = min(t, 1.0 - t);
    inside = smoothstep(0.0, 0.0035, min(edge.x, edge.y));
  }

  // ——— 1. 玻璃折射 ———
  // 真实玻璃不是平板：越靠边越厚，折射越强、颜色越深。
  // 这一点点坐标偏移就足以让画面「隔着一层东西」。
  vec2 edgeDist = min(t, 1.0 - t);
  float eDist = min(edgeDist.x, edgeDist.y);
  float edge = uGlass == 1 ? 1.0 - smoothstep(0.0, 0.06, eDist) : 0.0;

  vec2 refracted = uv;
  if (uGlass == 1 && edge > 0.0 && uDetail >= 1) {
    vec2 dir = normalize(t - 0.5 + vec2(1e-5, 1e-5));
    refracted = uv - dir * edge * edge * 0.012 * uTankRect.zw;
  }

  // ⚠️ 坐标约定陷阱：离屏纹理里存的是 **GL 约定**（v=0 在图像底部），
  // 而上面所有构图计算用的 uv 是**翻成 y 向下**的。
  // 直接 texture(uScene, uv) 会把整个场景上下颠倒 —— 底砂和石头会跑到画面顶部。
  // 采样离屏纹理时必须先把 y 转回去。
  vec2 sceneUv = vec2(refracted.x, 1.0 - refracted.y);

  // 边缘色散：真实镜头和厚玻璃都会有，也是梦幻观感里极便宜的一笔 ——
  // 只在边缘出现，画面中心完全干净。成本是两次额外采样，值。
  vec3 col;
  if (uGlass == 1 && uDetail >= 1 && edge > 0.02) {
    vec2 caDir = normalize(refracted - 0.5 + vec2(1e-5));
    // 乘 inside：缸体之外（箱体黑边那一圈）edge 也等于 1，
    // 不挡住的话色差会画到黑边上，看起来像套印失准而不是镜头效果
    float ca = edge * edge * 0.0016 * inside;
    vec2 uvR = refracted - caDir * ca;
    vec2 uvB = refracted + caDir * ca;
    col.r = texture(uScene, vec2(uvR.x, 1.0 - uvR.y)).r;
    col.g = texture(uScene, sceneUv).g;
    col.b = texture(uScene, vec2(uvB.x, 1.0 - uvB.y)).b;
  } else {
    col = texture(uScene, sceneUv).rgb;
  }

  col += texture(uBloom, sceneUv).rgb * uBloomStrength;

  // ——— 2. 曝光与色调 ———
  col *= uExposure;
  col = tonemap(col);
  col = saturateColor(col, 1.08);
  col = contrast(col, 1.05);

  // ——— 3. 玻璃层 ———
  if (uGlass == 1) {
    float waterLine = uWaterLine;
    float wave = surfaceWave(vec2(t.x * aspect, 0.0), uTime) * 0.006;
    float wl = waterLine + wave;

    // (a) 弯月面 —— 水与玻璃接触处水会向上弯，形成一条比水面更亮的细线。
    //     这是真实鱼缸最容易辨认的特征之一。
    float meniscus = exp(-pow((t.y - wl) * py * 0.42, 2.0));
    col += uLight * meniscus * 0.35 * uDaylight;

    // (b) 水线以上的玻璃背面反射更深，把空气层压暗
    col *= mix(1.0, 0.72, sstepDown(wl + 0.05, wl, t.y));

    // (c) 玻璃内层的柔光。
    //     上一版这里是「指纹 + 水垢 + 干涸水渍痕」——那是写实路线的细节。
    //     方向改成几何光影之后，那些高频的脏东西和干净的色块是打架的，
    //     换成一层低频的柔光：同样让玻璃「存在」，但不弄脏画面。
    vec2 suv = vec2(uv.x * aspect, uv.y);
    float veil = fbm(suv * 1.6 + uSeed * 0.7, 3);
    col = mix(col, col * 0.94 + uLight * 0.035, clamp(veil - 0.35, 0.0, 1.0) * 0.55);

    // (d) 房间反射 —— 一道斜向的柔光带，极缓慢地漂移。
    //     它让画面感觉「外面还有一个房间」。
    float band = uv.x * 0.62 + uv.y * 0.78 - 0.66 - 0.07 * sin(uTime * 0.06);
    float refl = exp(-pow(band * 4.0, 2.0));
    col += uLight * refl * 0.085 * uDaylight;

    // (e) 玻璃本身的绿边。真实缸玻璃的断面是绿的，这一点点染色很关键。
    col = mix(col, col * uGlassTint * 1.30, edge * 0.34);

    // (f) 边缘压暗 —— 厚玻璃吸收更多光
    col *= mix(1.0, 0.70, edge * edge);
  }

  // ——— 4. 箱体：黑边与硅胶接缝 ———
  // 'fill' 构图时缸体就是屏幕，画黑边会显得像贴了个框，所以由 uFrame 控制。
  float rim = 0.0;
  if (uFrame == 1) {
    // 边的宽度必须按**屏幕像素**定义，不能按归一化坐标。
    // 拿 uTankRect.z 当尺度是个陷阱：letterbox 下它是 0.9，
    // 算出来的「边」会宽到盖住整个缸体，整幅画面直接变黑。
    float bandTankUv = 6.0 / max(1.0, uTankRect.w * uRes.y);
    rim = exp(-pow(eDist / bandTankUv, 2.0));
    col = mix(col, vec3(0.020, 0.023, 0.027), clamp(rim, 0.0, 1.0) * 0.92);

    // 四角加厚，模拟硅胶接缝的圆角
    float corner = sstepDown(0.06, 0.0, length(edgeDist) * 2.2);
    col = mix(col, vec3(0.025, 0.028, 0.032), corner * 0.55);
  }

  // ——— 5. 暗角 ———
  // 缸内也压一点：镜头/眼睛看缸本来就有暗角
  vec2 vq = (uv - 0.5) * vec2(aspect, 1.0);
  float vignette = 1.0 - 0.26 * dot(vq, vq) * 1.25;
  col *= clamp(vignette, 0.0, 1.0);

  // ——— 6. 颗粒 ———
  // 极轻的胶片颗粒能盖住大面积渐变的色带，也统一了不同图层的质感
  float grain = hash21(uv * uRes + fract(uTime) * 137.0) - 0.5;
  col += grain * 0.016;

  // ——— 7. 前景失焦光斑 ———
  //
  // 放在这里而不是场景 pass 里，是因为它**必须盖在鱼之上**：
  // 失焦的前景物体在光学上位于所有合焦物体之前。放在场景里的话，
  // 鱼（在场景之后绘制）会盖住它，前后关系就反了。
  if (uBokeh > 0.5) {
    float depth = clamp((t.y - uWaterLine) / max(0.001, 0.80 - uWaterLine), 0.0, 1.0);
    float bok = bokehField(vec2(t.x * aspect, t.y), uTime, uDetail >= 2 ? 4.2 : 3.0, uSeed + 3.0);
    bok *= 0.22 * uDaylight * smoothstep(0.10, 0.85, depth);
    col = mix(col, mix(uCausticCol, uAccent, 0.45), clamp(bok, 0.0, 1.0) * inside);
  }

  col = clamp(col, 0.0, 1.0);

  // 页面外的区域保持透明（圆窗、letterbox）
  float alpha = mix(1.0, inside, float(uShape));
  alpha *= uOpacity;

  // 画布是 premultipliedAlpha，必须输出预乘颜色，
  // 否则半透明覆盖层上的水会亮得发白
  fragColor = vec4(col * alpha, alpha);
}
`;
