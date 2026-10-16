/**
 * 页面覆盖层。把一片深海盖在任意网页上。
 *
 * ## 三条硬约束
 *
 * **一、绝不挡住页面。** 宿主元素和画布都是 `pointer-events: none`。
 * 这片海是装饰，网页才是主体 —— 一次「点不动链接」就足以让用户卸载。
 * 代价是覆盖层里不能点生物切标签页（那需要指针事件），所以这一项
 * 在覆盖层上默认关闭、而且不提供开关。
 *
 * **二、用 Shadow DOM。** 宿主页面可能有任何全局 CSS（`* { position: static }`
 * 之流），不隔离的话样式会被打得到处都是。
 *
 * **三、只在普通网页上出现。** `chrome://`、扩展页、about: 之类的地方
 * 没有意义也不允许注入。
 *
 * ## 覆盖层的定位
 *
 * 它是「客串」不是「主场」：默认透明度 0.55、生物更少、关掉光柱和暗角、
 * 帧率上限 24。目标是**瞥一眼觉得好看，但不会干扰读正文**。
 */

import { AquariumRunner } from '../runner.js';

const HOST_ID = 'aqua-overlay-host';

/** 不该注入的地方。 */
function isInjectablePage(): boolean {
  const p = location.protocol;
  if (p !== 'http:' && p !== 'https:') return false;
  // 有些站点会把自己的顶层框架换成 file: 之类，双保险
  return true;
}

interface OverlayHandle {
  host: HTMLElement;
  runner: AquariumRunner;
  shadow: ShadowRoot;
}

let handle: OverlayHandle | null = null;

function buildDom(): { host: HTMLElement; shadow: ShadowRoot; canvas: HTMLCanvasElement } {
  const host = document.createElement('div');
  host.id = HOST_ID;
  // 宿主本身绝不接受指针事件
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483646',
    'pointer-events:none',
    'contain:strict',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    canvas {
      position: fixed;
      inset: 0;
      display: block;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
    }
  `;

  const canvas = document.createElement('canvas');
  shadow.append(style, canvas);
  document.documentElement.appendChild(host);

  return { host, shadow, canvas };
}

/** 覆盖层的画布尺寸要跟着视口走 —— 页面滚动时视口不变，窗口变化时才变。 */
function syncCanvasSize(canvas: HTMLCanvasElement): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

async function enable(): Promise<void> {
  if (handle || !isInjectablePage()) return;

  const { host, shadow, canvas } = buildDom();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(2, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(2, Math.floor(window.innerHeight * dpr));
  syncCanvasSize(canvas);

  const runner = new AquariumRunner({ surface: 'overlay', canvas });

  const onResize = (): void => syncCanvasSize(canvas);
  window.addEventListener('resize', onResize, { passive: true });

  try {
    await runner.start();
  } catch (err) {
    window.removeEventListener('resize', onResize);
    host.remove();
    // content script 里不该把错误抛回页面上下文，静默失败即可
    console.warn('[深海] 覆盖层启动失败', err);
    return;
  }

  handle = { host, runner, shadow };
  (window as unknown as Record<string, unknown>)['__aquaOverlay'] = { ready: true };
}

function disable(): void {
  if (!handle) return;
  handle.runner.dispose();
  handle.host.remove();
  handle = null;
  delete (window as unknown as Record<string, unknown>)['__aquaOverlay'];
}

/**
 * 读配置决定开关。
 *
 * content script 是**按需注册**的：只有用户主动打开覆盖层、并授予
 * `<all_urls>` 之后，service worker 才会把它注册进来。所以这里
 * 出现就意味着用户想要它 —— 但仍然要读一次配置，因为用户可能
 * 只是把透明度调到 0 而不是关掉。
 */
async function syncWithConfig(): Promise<void> {
  try {
    const { loadConfig, onConfigChanged } = await import('../../core/storage.js');
    const apply = (cfg: Awaited<ReturnType<typeof loadConfig>>): void => {
      const on = cfg.surfaces.overlay.enabled;
      if (on) void enable();
      else disable();
    };
    apply(await loadConfig());
    onConfigChanged(apply);
  } catch {
    // 拿不到配置就按默认不开
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void syncWithConfig(), { once: true });
} else {
  void syncWithConfig();
}
