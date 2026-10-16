#!/usr/bin/env node
/**
 * 外观预览。
 *
 * 调画面时最要紧的是**循环短**：改一行着色器 → 几百毫秒后看到图。
 * 走完整的扩展加载（`preview.mjs --ext`）要多好几秒，而且会被
 * 设置页、存储、标签页 API 这些东西牵连 —— 调一个颜色不该有这么多步骤。
 *
 * 所以这个工具把渲染层单独拎出来，塞进一个最小页面里跑。
 * 它**不经过扩展机制**，只验证「画面好不好看」这一件事。
 *
 * 用法：
 *   node tools/look.mjs                        默认渲染一帧
 *   node tools/look.mjs --theme=vent           换主题
 *   node tools/look.mjs --time=40 --n=20       指定时刻与生物数量
 *   node tools/look.mjs --layers=all           开全部图层
 *   node tools/look.mjs --out=x.png            指定输出
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import { build } from 'esbuild';
import { capture, startStaticServer } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {
    theme: 'abyss',
    time: 24,
    n: 14,
    layers: 'all',
    out: path.join(ROOT, '.preview', 'look.png'),
    width: 1600,
    height: 900,
    bloom: true,
    scale: 0.62,
    backdropId: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a.startsWith('--theme=')) out.theme = a.slice(8);
    else if (a.startsWith('--out=')) out.out = path.resolve(process.cwd(), a.slice(6));
    else if (a.startsWith('--time=')) out.time = Number(a.slice(7));
    else if (a.startsWith('--n=')) out.n = Number(a.slice(4));
    else if (a.startsWith('--layers=')) out.layers = a.slice(9);
    else if (a.startsWith('--width=')) out.width = Number(a.slice(8));
    else if (a.startsWith('--height=')) out.height = Number(a.slice(9));
    else if (a.startsWith('--scale=')) out.scale = Number(a.slice(8));
    else if (a.startsWith('--backdrop=')) out.backdropId = Number(a.slice(11));
    else if (a === '--nobloom') out.bloom = false;
    else if (a === '--help') {
      console.log(await0());
      process.exit(0);
    }
  }
  return out;
}

function await0() {
  return '用法见文件头注释';
}

/**
 * 预览页的入口。
 *
 * 刻意保持很小 —— 它只是把渲染器和一批假生物接起来，
 * 好让画面能出来。任何和「画面」无关的东西都不该出现在这里。
 */
function entrySource(args) {
  return `
import { createContext, createRenderTarget, bindTarget, drawFullscreen,
         createFullscreenVao, Program } from './src/render/gl.js';
import { SCENE_FS, SCENE_VS, L_SURFACE, L_CAUSTICS, L_RAYS, L_SNOW, L_VIGNETTE }
  from './src/render/shaders/scene.js';
import { CreatureRenderer } from './src/render/creatures.js';
import { Flock } from './src/core/creatures.js';
import { createTabSource } from './src/core/tabs.js';
import { paletteFor } from './src/core/theme.js';

const BACKDROP_ID = ${args.backdropId};
const SCALE = ${args.scale};
const THEME = ${JSON.stringify(args.theme)};
const TIME = ${args.time};
const COUNT = ${args.n};
const WANT_BLOOM = ${args.bloom};

const LAYER_SETS = {
  all: L_SURFACE | L_CAUSTICS | L_RAYS | L_SNOW | L_VIGNETTE,
  none: 0,
  water: L_SURFACE | L_VIGNETTE,
  light: L_CAUSTICS | L_RAYS,
  snow: L_SNOW,
};
const LAYERS = LAYER_SETS[${JSON.stringify(args.layers)}] ?? LAYER_SETS.all;

const palette = paletteFor(THEME);

const canvas = document.getElementById('c');
const ctx = createContext(canvas, { preferFloatTargets: true, alpha: true });
const gl = ctx.gl;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
resize();

const sceneRT = createRenderTarget(gl, canvas.width, canvas.height, ctx.floatTargets);
const vao = createFullscreenVao(gl);

const sceneProg = new Program(gl, SCENE_FS, SCENE_VS);

/**
 * 合成 pass：把场景纹理贴到屏幕上，并叠一层**简易辉光**。
 *
 * 辉光是这套美术的造型手段而不是润色 —— 没有它，发光生物只是一些
 * 亮色的多边形。这里先用最朴素的做法（亮部阈值 + 两次十字模糊），
 * 够验证观感；正式的实现会放到 render/shaders/post.ts 里。
 */
const COMPOSITE_FS = /* glsl */ \`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uBloomStrength;
uniform vec2 uTexel;

vec3 bright(vec2 uv) {
  vec3 c = texture(uScene, uv).rgb;
  // 软阈值：硬阈值会让辉光的边界出现一圈突兀的切线
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * smoothstep(0.22, 0.62, l);
}

void main() {
  vec2 uv = vUv;
  vec3 col = texture(uScene, uv).rgb;

  // 两次分离式十字模糊，半径逐次加大 —— 便宜的「大范围柔光」
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    sum += bright(uv + vec2(fi * uTexel.x * 2.0, 0.0)) * w;
    sum += bright(uv + vec2(0.0, fi * uTexel.y * 2.0)) * w;
    total += w * 2.0;
  }
  sum /= max(total, 0.0001);

  col += sum * uBloomStrength;
  fragColor = vec4(col, 1.0);
}
\`;
const compositeProg = new Program(gl, COMPOSITE_FS, SCENE_VS);
const creatureRenderer = new CreatureRenderer(gl);

// 生物来自**标签页**。非扩展环境下 createTabSource() 会自动退回演示数据，
// 所以这个预览在浏览器里和在扩展里跑的是同一条代码路径。
// 诊断对象必须**在所有 await 之前**建好 —— 下面的 loadTabs 是顶层 await，
// 而它要往这里写东西。放在文件末尾会在扩展加载时直接抛 undefined。
window.__aqua = {
  ready: false, frames: 0, renderer: ctx.renderer, software: ctx.software,
  floatTargets: ctx.floatTargets, creatures: 0, tabs: 0, states: null,
};

const tabSource = createTabSource();
const flock = new Flock({ maxCreatures: COUNT });
let creatures = [];

async function loadTabs() {
  const all = await tabSource.list();
  const tabs = all.slice(0, COUNT);
  // 推进到渐入完成 —— 静态预览不该看到刚出生的半透明生物
  for (let k = 0; k < 80; k++) flock.sync(tabs, 0.05);
  creatures = flock.list.slice();
  window.__aqua.tabs = tabs.length;
  window.__aqua.states = {
    pinned: tabs.filter((t) => t.pinned).length,
    audible: tabs.filter((t) => t.audible).length,
    discarded: tabs.filter((t) => t.discarded).length,
    titles: tabSource.hasTitles,
  };
}
await loadTabs();

function frame() {
  resize();
  const w = canvas.width, h = canvas.height;
  const aspect = w / Math.max(1, h);

  gl.viewport(0, 0, w, h);
  bindTarget(gl, sceneRT, w, h);

  const p = sceneProg.use();
  p.vec4('uTankRect', 0, 0, 1, 1);
  p.vec2('uResolution', w, h);
  p.float('uAspect', aspect);
  p.float('uTime', TIME);
  p.float('uSeed', 3.7);
  p.float('uIntro', 1);
  p.vec3a('uWaterTop', palette.waterTop);
  p.vec3a('uWaterDeep', palette.waterDeep);
  p.vec3a('uLight', palette.light);
  p.vec3a('uCaustic', palette.caustic);
  p.float('uAmbient', palette.ambient);
  p.float('uTurbidity', palette.turbidity);
  p.int('uDetail', 2);
  p.int('uLayers', LAYERS);
  p.int('uBackdrop', BACKDROP_ID);
  gl.disable(gl.BLEND);
  drawFullscreen(gl);

  creatureRenderer.render({
    tankRect: [0, 0, 1, 1],
    creatures,
    palette,
    time: TIME,
    intro: 1,
    opacity: 1,
    creatureScale: SCALE,
  });

  bindTarget(gl, null, w, h);
  gl.disable(gl.BLEND);

  const cp = compositeProg.use();
  cp.texture('uScene', 0, sceneRT.texture);
  cp.float('uBloomStrength', WANT_BLOOM ? 1.15 * palette.bloom : 0);
  cp.vec2('uTexel', 1 / w, 1 / h);
  drawFullscreen(gl);

  window.__aqua.frames++;

  // 状态 → 外观的映射表。用眼睛比较尺寸差太不可靠，直接对数据。
  if (window.__aqua.frames === 2) {
    const rows = creatures.map((c) =>
      [
        'PADF'.split('').map((f, i) =>
          [c.pinned, c.audible, c.discarded, c.active][i] ? f : '.',
        ).join(''),
        'energy=' + c.energy.toFixed(2),
        'scale=' + c.scale.toFixed(2),
        c.shape,
      ].join(' '),
    );
    const school = creatures.map((c) => (c.schooling > 0 ? c.schoolId : '-')).join('');
    console.log('[school] ' + school + '  （数字 = 群号，- = 独居）');
    console.log('[states]');
    for (const r of rows) console.log('  ' + r);
  }

  if (window.__aqua.frames >= 3) window.__aqua.ready = true;
  requestAnimationFrame(frame);
}


requestAnimationFrame(frame);
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aqua-look-'));
  const bundle = await build({
    stdin: { contents: entrySource(args), resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const js = bundle.outputFiles[0].text;

  await fs.writeFile(
    path.join(tmp, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#000;overflow:hidden}
      #c{display:block;width:100vw;height:100vh}
    </style></head><body><canvas id="c"></canvas>
    <script type="module">${js}</script></body></html>`,
  );

  const server = await startStaticServer(tmp);
  const url = `http://127.0.0.1:${server.port}/index.html`;

  try {
    const res = await capture({
      url,
      out: args.out,
      width: args.width,
      height: args.height,
      settleMs: 900,
      keepAnimating: true,
    });
    for (const line of res.console) console.log(`   ${line.slice(0, 400)}`);
    const w = await res.evaluate?.();
    void w;
    console.log(`[look] ${args.theme} · t=${args.time} · ${args.n} 只 → ${args.out}`);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[look] 失败：', err.message);
  process.exit(1);
});
