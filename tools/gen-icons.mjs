/**
 * 图标生成器。
 *
 * 这个扩展的图标不由设计师画出，而是**由代码算出来** —— 跟鱼缸本身一样。
 * 顺带省掉了往仓库里塞二进制资源这件事。
 *
 * 做法：在一个远高于目标尺寸的分辨率上按形状方程硬边渲染，
 * 再盒式降采样到各档尺寸。降采样天然带来抗锯齿，比手写 AA 稳。
 *
 * 完全不依赖任何图像库：PNG 的编码用的是 zlib + 手写 CRC32。
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'dist', 'icons');

// ————————————————————————————————————————————————————————————
// 最小 PNG 编码器
// ————————————————————————————————————————————————————————————

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA8 像素缓冲 -> PNG。 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 非隔行

  // 每行前面要加一个滤波类型字节。用 0（None）—— 图像很小，压缩率无所谓。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ————————————————————————————————————————————————————————————
// 形状与着色
// ————————————————————————————————————————————————————————————

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * 便宜的 2D 哈希，用来做砂粒。
 * 千万别用 `sin(x*k)*sin(y*k)` 这种写法 —— 两个正弦的乘积是标准的棋盘格。
 */
function grain(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}


/** 圆角矩形的内外判定，`p` 在 [0,1]² 中。 */
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** 重心坐标判定的三角形（用于鱼尾）。 */
function insideTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return false;
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const c = 1 - a - b;
  return a >= 0 && b >= 0 && c >= 0;
}

const PALETTE = {
  backdropTop: [0.055, 0.106, 0.145],
  backdropBottom: [0.024, 0.055, 0.086],
  waterTop: [0.165, 0.498, 0.62],
  waterBottom: [0.027, 0.102, 0.165],
  caustic: [0.45, 0.85, 0.95],
  sand: [0.72, 0.67, 0.55],
  fishBody: [0.5, 0.89, 0.95],
  fishBack: [0.13, 0.32, 0.44],
  fishEye: [0.03, 0.06, 0.09],
  lamp: [1.0, 0.98, 0.9],
};

/**
 * 在归一化坐标 `(x, y)`（y 向下）处取色。
 * 返回 `[r, g, b, a]`，分量都在 0..1。
 */
function shade(x, y) {
  // —— 外层圆角方块：在浅色和深色工具栏上都能立住 ——
  if (!insideRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) {
    return [0, 0, 0, 0];
  }

  const t = clamp01((y - 0.02) / 0.96);
  let r = mix(PALETTE.backdropTop[0], PALETTE.backdropBottom[0], t);
  let g = mix(PALETTE.backdropTop[1], PALETTE.backdropBottom[1], t);
  let b = mix(PALETTE.backdropTop[2], PALETTE.backdropBottom[2], t);

  // —— 缸体 ——
  const inTank = insideRoundedRect(x, y, 0.10, 0.15, 0.90, 0.86, 0.055);
  if (!inTank) {
    // 缸体外的极淡高光，让图标有玻璃的层次
    const edge = smoothstep(0.28, 0.0, Math.hypot(x - 0.5, y - 0.5));
    return [r + edge * 0.05, g + edge * 0.055, b + edge * 0.06, 1];
  }

  const waterline = 0.235;
  if (y < waterline) {
    // 水面之上的空气层：更暗，顶部有一条灯管
    const lamp = Math.exp(-Math.pow((y - 0.175) * 26, 2));
    r = 0.03 + PALETTE.lamp[0] * lamp * 0.75;
    g = 0.055 + PALETTE.lamp[1] * lamp * 0.75;
    b = 0.076 + PALETTE.lamp[2] * lamp * 0.75;
  } else {
    // 水体：深度渐变
    const d = clamp01((y - waterline) / (0.86 - waterline));
    r = mix(PALETTE.waterTop[0], PALETTE.waterBottom[0], Math.pow(d, 0.75));
    g = mix(PALETTE.waterTop[1], PALETTE.waterBottom[1], Math.pow(d, 0.75));
    b = mix(PALETTE.waterTop[2], PALETTE.waterBottom[2], Math.pow(d, 0.75));

    // 焦散：两条不同频率的波叠加，只在底砂以上出现
    const caus =
      Math.pow(
        Math.max(
          0,
          Math.sin(x * 26 + y * 7) * 0.5 + Math.sin(x * 15 - y * 11 + 1.7) * 0.5,
        ),
        3,
      ) * smoothstep(0.30, 0.62, y);
    r += PALETTE.caustic[0] * caus * 0.30;
    g += PALETTE.caustic[1] * caus * 0.30;
    b += PALETTE.caustic[2] * caus * 0.30;

    // 水面高光
    const surface = Math.exp(-Math.pow((y - waterline) * 90, 2));
    r += PALETTE.lamp[0] * surface * 0.5;
    g += PALETTE.lamp[1] * surface * 0.5;
    b += PALETTE.lamp[2] * surface * 0.5;

    // 底砂。两层颗粒：细的一层用哈希，粗的一层用低频起伏做堆积感。
    if (y > 0.775) {
      const fine = grain(x * 220, y * 260);
      const coarse = 0.5 + 0.5 * Math.sin(y * 34 + Math.sin(x * 9) * 2.5);
      const shade = 0.66 + 0.22 * fine + 0.12 * coarse;
      r = mix(r, PALETTE.sand[0] * shade, 0.9);
      g = mix(g, PALETTE.sand[1] * shade, 0.9);
      b = mix(b, PALETTE.sand[2] * shade, 0.9);
    }

    // —— 鱼 ——
    // 尾巴先画。三角形的顶点塞进身体内部一点，避免接缝处出现一条亮线。
    const inTail = insideTriangle(x, y, 0.545, 0.575, 0.755, 0.452, 0.755, 0.698);
    const inBody = insideEllipse(x, y, 0.445, 0.575, 0.180, 0.100);

    if (inTail && !inBody) {
      // 尾鳍是半透明的膜：比身体更暗一点、更蓝一点
      const fin = 0.72 + 0.28 * clamp01((y - 0.47) / 0.21);
      r = PALETTE.fishBack[0] * fin + 0.05;
      g = PALETTE.fishBack[1] * fin + 0.12;
      b = PALETTE.fishBack[2] * fin + 0.17;
    }

    if (inBody) {
      // 背深腹浅：上半身压暗，得到体积感
      const belly = clamp01((y - 0.495) / 0.165);
      let fr = mix(PALETTE.fishBack[0], PALETTE.fishBody[0], belly);
      let fg = mix(PALETTE.fishBack[1], PALETTE.fishBody[1], belly);
      let fb = mix(PALETTE.fishBack[2], PALETTE.fishBody[2], belly);

      // 身体下缘的一道亮边 —— 缸里的鱼几乎总是被下方的砂面反光照亮
      const rim = smoothstep(0.62, 0.72, y);
      fr = mix(fr, 0.92, rim * 0.5);
      fg = mix(fg, 0.98, rim * 0.5);
      fb = mix(fb, 1.0, rim * 0.5);

      r = fr;
      g = fg;
      b = fb;

      // 眼睛
      if (insideEllipse(x, y, 0.345, 0.549, 0.023, 0.023)) {
        r = PALETTE.fishEye[0];
        g = PALETTE.fishEye[1];
        b = PALETTE.fishEye[2];
      }
    }
  }

  // —— 玻璃：内边缘一圈更亮的框，这是「缸」最直接的信号 ——
  const glassInner = insideRoundedRect(x, y, 0.088, 0.138, 0.912, 0.872, 0.062);
  if (!glassInner) {
    r = mix(r, 0.62, 0.32);
    g = mix(g, 0.78, 0.32);
    b = mix(b, 0.72, 0.32);
  }

  return [clamp01(r), clamp01(g), clamp01(b), 1];
}

// ————————————————————————————————————————————————————————————
// 渲染与降采样
// ————————————————————————————————————————————————————————————



function renderAt(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 采样点取像素中心
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const [r, g, b, a] = shade(x, y);
      const o = (py * size + px) * 4;
      buf[o] = Math.round(r * 255);
      buf[o + 1] = Math.round(g * 255);
      buf[o + 2] = Math.round(b * 255);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

/** 盒式降采样。这就是我们的抗锯齿。 */
function downsample(src, srcSize, factor) {
  const dstSize = srcSize / factor;
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const area = factor * factor;

  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const o = ((y * factor + sy) * srcSize + (x * factor + sx)) * 4;
          // 预乘后再平均，否则透明边缘会混进黑色
          const alpha = src[o + 3] / 255;
          r += src[o] * alpha;
          g += src[o + 1] * alpha;
          b += src[o + 2] * alpha;
          a += src[o + 3];
        }
      }
      const o = (y * dstSize + x) * 4;
      const aAvg = a / area;
      const aNorm = aAvg / 255;
      dst[o] = aNorm > 0 ? Math.round(r / area / aNorm) : 0;
      dst[o + 1] = aNorm > 0 ? Math.round(g / area / aNorm) : 0;
      dst[o + 2] = aNorm > 0 ? Math.round(b / area / aNorm) : 0;
      dst[o + 3] = Math.round(aAvg);
    }
  }
  return { buf: dst, size: dstSize };
}

const SIZES = [16, 32, 48, 128];

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

/**
 * 主图尺寸必须能被每一档整除，否则降采样因子不是整数，
 * 就会出现「128 和 48 用不同算法」这种不一致。
 * LCM(16,32,48,128) = 384，再乘 2 留出余量，得到更好的边缘质量。
 */
const MASTER = lcm(lcm(lcm(16, 32), 48), 128) * 2;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`[icons] 渲染主图 ${MASTER}×${MASTER} …`);
  const src = renderAt(MASTER);

  for (const size of SIZES) {
    const factor = MASTER / size;
    if (!Number.isInteger(factor)) {
      throw new Error(`降采样因子必须是整数：${MASTER} / ${size}`);
    }
    const { buf } = downsample(src, MASTER, factor);
    const png = encodePng(size, size, buf);
    const file = path.join(OUT_DIR, `${size}.png`);
    await writeFile(file, png);
    console.log(`[icons] ${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
  }

  console.log('[icons] 完成');
}

main().catch((err) => {
  console.error('[icons] 失败：', err);
  process.exit(1);
});
