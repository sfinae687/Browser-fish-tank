/**
 * 构建脚本。
 *
 * 四条产物，三种模块格式，原因各不相同：
 *
 *   newtab / options   ESM   —— 普通页面，可以用模块
 *   service worker     ESM   —— manifest 里声明了 type: module
 *   overlay            IIFE  —— **MV3 的 content script 不支持 ES module**，
 *                               只能是经典脚本。这是唯一不能统一的地方。
 */

import * as esbuild from 'esbuild';
import { rm, mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // 本文件就在仓库根目录
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const watch = process.argv.includes('--watch');

/** 需要原样拷贝的静态资源：路径保持不变，manifest 里的引用才对得上。 */
const STATIC = [
  ['manifest.json', 'manifest.json'],
  ['surfaces/newtab/index.html', 'newtab/index.html'],
  ['surfaces/newtab/newtab.css', 'newtab/newtab.css'],
  ['surfaces/options/index.html', 'options/index.html'],
  ['surfaces/options/options.css', 'options/options.css'],
];

const ENTRIES = [
  { in: 'surfaces/newtab/newtab.ts', out: 'newtab/newtab.js', format: 'esm' },
  { in: 'surfaces/options/options.ts', out: 'options/options.js', format: 'esm' },
  { in: 'bg/service-worker.ts', out: 'bg/service-worker.js', format: 'esm' },
  { in: 'surfaces/overlay/overlay.ts', out: 'overlay/overlay.js', format: 'iife' },
];

/**
 * 共享的 esbuild 配置。
 *
 * `target` 对齐 manifest 的 minimum_chrome_version —— 只针对 Chromium，
 * 所以不需要为旧浏览器降级，也就可以放心用 optional chaining、
 * 顶层 await（在 ESM 产物里）这些现代语法。
 */
function buildOptions(entry) {
  return {
    entryPoints: [path.join(SRC, entry.in)],
    outfile: path.join(DIST, entry.out),
    bundle: true,
    format: entry.format,
    target: 'chrome114',
    platform: 'browser',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    legalComments: 'none',
    logLevel: 'warning',
    // 产物目录由上面统一管理，esbuild 不需要额外清理
    metafile: false,
  };
}

async function copyStatic() {
  for (const [from, to] of STATIC) {
    const dest = path.join(DIST, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(SRC, from), dest);
  }
}

function runIcons() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'gen-icons.mjs')], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`gen-icons 退出码 ${code}`)),
    );
  });
}

/**
 * 着色器源码内联在 TS 模板字符串里，所以注释里出现一个反引号
 * 就会直接终结模板 —— esbuild 随后报的错会指向 GLSL 内部的某一行，
 * 完全看不出真正的原因。这个问题我已经踩过两次，值得用代码挡住。
 *
 * 依赖一条固定的书写约定：模板以下面这行开始
 *     export const X_FS = /* glsl *\/ `
 * 并以单独一行的 `` `; `` 结束。介于两者之间的任何反引号都是错误。
 */
async function lintShaderTemplates() {
  const dir = path.join(SRC, 'render', 'shaders');
  const problems = [];
  let opened = 0;

  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.ts'))) {
    const lines = (await readFile(path.join(dir, name), 'utf8')).split('\n');
    let inside = false;

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!inside) {
        // 开头这行本身带一个反引号，是合法的
        if (/=\s*(\/\*\s*glsl\s*\*\/\s*)?`\s*$/.test(line)) {
          inside = true;
          opened++;
        }
        return;
      }
      if (trimmed === '`;' || trimmed === '`') {
        inside = false;
        return;
      }
      if (line.includes('`')) {
        problems.push(`${name}:${i + 1}  模板内部出现裸反引号：${trimmed.slice(0, 70)}`);
      }
    });

    if (inside) problems.push(`${name}  模板字符串没有闭合（缺少单独一行的 \`;）`);
  }

  if (opened === 0) {
    problems.push('一个着色器模板都没识别到 —— 检查 build.mjs 的 lintShaderTemplates 是否与源码写法脱节了');
  }

  if (problems.length > 0) {
    throw new Error(
      '着色器模板字符串检查未通过：\n  ' +
        problems.join('\n  ') +
        '\n  （注释里写代码片段时最容易犯。请改用普通引号。）',
    );
  }
}

async function main() {
  await lintShaderTemplates();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  if (watch) {
    const contexts = await Promise.all(
      ENTRIES.map((entry) => esbuild.context(buildOptions(entry))),
    );
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStatic();
    await runIcons();
    console.log('[build] 监听中…（改了 HTML/CSS 需要重启，TS 会自动重建）');
    return;
  }

  await Promise.all(ENTRIES.map((entry) => esbuild.build(buildOptions(entry))));
  await copyStatic();
  await runIcons();

  console.log('[build] 完成 → dist/');
  console.log('[build] 在 chrome://extensions 打开开发者模式，「加载已解压的扩展程序」选择 dist/ 目录');
}

main().catch((err) => {
  console.error('[build] 失败：', err);
  process.exit(1);
});
