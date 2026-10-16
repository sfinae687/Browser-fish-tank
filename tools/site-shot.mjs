#!/usr/bin/env node
/**
 * 展示页截图。
 *
 * 展示页是**给别人看的东西**，它自己坏掉比扩展坏掉更丢人 ——
 * 而且它跑在没有 chrome.* API 的环境里，和扩展里是两条不同的路径。
 * 所以它也需要自己的端到端检查，不能只靠「扩展能跑」推断。
 *
 * 用法：node tools/site-shot.mjs [--scroll=1800] [--out=.preview/site.png]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, startStaticServer } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const scroll = Number(arg('scroll', 0));
  const out = path.resolve(ROOT, arg('out', '.preview/site.png'));
  const width = Number(arg('width', 1500));
  const height = Number(arg('height', 900));

  const server = await startStaticServer(DOCS);
  const url = `http://127.0.0.1:${server.port}/index.html`;

  try {
    const res = await capture({
      url,
      out,
      width,
      height,
      keepAnimating: true,
      settleMs: 2000,
      // 用默认判据 —— 展示页和扩展页写的是同一个诊断对象
      evalAfter: scroll > 0 ? [`window.scrollTo(0, ${scroll})`] : [],
    });

    for (const line of res.console) console.log(`   ${line.slice(0, 300)}`);
    console.log(`[site-shot] ${res.frames} 帧 → ${out}`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('[site-shot] 失败：', err.message);
  process.exit(1);
});
