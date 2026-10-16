/**
 * 视觉预览 / 截图。
 *
 * 起一个静态服务器伺候 `dist/`，用 headless Chromium 打开指定页面并截图。
 *
 * 这条路走得通是因为 `src/core/storage.ts` 在没有 chrome.storage 的环境里
 * 会自动退回 localStorage —— **同一份产物既能作为扩展运行，也能当普通网页打开**。
 * 调着色器时这一点极其重要：不必每次去 chrome://extensions 重新加载。
 *
 * 截图走 CDP 轮询页面自己报告的就绪状态，不用固定延时 ——
 * 原因见 tools/harness.mjs 顶部的说明。
 *
 * 用法：
 *   node tools/preview.mjs                                     # 新标签页，默认参数
 *   node tools/preview.mjs --q "theme=abyss&quality=high"       # 换主题、指定画质
 *   node tools/preview.mjs --q "only=substrate,caustics"        # 只留两层，逐层排查
 *   node tools/preview.mjs --page options/index.html            # 截设置页
 *   node tools/preview.mjs --ext                               # 以扩展身份加载（chrome-extension://）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, startStaticServer, extensionIdFor } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function parseArgs(argv) {
  const out = {
    page: 'newtab/index.html',
    q: '',
    out: path.join(ROOT, '.preview', 'shot.png'),
    width: 1600,
    height: 900,
    settle: 600,
    ext: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--page') out.page = next();
    else if (a === '--q') out.q = next();
    else if (a === '--out') out.out = path.resolve(process.cwd(), next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--settle') out.settle = Number(next());
    else if (a === '--ext') out.ext = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.q ? `?${args.q}` : '';

  let url;
  let server = null;
  if (args.ext) {
    // 以真正的扩展身份加载：用于确认 chrome-extension:// 下的行为
    url = `chrome-extension://${extensionIdFor(DIST)}/${args.page}${query}`;
  } else {
    server = await startStaticServer(DIST);
    url = `http://127.0.0.1:${server.port}/${args.page}${query}`;
  }

  console.log(`[preview] ${url}`);

  try {
    const result = await capture({
      url,
      out: args.out,
      width: args.width,
      height: args.height,
      loadExtension: args.ext ? DIST : undefined,
      settleMs: args.settle,
    });

    for (const line of result.console) console.log(`   ${line.slice(0, 500)}`);
    console.log(`[preview] 已渲染 ${result.frames} 帧 → ${args.out}`);
  } finally {
    server?.close();
  }
}

main().catch((err) => {
  console.error('[preview] 失败：', err.message ?? err);
  process.exit(1);
});
