#!/usr/bin/env node
/**
 * 构建展示页 → docs/
 *
 * 输出到 `docs/` 而不是 `dist/`：GitHub Pages 可以直接从分支的
 * `/docs` 目录部署（Settings → Pages → Deploy from a branch → /docs），
 * 不需要额外的 CI 配置，也不需要 gh-pages 分支。
 *
 * 同时写一个 `.nojekyll` —— 没有它，GitHub Pages 会跑一遍 Jekyll，
 * 而 Jekyll 会把以下划线开头的文件当成模板并**拒绝服务**。
 */

import * as esbuild from 'esbuild';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'docs');

/** 仓库地址。构建时可以覆盖：`SITE_REPO=https://github.com/you/repo node build-site.mjs` */
const REPO_URL = process.env.SITE_REPO ?? '';

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // ——— 打包 ———
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, 'site.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    outfile: path.join(OUT, 'site.js'),
    metafile: true,
    logLevel: 'warning',
  });

  // ——— 静态文件 ———
  await copyFile(path.join(SRC, 'site.css'), path.join(OUT, 'site.css'));

  let html = await (await import('node:fs/promises')).readFile(path.join(SRC, 'index.html'), 'utf8');

  // 把仓库地址注入进去 —— 页面上那个按钮指向它。
  // 没给的话保留占位符并把按钮隐藏掉，免得点过去是个死链。
  if (REPO_URL) {
    html = html.replace(
      '<head>',
      `<head>\n    <meta name="repo-url" content="${REPO_URL}" />`,
    );
  } else {
    html = html.replace('href="https://github.com/"', 'href="#" data-placeholder="1"');
  }

  await writeFile(path.join(OUT, 'index.html'), html);
  await writeFile(path.join(OUT, '.nojekyll'), '');

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const jsSize = result.metafile ? Object.values(result.metafile.outputs)[0]?.bytes ?? 0 : 0;

  console.log(`[site] 完成 → docs/`);
  console.log(`[site]   index.html`);
  console.log(`[site]   site.css`);
  console.log(`[site]   site.js  ${kb(jsSize)}`);
  console.log(`[site]   .nojekyll`);
  if (!REPO_URL) {
    console.log(`[site] 提示：设置 SITE_REPO 环境变量可以注入仓库地址，否则按钮指向 #`);
  }
}

main().catch((err) => {
  console.error('[site] 构建失败：', err.message);
  process.exit(1);
});
