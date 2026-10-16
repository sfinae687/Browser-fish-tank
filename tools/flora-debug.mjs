/**
 * 植物骨架诊断。
 *
 * 渲染出来的形态不对时，隔着「着色器 + 烘焙 + 分层」去猜是没用的 ——
 * 症状（一摞横向笔触）和病因（拓扑结构）中间隔了三层。
 * 这个工具把骨架直接画出来：节点、父子连线、深度着色，
 * 一眼就能看出算法到底长出了什么。
 *
 * 用法：
 *   node tools/flora-debug.mjs                 # 默认种子
 *   node tools/flora-debug.mjs --seed=xxx
 *   node tools/flora-debug.mjs --stats         # 只看拓扑统计，不出图
 */

import * as esbuild from 'esbuild';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.preview');

// ——— 最小 PNG 编码器（与 gen-icons.mjs 同源） ———
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function writePng(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return writeFile(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function load() {
  const r = await esbuild.build({
    stdin: {
      contents: `
        export * from './src/core/flora.ts';
        export * from './src/core/fixed.ts';
        export * from './src/core/rng.ts';
        export * from './src/render/flora-bake.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'warning',
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'flora-debug-'));
  const f = path.join(dir, 'm.mjs');
  await writeFile(f, r.outputFiles[0].text);
  const mod = await import(pathToFileURL(f).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function main() {
  const seed = (process.argv.find((a) => a.startsWith('--seed=')) ?? '--seed=reef-7f3a91c2').slice(7);
  const statsOnly = process.argv.includes('--stats');
  const { mod, cleanup } = await load();

  try {
    const skeleton = mod.generateFlora(seed);
    const st = mod.floraStats(skeleton);
    console.log(`种子 ${seed}`);
    console.log(`  ${st.plants} 株 / ${st.nodes} 节点  ${JSON.stringify(st.byKind)}`);

    // ——— 拓扑统计：每株的分叉数和最长链 ———
    console.log('\n  种类    节点  分叉  根的子节点  最长链  末端数');
    for (const plant of skeleton.plants) {
      if (plant.kind !== 'coral') continue;
      const children = new Map();
      for (const n of plant.nodes) {
        if (n.parent >= 0) children.set(n.parent, (children.get(n.parent) ?? 0) + 1);
      }
      let forks = 0;
      let deepest = 0;
      for (const [, c] of children) {
        if (c >= 2) forks++;
        if (c > deepest) deepest = c;
      }
      const rootChildren = children.get(0) ?? 0;
      const leaves = plant.nodes.filter((n) => !children.has(plant.nodes.indexOf(n))).length;
      // 最长链：BFS 深度
      let maxDepth = 0;
      for (const n of plant.nodes) if (n.depth > maxDepth) maxDepth = n.depth;
      console.log(
        `  ${plant.kind.padEnd(7)} ${String(plant.nodes.length).padStart(4)}  ` +
          `${String(forks).padStart(4)}  ${String(rootChildren).padStart(10)}  ` +
          `${String(plant.nodes.length).padStart(6)}  ${String(leaves).padStart(6)}`,
      );
    }

    if (statsOnly) return;

    // ——— 把骨架画出来 ———
    const W = 1280;
    const H = 800;
    const buf = Buffer.alloc(W * H * 4);
    // 背景
    for (let i = 0; i < W * H; i++) {
      buf[i * 4] = 14;
      buf[i * 4 + 1] = 20;
      buf[i * 4 + 2] = 28;
      buf[i * 4 + 3] = 255;
    }
    const px = (x, y, r, g, b) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
      const o = (yi * W + xi) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
    };
    const line = (x0, y0, x1, y1, r, g, b) => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2 + 1;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        px(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, g, b);
      }
    };

    // 砂线
    const seedNum = mod.hashString(seed) % 100000;
    for (let x = 0; x < W; x++) {
      const y = mod.substrateHeightAt(x / W, seedNum) * H;
      px(x, y, 60, 60, 70);
      px(x, y + 1, 45, 45, 55);
    }

    const KIND_COLOR = { coral: [255, 120, 110], kelp: [120, 230, 170], grass: [140, 180, 255] };
    for (const plant of skeleton.plants) {
      const col = KIND_COLOR[plant.kind] ?? [255, 255, 255];
      for (const n of plant.nodes) {
        const x = mod.unfx(n.x) * W;
        const y = mod.unfx(n.y) * H;
        if (n.parent >= 0) {
          const p = plant.nodes[n.parent];
          // 颜色随深度变亮：根暗梢亮
          const k = 0.45 + 0.55 * mod.unfx(n.depth);
          line(mod.unfx(p.x) * W, mod.unfx(p.y) * H, x, y, col[0] * k, col[1] * k, col[2] * k);
        }
        px(x, y, 255, 255, 255);
        px(x + 1, y, 255, 255, 255);
        px(x, y + 1, 255, 255, 255);
      }
    }

    const outFile = path.join(OUT, 'flora-skeleton.png');
    await writePng(outFile, W, H, buf);
    console.log(`\n  骨架图 → ${path.relative(ROOT, outFile)}`);

    // ——— 顺带把烘焙结果的可视化也出一张 ———
    const baked = mod.bakeFlora(skeleton, mod.isqrt);
    const bb = Buffer.alloc(baked.width * baked.height * 4);
    for (let i = 0; i < baked.width * baked.height; i++) {
      const a = baked.pixels[i * 4 + 3];
      // 用覆盖当灰度，R 通道当暖色，看生长顺序的分布
      bb[i * 4] = Math.round((baked.pixels[i * 4] * 0.5 + a * 0.5) * (a / 255));
      bb[i * 4 + 1] = Math.round(a * 0.85);
      bb[i * 4 + 2] = Math.round(a * 0.7);
      bb[i * 4 + 3] = 255;
    }
    const bakedFile = path.join(OUT, 'flora-baked.png');
    await writePng(bakedFile, baked.width, baked.height, bb);
    console.log(`  烘焙图 → ${path.relative(ROOT, bakedFile)}`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
