/**
 * 新标签页。
 *
 * 它的职责很薄：把运行器跑起来，然后接三件事 ——
 * 时钟、悬停提示、状态行。所有的重活都在运行器里。
 *
 * ## 一个刻意的取舍：首屏不做交互引导
 *
 * 「点一只生物可以切过去」这个能力是**藏起来**的：默认不显示任何提示，
 * 只在状态行里放一句很淡的话，鼠标一动就出现、一会儿不动就隐去。
 *
 * 理由是这是一个每天看几十次的页面。任何常驻的说明文字都会变成噪音。
 * 发现了的人会觉得惊喜，没发现的人也不会被打扰 —— 而这是一片海，
 * 光是看着就够了。
 */

import { AquariumRunner, type RunnerStatus } from '../runner.js';

// 模块级标记：用来区分「模块没执行」和「执行了但中途失败」。
// 这两件事的排查方向完全不同，而症状都是「页面没反应」。
console.log('[深海] 模块已加载');
(window as unknown as Record<string, unknown>)['__moduleLoaded'] = true;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

function openOptions(): void {
  if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open('/options/index.html', '_blank');
  }
}

// ——————————————— 时钟 ———————————————

function startClock(): void {
  const time = $('time');
  const date = $('date');
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const tick = (): void => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    time.textContent = `${hh}:${mm}`;
    date.textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${weekdays[d.getDay()]}`;
  };
  tick();
  // 每分钟整点刷新就够了，不需要每秒 —— 一个每秒跑的回调在这种页面上是纯浪费
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    tick();
    setInterval(tick, 60000);
  }, msToNextMinute);
}

// ——————————————— 空闲隐去 ———————————————

function startIdleFade(): void {
  let timer = 0;
  const wake = (): void => {
    document.body.classList.remove('is-idle');
    clearTimeout(timer);
    timer = window.setTimeout(() => document.body.classList.add('is-idle'), 4200);
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(ev, wake, { passive: true });
  }
  wake();
}

// ——————————————— 主流程 ———————————————

async function main(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('tank');
  const statusEl = $('status');
  const tip = $('tip');
  const titlesBtn = $<HTMLButtonElement>('titles');
  const fallback = $('fallback');
  const fallbackMsg = $('fallback-msg');

  startClock();
  startIdleFade();

  let lastTipAt = 0;

  const onStatus = (s: RunnerStatus): void => {
    if (s.error) {
      fallback.hidden = false;
      fallbackMsg.textContent = s.error;
      return;
    }
    const parts = [`${s.creatures} 只`, `${s.tabs} 个标签页`];
    if (s.software) parts.push('软件渲染');
    if (s.fps > 0) parts.push(`${s.fps} fps`);
    statusEl.textContent = parts.join(' · ');

    // 没有标题权限时给一个明确的入口，而不是静默地什么都不显示。
    // 「悬停没反应」是最糟的失败方式 —— 用户不知道是坏了还是没做。
    titlesBtn.hidden = s.hasTitles || s.demo || s.tabs === 0;
  };

  const runner = new AquariumRunner({ surface: 'newtab', canvas, onStatus });

  try {
    await runner.start();
  } catch (err) {
    // ⚠️ 这里**必须**打日志。
    //
    // 第一版写的是 `catch { return; }` —— 只靠 status 回调去更新兜底界面的文案。
    // 结果排查时页面控制台一行输出都没有，我一度以为是模块根本没执行，
    // 花了很久才想到去看兜底文案里的真正错误。
    // 错误只写在界面上、不进控制台，等于没有错误信息。
    console.error('[深海] 启动失败', err);
    return;
  }

  // ——— 悬停：显示标签页标题 ———
  canvas.addEventListener('pointermove', (e) => {
    runner.setPointer(e.clientX, e.clientY);
    // 用 hoverAt 而不是 hoveredCreature：后者要等下一帧的循环才算出来，
    // 在事件处理函数里读它永远是慢一拍的
    const c = runner.hoverAt(e.clientX, e.clientY);
    if (!c || !c.title) {
      tip.hidden = true;
      return;
    }
    const now = performance.now();
    // 节流：指针在生物身上移动时不该每帧都写 DOM
    if (now - lastTipAt < 60 && !tip.hidden) return;
    lastTipAt = now;

    tip.textContent = c.title;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
    tip.hidden = false;
  });

  canvas.addEventListener('pointerleave', () => {
    runner.clearPointer();
    tip.hidden = true;
  });

  // ——— 点击：切到那个标签页 ———
  canvas.addEventListener('click', (e) => {
    const hit = runner.handleClick(e.clientX, e.clientY);
    if (hit?.title) {
      // 切过去之前给一点反馈 —— 不然点下去像是没反应
      tip.textContent = `→ ${hit.title}`;
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY}px`;
      tip.hidden = false;
      window.setTimeout(() => {
        tip.hidden = true;
      }, 900);
    }
  });

  // ——— 申请标题权限（必须在用户手势里）———
  titlesBtn.addEventListener('click', () => {
    void runner.requestTitles().then((granted) => {
      if (!granted) statusEl.textContent = '没有授权，只能看到生物看不到标题';
    });
  });

  $('fallback-options').addEventListener('click', openOptions);

  window.addEventListener('pagehide', () => runner.dispose(), { once: true });

  // 就绪标记：验收脚本靠它区分「代码没跑到」和「跑到了但没生效」
  (window as unknown as Record<string, unknown>)['__aquaUI'] = 'ready';
}

main().catch((err) => {
  console.error('[深海] 新标签页初始化失败', err);
  const fallback = document.getElementById('fallback');
  const msg = document.getElementById('fallback-msg');
  if (fallback) fallback.hidden = false;
  if (msg) msg.textContent = err instanceof Error ? err.message : String(err);
});
