/**
 * 覆盖层表面（content script）。
 *
 * 这个表面运行在**别人的网页里**，所以纪律比功能重要：
 *
 *   1. 全部内容装进 Shadow DOM —— 页面的 CSS 进不来，我们的 CSS 也出不去
 *   2. pointer-events 恒为 none —— 覆盖层绝不能吃掉用户的点击。
 *      交互（投食、涟漪）在 P5 会用**小的命中区域**实现，
 *      而不是把整个视口变成热区。整屏拦截点击是不可接受的。
 *   3. 不读页面任何内容、不发任何网络请求
 *   4. 只在用户显式开启时才注入（见 bg/service-worker.ts 的运行时注册）
 *
 * 构建产物必须是 IIFE：MV3 的 content script 不支持 ES module。
 *
 * @see DESIGN.md §8
 */

import { AquariumRunner } from '../runner.js';
import { loadConfig, onConfigChanged } from '../../core/storage.js';

const HOST_ID = '__computed_aquarium_overlay__';
const TEARDOWN_MESSAGE = 'aqua.overlay.teardown';

const SHADOW_STYLE = /* css */ `
  :host { all: initial; }
  .wrap {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    /* 恒为 none：覆盖层永远不吃点击 */
    pointer-events: none;
    z-index: 2147483647;
    contain: strict;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: none;
  }
`;

interface OverlayHandle {
  host: HTMLElement;
  runner: AquariumRunner;
  unsubscribe: () => void;
  onMessage: (msg: unknown) => void;
  dispose: () => void;
}

let handle: OverlayHandle | null = null;

async function mount(): Promise<void> {
  if (handle) return;
  // 已经在跑就别重复注入（比如扩展被重载后 content script 又跑了一次）
  if (document.getElementById(HOST_ID)) return;

  const config = await loadConfig();
  if (!config.surfaces.overlay.enabled) return;

  // ——— 建造隔离的 DOM ———
  const host = document.createElement('div');
  host.id = HOST_ID;
  // 宿主元素本身的样式也内联写死，避免被页面的 `div { }` 规则影响
  host.setAttribute(
    'style',
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;',
  );

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = SHADOW_STYLE;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');

  wrap.appendChild(canvas);
  shadow.appendChild(style);
  shadow.appendChild(wrap);

  // 挂到 <html> 而不是 <body>：有些页面会把 body 设成 flex 或加 transform，
  // 那会让 position:fixed 的参照系不再是视口
  (document.documentElement ?? document.body).appendChild(host);

  // ——— 启动渲染 ———
  const runner = new AquariumRunner({ surface: 'overlay', canvas });

  const unsubscribe = onConfigChanged((next) => {
    // 用户在设置页关掉了覆盖层 —— 立刻自己拆掉
    if (!next.surfaces.overlay.enabled) {
      dispose();
      return;
    }
    runner.updateConfig(next);
  });

  // ——— 响应拆卸指令 ———
  // unregisterContentScripts 只阻止**将来**的注入，已经跑起来的实例
  // 必须靠消息通知才会消失。
  const onMessage = (msg: unknown): void => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { t?: string }).t === TEARDOWN_MESSAGE
    ) {
      dispose();
    }
  };

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(onMessage);
    }
  } catch {
    // 扩展上下文失效（重新加载扩展后旧 content script 会变成孤儿）。
    // 这时什么也做不了，安静地继续渲染即可。
  }

  function dispose(): void {
    unsubscribe();
    try {
      chrome.runtime?.onMessage?.removeListener(onMessage);
    } catch {
      /* 忽略 */
    }
    runner.dispose();
    host.remove();
    handle = null;
  }

  await runner.start();

  if (runner.currentError) {
    // 渲染器起不来就别在别人的页面上留一个空 div
    console.warn('[计算水族箱] 覆盖层渲染器启动失败：', runner.currentError);
    dispose();
    return;
  }

  handle = { host, runner, unsubscribe, onMessage, dispose };
}

function unmount(): void {
  handle?.dispose();
  handle = null;
}

// 页面被 BFCache 缓存时应该停止渲染（省电），恢复时再起来
window.addEventListener('pagehide', unmount);
window.addEventListener('pageshow', (e) => {
  if ((e as PageTransitionEvent).persisted) void mount();
});

// 覆盖层在用户显式开启前不会被注入（见 bg/service-worker.ts 的运行时注册）。
void (async () => {
  try {
    await mount();
  } catch (err) {
    console.warn('[计算水族箱] 覆盖层注入失败：', err);
    unmount();
  }
})();
