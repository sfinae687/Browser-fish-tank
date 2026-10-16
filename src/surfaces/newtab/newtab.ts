/**
 * 新标签页表面。
 *
 * 除鱼缸之外的东西只有两样：一个时钟，和一条鼠标靠近才出现的状态栏。
 * 新标签页是你一天要见几十次的地方，多一个元素都会被厌烦。
 */

import { AquariumRunner, type RunnerStatus } from '../runner.js';
import { loadConfig, onConfigChanged } from '../../core/storage.js';
import type { Config } from '../../core/config.js';
import { effectiveSeed } from '../../core/config.js';
import { applyUrlOverrides } from '../../core/urlOverrides.js';
import { encodeGenome } from '../../core/share.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

/** 开场生长阶段。括号里是这一阶段在后续版本会变成什么。 */
const INTRO_STAGES: ReadonlyArray<readonly [number, string]> = [
  [0.0, '基质落定…'],
  [0.13, '硬景观凝聚…'],
  [0.22, '水体注入…'], // P2 起：珊瑚与水草蔓延
  [0.55, '灯光点亮…'],
  [0.72, '生态启动…'], // P3 起：鱼群孵化
];

const INTRO_MS = 9000;

function stageFor(progress: number): string {
  let label = '';
  for (const [at, text] of INTRO_STAGES) {
    if (progress >= at) label = text;
  }
  return label;
}

function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDate(d: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weekdays[d.getDay()]}`;
}

function openOptions(): void {
  if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open('./../options/index.html', '_blank');
  }
}

async function main(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('tank');
  const hud = $('hud');
  const clockEl = $('clock');
  const dateEl = $('date');
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const introEl = $('intro');
  const introSeed = $('intro-seed');
  const introFill = $('intro-fill');
  const introStage = $('intro-stage');
  const fallback = $('fallback');
  const fallbackMsg = $('fallback-msg');
  const ecoEl = $('eco');

  $('options').addEventListener('click', openOptions);
  $('fallback-options').addEventListener('click', openOptions);

  /** 存储里的原始配置 */
  let stored: Config = await loadConfig();
  /** 套用 URL 覆盖之后的实际配置 */
  let config: Config = applyUrlOverrides(stored, 'newtab').config;

  const overrides = applyUrlOverrides(stored, 'newtab').applied;
  if (overrides.length > 0) {
    console.info('[计算水族箱] URL 覆盖生效：', overrides.join('  '));
  }

  const setConfig = (next: Config): void => {
    stored = next;
    config = applyUrlOverrides(stored, 'newtab').config;
  };

  // ——————— 时钟 ———————
  const tickClock = (): void => {
    const now = new Date();
    clockEl.textContent = formatClock(now);
    dateEl.textContent = formatDate(now);
  };
  tickClock();
  setInterval(tickClock, 1000);

  // ——————— HUD 自动隐藏 ———————
  let hideTimer = 0;
  const revealHud = (): void => {
    hud.classList.add('is-visible');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      // 调试模式下不隐藏，否则读不到状态
      if (!config.debug && config.surfaces.newtab.layers.hud) {
        hud.classList.remove('is-visible');
      }
    }, 3000);
  };

  window.addEventListener('mousemove', revealHud, { passive: true });
  window.addEventListener('keydown', revealHud, { passive: true });

  // ——————— 开场 ———————
  const introEnabled = config.surfaces.newtab.intro;
  introSeed.textContent = effectiveSeed(config, 'newtab');
  if (introEnabled) introEl.classList.add('is-visible');

  const introStart = performance.now();
  let introDone = !introEnabled;

  const updateIntro = (): void => {
    if (introDone) return;
    const p = Math.min(1, (performance.now() - introStart) / INTRO_MS);
    introFill.style.width = `${(p * 100).toFixed(1)}%`;
    introStage.textContent = stageFor(p);
    if (p >= 1) {
      introDone = true;
      introEl.classList.remove('is-visible');
    }
  };

  // ——————— 交互状态 ———————
  //
  // ⚠️ 这些必须声明在 `onStatus` **之前**。runner.start() 会立刻触发一次
  // 状态回调，而回调里要用到它们 —— 声明在后面就是 TDZ，
  // 整个页面初始化会在这里断掉，而且报出来的错完全不像「点击没反应」。
  let selected: number[] = [];
  const breedEl = $('breed');
  const breedA = $('breed-a');
  const breedB = $('breed-b');
  const breedInfo = $('breed-info');
  const breedGo = $<HTMLButtonElement>('breed-go');
  const fishCopy = $<HTMLButtonElement>('fish-copy');

  // ——————— 状态栏 ———————
  const onStatus = (s: RunnerStatus): void => {
    if (s.error) {
      statusDot.classList.add('is-error');
      statusText.textContent = '渲染器不可用';
      fallbackMsg.textContent = s.error;
      fallback.hidden = false;
      return;
    }
    statusDot.classList.remove('is-error');
    statusDot.classList.toggle('is-warn', s.software);

    const parts = [`${s.fps} fps`, s.tier];
    // 自动档时把实际生效的渲染缩放显示出来 —— 否则「画质自己变了」
    // 对用户是个无法解释的现象
    if (config.surfaces.newtab.quality === 'auto' && s.adaptiveScale < 0.995) {
      parts.push(`缩放 ${Math.round(s.adaptiveScale * 100)}%`);
    }
    if (s.software) parts.push('软件渲染');
    if (s.paused) parts.push('已暂停');
    if (config.debug) parts.push(s.seed, s.backend);
    statusText.textContent = parts.join(' · ');

    // 选中的鱼的状态会随时间变（能量、年龄），跟着刷新
    if (selected.length > 0) refreshBreedPanel();

    // 生态读数。放在时钟下面 —— 「这一缸过得怎么样」是看一眼就该知道的事。
    if (s.env) {
      const e = s.env;
      ecoEl.textContent =
        `${e.clock} · ${e.population} 条` +
        (e.corpses > 0 ? `（${e.corpses} 具尸体）` : '') +
        ` · ${e.temperatureC.toFixed(1)}°C · 均能 ${Math.round(e.meanEnergy * 100)}%` +
        ` · 基因池 ${e.genePool} · 生 ${e.births}/亡 ${e.deaths}`;
    }
  };

  // ——————— 启动 ———————
  const runner = new AquariumRunner({
    surface: 'newtab',
    canvas,
    // 覆盖必须在每一次配置变更后重新套用，
    // 否则用户一改设置，分享链接的效果就丢了
    transformConfig: (c) => applyUrlOverrides(c, 'newtab').config,
    onStatus: (s) => {
      updateIntro();
      onStatus(s);
    },
  });

  await runner.start();

  if (runner.currentError) {
    introEl.classList.remove('is-visible');
    onStatus({
      fps: 0,
      renderer: '—',
      software: false,
      tier: 'low',
      backend: '—',
      seed: '—',
      theme: '—',
      paused: false,
      motion: '—',
      error: runner.currentError,
      env: null,
      diverged: false,
      adaptiveScale: 1,
      costMs: 0,
    });
  } else if (config.debug) {
    hud.classList.add('is-visible');
  }

  // ——————— 交互：点水面投食，点鱼选来杂交 ———————
  const shortId = (id: number): string => `#${id}`;

  const refreshBreedPanel = (): void => {
    const [a, b] = selected;
    breedA.textContent = a === undefined ? '未选' : shortId(a);
    breedB.textContent = b === undefined ? '未选' : shortId(b);
    breedA.classList.toggle('is-set', a !== undefined);
    breedB.classList.toggle('is-set', b !== undefined);
    breedGo.disabled = selected.length < 2;
    // 种子码只对单条鱼有意义 —— 两条的时候「复制哪个」没有答案
    fishCopy.disabled = selected.length !== 1;

    if (selected.length === 0) {
      breedInfo.textContent = '点水面投食 · 点鱼选中';
    } else if (selected.length === 1) {
      const info = runner.inspectFish(selected[0] as number);
      breedInfo.textContent = info
        ? `第 ${info.generation} 代 · 能量 ${Math.round((info.energy / info.maxEnergy) * 100)}% · ` +
          `龄 ${(info.ageSeconds / 3600).toFixed(1)}h / ${(info.lifespanSeconds / 3600).toFixed(0)}h`
        : '这条鱼已经不在了';
    } else {
      breedInfo.textContent = '两条都选好了，点「杂交」';
    }
    breedEl.hidden = false;
    breedEl.classList.add('is-visible');
  };

  const spawnRipple = (clientX: number, clientY: number): void => {
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = `${clientX}px`;
    el.style.top = `${clientY}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  };

  canvas.addEventListener('click', (e) => {
    const coord = runner.screenToTank(e.clientX, e.clientY);
    if (!coord) return;
    // 圆窗之外不响应
    if (coord.x < 0 || coord.x > 1 || coord.y < 0 || coord.y > 1) return;

    const hit = runner.pickFish(coord.x, coord.y);
    if (hit >= 0) {
      // 点鱼：切换选中。再点一次同一批取消选择。
      const at = selected.indexOf(hit);
      if (at >= 0) selected.splice(at, 1);
      else {
        selected.push(hit);
        if (selected.length > 2) selected.shift();
      }
    } else {
      // 点水：投食
      runner.feed(coord.x, coord.y);
      spawnRipple(e.clientX, e.clientY);
    }
    refreshBreedPanel();
  });

  fishCopy.addEventListener('click', () => {
    if (selected.length !== 1) return;
    const info = runner.inspectFish(selected[0] as number);
    if (!info) return;
    // 单条鱼的基因组只有二三十个数字，编出来是一百来字符 —— 能贴进聊天框
    const code = encodeGenome(info.genome);
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        breedInfo.textContent = `种子码已复制（${code.length} 字符）`;
      })
      .catch(() => {
        breedInfo.textContent = `种子码：${code.slice(0, 40)}…`;
      });
  });

  breedGo.addEventListener('click', () => {
    if (selected.length < 2) return;
    runner.breed(selected[0] as number, selected[1] as number);
    selected = [];
    refreshBreedPanel();
    revealHud();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      selected = [];
      refreshBreedPanel();
    }
  });

  // ——————— 外部配置变更 ———————
  onConfigChanged((next) => {
    setConfig(next);
    runner.updateConfig(stored);
    if (config.debug) hud.classList.add('is-visible');
    introSeed.textContent = effectiveSeed(config, 'newtab');
  });

  // 页面卸载时释放 WebGL 上下文，避免反复开关新标签页耗尽上下文配额
  // 就绪标记：验收脚本靠它区分「代码没跑到」和「跑到了但没生效」
  (window as unknown as Record<string, unknown>)['__aquaUI'] = 'ready';

  window.addEventListener('pagehide', () => runner.dispose(), { once: true });
}

main().catch((err) => {
  console.error('[计算水族箱] 新标签页初始化失败', err);
  const fallback = document.getElementById('fallback');
  const msg = document.getElementById('fallback-msg');
  if (fallback) fallback.hidden = false;
  if (msg) msg.textContent = err instanceof Error ? err.message : String(err);
});
