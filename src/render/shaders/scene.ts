/**
 * 场景 pass —— 鱼缸「内部」的全部内容，渲染到 HDR 渲染目标。
 *
 * 美术方向：**几何光影 · 梦幻**，不是写实水族摄影。
 * 这条约束的含义写在最前面，以免后来改的人走回老路：
 *
 *   - 景观是**干净的几何体**，边界不该有噪声。噪声是最容易毁掉几何感的东西。
 *   - 层次靠**光**拉开（体积光、焦散、辉光、失焦光斑），不是靠压暗和浑浊。
 *   - 水是发光的介质，可以亮、可以偏色、可以甜。
 *   - 运动缓慢，有呼吸感。
 *
 * 这一 pass 只画水和景观，不画玻璃 —— 玻璃要采样邻域像素做折射，
 * 需要整幅画面作为输入，所以放在 composite 里。
 *
 * 坐标约定（务必记住，改起来容易搞混）：
 *   vUv       GL 惯例，y 向上
 *   uv        翻转后，y 向下，原点左上 —— 后面全部用它
 *   t         缸内坐标，[0,1]²，y 向下。0 = 缸顶，1 = 缸底
 */

import { COMMON_GLSL } from './common.js';

export const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uSeed;

/** 缸体在屏幕 uv 里的矩形：x, y, w, h（y 向下） */
uniform vec4  uTankRect;
/** 水面在缸内坐标里的位置（y 向下），通常 0.03~0.08 */
uniform float uWaterLine;
/** 0 = 矩形，1 = 圆窗 */
uniform int   uShape;
/** 0=tank 1=generative 2=transparent 3=page */
uniform int   uBackground;
/** 画面细节档位 0..2 */
uniform int   uDetail;

uniform vec3 uWaterTop;
uniform vec3 uWaterBottom;
uniform vec3 uFog;
uniform vec3 uLight;
uniform vec3 uCaustic;
uniform vec3 uSubstrate;
uniform vec3 uSubstrateDark;
uniform vec3 uAccent;
uniform float uAmbient;
uniform float uTurbidity;
uniform float uDaylight;
uniform float uWarmth;
/** 光照方向（缸内坐标，指向光源）。光柱与打光都靠它。 */
uniform vec2 uLightDir;
/** 开场生长进度 0..1，1 = 完全长成 */
uniform float uIntro;
/** 图层位掩码 */
uniform int uLayers;

/** 藻类生物量 0..1。P1 的生态模拟通过它影响水的清透度与色偏。 */
uniform float uAlgae;
/** 植物骨架纹理（R=生长顺序 G=深度 B=色相 A=覆盖） */
uniform sampler2D uFlora;
/** 开场的生长进度 0..1。只有 order ≤ uGrowth 的部分才显示。 */
uniform float uGrowth;
/** 烘焙植物时的参考宽高比，用于把实际缸体的比例换算回去 */
uniform float uFloraAspect;
/** 归一化水温 0..1，用于极轻微的冷暖偏移。 */
uniform float uHeat;

#define L_BACKMURK     (1 << 0)
#define L_HARDSCAPE    (1 << 1)
#define L_SUBSTRATE    (1 << 2)
#define L_FLORA        (1 << 3)
#define L_PARTICULATE  (1 << 5)
#define L_CAUSTICS     (1 << 6)
#define L_GODRAYS      (1 << 7)

#define hasLayer(m) ((uLayers & (m)) != 0)

${COMMON_GLSL}

// ————————————————————————————————————————————————————————————
// 生成式背景
// ————————————————————————————————————————————————————————————

/**
 * 缸体之外的背景。走的是「生成图形」而不是照片：
 * 等高线式的流场线 + 一点颗粒。低调，不跟缸抢注意力。
 */
vec3 generativeBackdrop(vec2 uv) {
  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 p = vec2(uv.x * aspect, uv.y) * 2.4;

  // 流场：用两个噪声构成角度场，再沿场做平流 —— 得到丝缕状的走向
  float a = fbm(p * 1.2 + uSeed, 3) * TAU * 1.5;
  vec2 flow = vec2(cos(a), sin(a));
  float streak = warpedFbm(p * 2.0 + flow * 0.6, uTime * 0.25, 4);

  // 等高线：把连续场切成细线
  float bands = abs(fract(streak * 7.0) - 0.5) * 2.0;
  float line = smoothstep(0.86, 1.0, 1.0 - bands);

  vec3 base = mix(uFog * 0.10, uWaterBottom * 0.5, streak);
  vec3 col = base + uAccent * line * 0.10;

  // 颗粒，避免大面积渐变出现色带
  col += (hash21(uv * uRes) - 0.5) * 0.012;
  return col;
}

// ————————————————————————————————————————————————————————————
// 底砂
// ————————————————————————————————————————————————————————————

/**
 * 底砂表面的高度（缸内 y，越小越高）。
 *
 * ⚠️ 这个函数有**两份实现**：这里一份，core/flora.ts 里一份。
 * 植物要长在砂面上，所以 CPU 端必须知道砂线在哪。
 *
 * 因此这里不能用 fbm —— 那是着色器里的噪声，CPU 复刻一遍必然对不齐。
 * 改成一个解析式：三个固定位置的平滑隆起，高度由种子决定。
 * 两边用同样的公式，只差 GPU 是 f32、JS 是 f64，肉眼看不出来。
 */
float bump(float x, float c, float w) {
  float d = abs(x - c) / w;
  if (d >= 1.0) return 0.0;
  float t = 1.0 - d;
  return t * t * (3.0 - 2.0 * t);
}

float substrateHeight(float x) {
  float h = 0.815;
  h -= bump(x, 0.18, 0.30) * (0.020 + 0.018 * hash11(uSeed + 1.0));
  h += bump(x, 0.52, 0.26) * (0.014 + 0.012 * hash11(uSeed + 2.0));
  h -= bump(x, 0.83, 0.22) * (0.016 + 0.014 * hash11(uSeed + 3.0));
  return h;
}

// ————————————————————————————————————————————————————————————
// 几何景观
// ————————————————————————————————————————————————————————————

/**
 * 一组从底砂上立起来的圆角板。
 *
 * ⚠️ 这里**刻意不扰动边界**。上一版为了做石头，用噪声去揉半径，
 * 顺手引入了两个问题：形状只能是以中心为原点的星形，而且所有细节都是
 * 放射状的。方向改成几何之后，噪声就是纯粹的有害物 —— 它会把干净的
 * 直边和圆角搅成土豆。
 *
 * 想要不规则，应该靠**尺寸与位置的分布**去要，而不是靠扰动轮廓。
 * 下面的高度用两个哈希相乘，让分布偏向矮的、偶尔冒出一根高的 ——
 * 均匀分布会得到一排整齐的柱子。
 */
float geometricSDF(
  vec2 t,
  out vec2 local,
  out vec2 halfSize,
  out float idx,
  out float roundness
) {
  float d = 1e9;
  local = vec2(0.0);
  halfSize = vec2(0.1);
  idx = 0.0;
  roundness = 0.4;

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float cx = 0.06 + 0.88 * hash11(fi * 3.7 + uSeed);
    float w  = 0.020 + 0.048 * hash11(fi * 1.3 + uSeed + 5.0);
    float hh = 0.035 + 0.24 * hash11(fi * 2.9 + uSeed + 8.0)
                          * hash11(fi * 5.1 + uSeed + 2.0);

    // 底边埋进砂线之下，看起来是「立」在砂里而不是浮在上面
    float base = substrateHeight(cx) + 0.020;
    vec2 c = vec2(cx, base - hh);

    // 轻微旋转。全是正立的圆角矩形会像一排柱子；转一点点，
    // 整组立刻从「栅栏」变成「散落的积木」。
    float rot = (hash11(fi * 9.3 + uSeed + 11.0) - 0.5) * 0.42;
    float cs = cos(rot);
    float sn = sin(rot);
    vec2 q = t - c;
    vec2 lq = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);

    // 圆角半径的跨度要拉满：从几乎直角到完全圆头（胶囊）。
    // 只差一点点的话，六块看起来还是同一个模子刻的。
    float k = hash11(fi * 4.1 + uSeed + 19.0);
    float r = mix(min(w, hh) * 0.06, min(w, hh) * 1.0, k);

    float di = sdRoundBox(lq, vec2(w, hh), r);

    if (di < d) {
      d = di;
      local = lq;
      halfSize = vec2(w, hh);
      idx = fi;
      roundness = k;
    }
  }
  return d;
}

// ————————————————————————————————————————————————————————————
// 水体
// ————————————————————————————————————————————————————————————

vec4 renderTank(vec2 t, vec2 uv, float aspect) {
  // 各向同性采样坐标：不加 aspect 修正的话，所有噪声都会被横向拉长
  vec2 iso = vec2(t.x * aspect, t.y);

  // 水面位置。开场时水位从底部涨上来。
  float waterLine = mix(1.0, uWaterLine, clamp(uIntro * 1.35, 0.0, 1.0));

  // 藻华：水变绿、变浑、透光变差。这是生态最直观的可见后果，
  // P1 先把这条渲染通道打通，P4 的藻华事件直接复用它。
  float turb = clamp(uTurbidity + uAlgae * 0.55, 0.0, 1.0);

  // ——— 缸内空气层 ———
  if (t.y < waterLine) {
    // 梦幻风里水面上方不是黑洞，而是一层被灯染色的柔光
    float above = sstepDown(waterLine, 0.0, t.y);
    vec3 air = mix(uFog * 0.30, uFog * 0.10, above);
    // 缸顶灯管：一条被玻璃压扁的亮带
    float lamp = exp(-pow((t.y - 0.014) * 22.0, 2.0));
    air += uLight * lamp * uDaylight * 0.65;
    return vec4(air, 1.0);
  }

  float depth = clamp((t.y - waterLine) / max(0.001, 1.0 - waterLine), 0.0, 1.0);

  // ——— 1. 水体基色 ———
  float murk = clamp(depth * (0.40 + turb * 1.35), 0.0, 1.0);
  vec3 col = mix(uWaterTop, uWaterBottom, smoothstep(0.0, 1.0, murk));
  col = mix(col, uFog, murk * turb * 0.75);

  // 藻类的绿偏 —— 与浑浊分开，因为「绿」和「浑」是两件事
  col = mix(col, col * vec3(0.70, 1.0, 0.62) + vec3(0.02, 0.05, 0.0), uAlgae * 0.45);

  // 昼夜色温。清晨偏冷青，黄昏偏暖橙。
  col *= mix(vec3(0.88, 0.95, 1.06), vec3(1.12, 0.96, 0.80), clamp(uWarmth * 0.5 + 0.5, 0.0, 1.0));
  // 水温的极轻微偏移（暖水偏琥珀，冷水偏青）
  col *= mix(vec3(0.96, 0.99, 1.04), vec3(1.05, 1.0, 0.95), clamp(uHeat, 0.0, 1.0));

  // ——— 2. 底砂 ———
  // 几何风里砂面不需要颗粒。颗粒是写实路线的残留，会把干净的色块搅脏。
  float sandMask = 0.0;
  float sh = substrateHeight(t.x);
  if (hasLayer(L_SUBSTRATE)) {
    sandMask = smoothstep(sh - 0.005, sh + 0.002, t.y);

    // 从砂线往下的一条柔和渐变带
    float band = sstepDown(sh + 0.34, sh, t.y);
    vec3 sand = mix(uSubstrateDark, uSubstrate, 0.08 + 0.52 * band);

    // 砂面上的焦散：**乘**在反照率上，不是加。
    // 焦散是落在砂面上的光，砂能反射多少取决于它自己的反照率 ——
    // 再强的光晒在白砂上也只会让它接近白，不会超过白。
    // 用加法就会突破这个上限，第一版正是这样把砂面顶到过曝的。
    float caus = caustics(iso * 1.1, uTime, min(uDetail, 1));
    sand *= 1.0 + caus * 0.75 * uDaylight;

    col = mix(col, sand, sandMask);
  }

  // ——— 3. 焦散 ———
  if (hasLayer(L_CAUSTICS)) {
    // 焦散是水面的光被聚焦后投下来的，越靠底越清晰、越靠水面越弥散
    float focus = smoothstep(0.0, 0.55, depth);
    float caus = caustics(iso * 1.5 + vec2(uTime * 0.012, 0.0), uTime, uDetail);

    // ⚠️ 这里**不要**再乘 sandMask：砂在自己的着色里已经算过一次焦散。
    // 两处相乘会得到 ~2.7 倍，直接把砂面顶到纯白 —— 这个 bug 我修了两轮才找到，
    // 因为症状（砂白）和病因（重复应用）隔着一个「看着都挺合理」的中间层。
    col *= 1.0 + uCaustic * caus * (1.0 - sandMask) * focus * uDaylight * 0.55;
    // 水中悬浮的焦散
    col *= 1.0 + uCaustic * caus * focus * 0.10 * uDaylight;
  }

  // ——— 4. 植物 ———
  // 画在底砂之后、几何景观之前：让部分植物被石头挡住，
  // 这一层遮挡关系比「植物全都浮在最前面」更有纵深。
  if (hasLayer(L_FLORA)) {
    // 把实际缸体的宽高比换算回烘焙时的比例。
    // 不这么做的话，宽屏上植物会被横向拉长 —— 因为骨架是直接在
    // 归一化 uv 里生成的，而 uv 的两个轴在屏幕上不等长。
    vec2 fuv = vec2((t.x - 0.5) * (uFloraAspect / max(0.05, aspect)) + 0.5, t.y);
    vec4 f = texture(uFlora, fuv);

    // 生长进度：只有已经长出来的那一段才显示
    float mask = f.a * step(f.r, uGrowth);
    if (mask > 0.002) {
      // 每株自己的色相（B），从根到梢由深到亮（G）
      // 色相谱从水色铺到强调色，再掺一点青色 —— 一整丛同色会显得很假
      vec3 tint = mix(mix(uFog, uCaustic, 0.35), uAccent, f.b);
      vec3 leaf = mix(tint * 0.60, tint * 1.75, f.g);

      // 生长前沿发光：正在抽出来的那一段最亮。
      // 这一笔让开场动画从「逐渐出现」变成「在生长」。
      float front = exp(-pow((uGrowth - f.r) * 12.0, 2.0));
      leaf += uLight * front * 0.60 * uDaylight;

      // 水下的深度衰减，让植物融进水体而不是贴在前面
      leaf = mix(leaf, uFog, depth * turb * 0.45);

      col = mix(col, leaf, mask);
    }
  }

  // ——— 5. 几何景观 ———
  if (hasLayer(L_HARDSCAPE)) {
    vec2 local;
    vec2 halfSize;
    float idx;
    float roundness;
    float d = geometricSDF(t, local, halfSize, idx, roundness);

    // 光晕：向外扩散的柔光，让几何体看起来在发光而不是剪纸。
    float halo = exp(-max(0.0, d) * 55.0) * 0.06;
    col += mix(uLight, uAccent, 0.35) * halo * uDaylight;

    if (d < 0.03) {
      float mask = sstepDown(0.0016, -0.0016, d);

      // 每块几何体自己的色相 —— 在几何风里这就是画面的**主要色彩来源**。
      //
      // ⚠️ 不要拿底砂色当基色。那是砂的颜色：偏白、偏暖、饱和度低，
      // 一整排立起来会糊成一片白 —— 第一版就是这样，五块全成了白板。
      vec3 slabBase = mix(uFog, uAccent, hash11(idx * 7.7 + uSeed));
      slabBase = mix(slabBase, uWaterBottom, 0.34);

      // 面：从顶到底的柔和渐变（用**局部坐标**，于是渐变跟着旋转走）
      float vert = clamp((local.y + halfSize.y) / max(0.001, halfSize.y * 2.0), 0.0, 1.0);
      vec3 slab = mix(slabBase * 1.15, slabBase * 0.42, vert * vert);

      // 顶部的受光边
      float topEdge = sstepDown(halfSize.y * 0.72, halfSize.y * 0.30, -local.y);
      slab += uLight * topEdge * 0.11 * uDaylight;

      // 左缘受光边
      float leftEdge = smoothstep(halfSize.x * 0.45, halfSize.x * 0.92, -local.x);
      slab += uLight * leftEdge * 0.06 * uDaylight;

      // 接触阴影：贴近砂面的地方压暗，几何体才「坐得住」
      float contact = smoothstep(halfSize.y * 0.30, halfSize.y * 0.95, local.y);
      slab *= mix(1.0, 0.58, contact);

      // 半透明：圆头的那几块当作磨砂亚克力，能隐约透出水色。
      // 全部不透明的话，一排实心色块会显得很闷。
      float translucency = roundness * 0.30;
      slab = mix(slab, col * 0.85 + slabBase * 0.5, translucency);
      slab += uLight * mask * 0.03 * uDaylight;

      col = mix(col, slab, mask);
    }
  }

  // ——— 6. 水下光柱 ———
  if (hasLayer(L_GODRAYS)) {
    float shafts = lightShafts(iso, uTime, uLightDir);
    // 体积光是**散射介质**：它朝观察者发光，同时也遮挡背后的东西。
    // 所以是 mix（朝光柱的颜色收敛），不是 add。
    // 用加法的话，它和 bokeh、光晕叠在一起会把背后的砂面推到过曝 ——
    // 而且物理上加法允许无限叠加，而散射是有上限的。
    float density = shafts * uDaylight * 0.30 * (1.0 - depth * 0.40);
    col = mix(col, mix(uLight, uCaustic, 0.30), clamp(density, 0.0, 1.0));
  }

  // ——— 7. 悬浮物与失焦光斑 ———
  if (hasLayer(L_PARTICULATE)) {
    // 远景：看得清的细小颗粒，提供景深的最远一层
    float motes = marineSnow(iso, uTime, uDetail >= 1 ? 22.0 : 14.0, uSeed, 0.55);
    col += uLight * motes * 0.07 * mix(1.0, 0.25, depth) * uDaylight;

    // 近景的失焦光斑**不在这里画** —— 它是前景，必须盖在鱼之上。
    // 放在场景 pass 里的话，鱼会画在它前面，前后关系就反了。
    // 它现在在合成 pass 里，见 post.ts。

    // 偶尔一串气泡从底砂升起。周期由 floor(uTime * k) 切成一段段，
    // 每段用哈希取一个横坐标 —— 于是气泡是「一波一波」而不是永不停歇。
    float cycle = floor(uTime * 0.5);
    float bx = 0.12 + 0.76 * hash11(cycle + uSeed);
    float rise = fract(uTime * 0.09 + hash11(cycle + 3.0));
    vec2 bpos = vec2(bx + 0.028 * sin(rise * 24.0 + hash11(cycle) * 6.0), 1.0 - rise);
    float bd = length((t - bpos) * vec2(aspect, 1.0));
    float radius = mix(0.004, 0.009, rise);
    float bubble = sstepDown(radius * 2.4, radius, bd)
                 * smoothstep(0.0, 0.08, rise)
                 * sstepDown(1.0, 0.82, rise);
    col += uLight * bubble * 0.40;
  }

  // ——— 8. 水面 ———
  {
    float wave = surfaceWave(vec2(t.x * aspect, 0.0), uTime) * 0.006;
    float surfaceY = waterLine + wave;

    // 水面是镜面，会把顶灯反射成一条亮线。梦幻风里让它更宽更柔。
    float band = exp(-pow((t.y - surfaceY) * 46.0, 2.0));
    col = mix(col, uLight, clamp(band * uDaylight * 0.75, 0.0, 1.0));

    // 水面之下的薄层被照亮（光线刚进入水体）
    float justBelow = exp(-max(0.0, t.y - surfaceY) * 22.0);
    col += uCaustic * justBelow * 0.14 * uDaylight;

    // 水线之上的空气压暗一点，让水线读得出来
    float aboveBand = sstepDown(surfaceY + 0.006, surfaceY - 0.006, t.y);
    col = mix(col, col * 0.62, aboveBand * step(waterLine + 0.02, t.y));
  }

  // ——— 9. 远景柔化 ———
  if (hasLayer(L_BACKMURK)) {
    // 越靠画面上方（远离观察者）越被雾吃掉
    float far = smoothstep(waterLine, 0.35, t.y);
    col = mix(col, uFog, (1.0 - far) * turb * 0.28);
  }

  // ——— 10. 环境光与整体对比 ———
  col *= mix(0.62, 1.0, uAmbient);
  col += uAccent * 0.012;

  return vec4(col, 1.0);
}

// ————————————————————————————————————————————————————————————

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 t = (uv - uTankRect.xy) / max(vec2(0.0001), uTankRect.zw);
  float aspect = (uTankRect.z * uRes.x) / max(1.0, uTankRect.w * uRes.y);

  // 缸体遮罩。圆窗模式用椭圆距离，边界留一圈柔化。
  float inside;
  if (uShape == 1) {
    vec2 q = (t - 0.5) * 2.0;
    inside = sstepDown(1.02, 0.99, length(q * vec2(1.0, 1.02)));
  } else {
    vec2 edge = min(t, 1.0 - t);
    inside = smoothstep(0.0, 0.0035, min(edge.x, edge.y));
  }

  // ——— 缸外背景 ———
  vec3 bg = vec3(0.0);
  float bgAlpha = 0.0;
  if (uBackground == 0) {
    bg = uFog * 0.05;
    bgAlpha = 1.0;
  } else if (uBackground == 1) {
    bg = generativeBackdrop(uv);
    bgAlpha = 1.0;
  }
  // uBackground == 2 (transparent) / 3 (page) → 保持 0

  vec4 water = renderTank(t, uv, aspect);
  float mixAmount = inside;

  vec3 col = mix(bg, water.rgb, mixAmount);
  float alpha = mix(bgAlpha, 1.0, mixAmount);

  // 圆窗之外完全透明，否则会在网页上糊一个方块
  if (uShape == 1) alpha *= inside;

  fragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;
