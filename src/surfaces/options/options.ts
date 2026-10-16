/**
 * 设置页。
 *
 * ## 预览画的是**表单里当前的值**，不是已保存的值
 *
 * 这一条决定了整个页面的结构：预览不通过 `loadConfig()` 拿配置，
 * 而是直接读表单状态。改一个滑块立刻能看到效果，不需要先保存 ——
 * 「调一下、保存、回去看、不满意、再回来」这个循环会让调美术变成折磨。
 *
 * ## 表单是数据驱动的
 *
 * 每一项用一条 `Field` 描述，渲染和读值共用同一份定义。
 * 手写一堆 `<input>` 的后果是「加了一项但忘了接到读写逻辑上」——
 * 表现是滑块能拖但没效果，而且很难查。
 */

import {
  defaultSurface,
  sanitizeSurface,
  type Config,
  type Framing,
  type AnchorY,
  type Quality,
  type SurfaceConfig,
  type SurfaceId,
} from '../../core/config.js';
import { THEME_LABELS, THEME_NAMES } from '../../core/theme.js';
import { loadConfig, saveConfig } from '../../core/storage.js';
import { TankRenderer } from '../../render/tank.js';
import { Flock } from '../../core/creatures.js';
import { createMockTabSource } from '../../core/tabs.js';
import { paletteFor } from '../../core/theme.js';
import { resolveQuality } from '../../core/config.js';

// ————————————————————————————————————————————————————————————
// 表单定义
// ————————————————————————————————————————————————————————————

type FieldKind = 'range' | 'select' | 'bool' | 'number';

interface Field {
  kind: FieldKind;
  /** 在 SurfaceConfig 上的路径，形如 'layers.bloom' */
  path: string;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** 只在某个条件下显示。用于「只在覆盖层标签下出现」的那些项。 */
  when?: () => boolean;
}

interface Group {
  title: string;
  note?: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: '外观',
    fields: [
      {
        kind: 'select',
        path: 'theme',
        label: '主题',
        hint: '只换气氛，不换风格',
        options: THEME_NAMES.map((t) => ({ value: t, label: THEME_LABELS[t] })),
      },
      { kind: 'range', path: 'opacity', label: '不透明度', min: 0.05, max: 1, step: 0.01 },
      { kind: 'range', path: 'bloom', label: '辉光', hint: '这套美术的造型手段，不建议关', min: 0, max: 2.5, step: 0.05 },
      { kind: 'range', path: 'maxCreatures', label: '最多生物数', min: 1, max: 40, step: 1 },
    ],
  },
  {
    title: '构图',
    fields: [
      {
        kind: 'select',
        path: 'framing',
        label: '构图',
        options: [
          { value: 'fill', label: '铺满画面' },
          { value: 'center', label: '居中' },
          { value: 'letterbox', label: '信箱（保持 16:9）' },
        ],
      },
      { kind: 'range', path: 'zoom', label: '缩放', min: 0.4, max: 2.5, step: 0.05 },
      {
        kind: 'select',
        path: 'anchorY',
        label: '垂直对齐',
        options: [
          { value: 'top', label: '靠上' },
          { value: 'center', label: '居中' },
          { value: 'bottom', label: '靠下' },
        ],
      },
    ],
  },
  {
    title: '图层',
    note: '深色场景里唯一的亮色来源就是生物自己，所以「生物」和「辉光」尽量不要关。',
    fields: [
      { kind: 'bool', path: 'layers.creatures', label: '发光生物' },
      { kind: 'bool', path: 'layers.bloom', label: '辉光' },
      { kind: 'bool', path: 'layers.caustics', label: '焦散', hint: '只在靠近水面的地方可见' },
      { kind: 'bool', path: 'layers.rays', label: '光柱' },
      { kind: 'bool', path: 'layers.snow', label: '悬浮微粒' },
      { kind: 'bool', path: 'layers.surface', label: '水面' },
      { kind: 'bool', path: 'layers.vignette', label: '暗角' },
    ],
  },
  {
    title: '浏览器行为',
    note: '一只生物对应一个打开的标签页。',
    fields: [
      { kind: 'bool', path: 'clickToSwitch', label: '点击生物切换标签页' },
      { kind: 'bool', path: 'hoverTitles', label: '悬停显示标签页标题', hint: '需要可选的「读取标签页」权限' },
      { kind: 'bool', path: 'demoMode', label: '演示模式', hint: '不读真实标签页，用一批假数据' },
    ],
  },
  {
    title: '性能',
    fields: [
      {
        kind: 'select',
        path: 'quality',
        label: '画质',
        options: [
          { value: 'auto', label: '自动' },
          { value: 'low', label: '低' },
          { value: 'medium', label: '中' },
          { value: 'high', label: '高' },
        ],
      },
      { kind: 'range', path: 'fpsCap', label: '帧率上限', hint: '深海是缓慢的场景，30 足够', min: 5, max: 60, step: 1 },
    ],
  },
  {
    title: '覆盖层',
    note: '覆盖层是盖在别人网页上的客串，默认很克制。',
    fields: [
      { kind: 'bool', path: 'enabled', label: '启用覆盖层' },
    ],
  },
];

// ————————————————————————————————————————————————————————————
// 读写路径
// ————————————————————————————————————————————————————————————

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1] as string] = value;
}

// ————————————————————————————————————————————————————————————
// 预览
// ————————————————————————————————————————————————————————————

/**
 * 预览。
 *
 * 用**假的标签页数据**而不是真实的 —— 设置页不该暴露你正在开什么网页。
 * 数据里刻意造出各种状态（休眠 / 出声 / 固定），否则四种表现差异看不出来。
 */
class Preview {
  private renderer: TankRenderer | null = null;
  private flock = new Flock({ maxCreatures: 18 });
  private tabs: Awaited<ReturnType<ReturnType<typeof createMockTabSource>['list']>> = [];
  private t = 0;
  private last = 0;
  private raf = 0;
  private conf: SurfaceConfig;
  private disposed = false;
  readonly note: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    conf: SurfaceConfig,
  ) {
    this.conf = conf;
    this.note = '预览用演示数据';
  }

  async start(): Promise<void> {
    this.renderer = new TankRenderer(this.canvas);
    this.tabs = await createMockTabSource().list();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  setConfig(conf: SurfaceConfig): void {
    this.conf = conf;
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const renderer = this.renderer;
    if (!renderer) return;

    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;

    // 只显示配置允许的数量
    this.flock.setMax(this.conf.maxCreatures);
    this.flock.sync(this.tabs, dt);

    const quality = resolveQuality(this.conf.quality, renderer.info.software, 30);
    renderer.resizeToDisplay(quality.renderScale);

    // 发布和运行器同名的诊断对象 —— 验收脚本对所有页面用同一个就绪判据，
    // 「不同页面等不同的标记」是那种加一个页面就要改一次工具链的设计。
    const w = window as unknown as Record<string, unknown>;
    const prev = (w['__aqua'] as Record<string, unknown> | undefined) ?? {};
    w['__aqua'] = {
      ...prev,
      ready: true,
      frames: ((prev['frames'] as number) ?? 0) + 1,
      surface: 'options-preview',
      creatures: this.flock.count,
      tabs: this.tabs.length,
      renderer: renderer.info.renderer,
      software: renderer.info.software,
    };

    renderer.render({
      time: this.t,
      intro: 1,
      palette: paletteFor(this.conf.theme),
      layers: this.conf.layers,
      quality,
      framing: this.conf.framing,
      zoom: this.conf.zoom,
      anchorY: this.conf.anchorY,
      opacity: this.conf.opacity,
      bloom: this.conf.bloom,
      creatures: this.conf.layers.creatures ? this.flock.list : [],
    });
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
  }
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————

async function main(): Promise<void> {
  const form = document.getElementById('form') as HTMLElement;
  const saveState = document.getElementById('save-state') as HTMLElement;
  const previewLabel = document.getElementById('preview-surface') as HTMLElement;
  const previewNote = document.getElementById('preview-note') as HTMLElement;
  const previewCanvas = document.getElementById('preview') as HTMLCanvasElement;

  let config: Config = await loadConfig();
  let surface: SurfaceId = 'newtab';

  const preview = new Preview(previewCanvas, config.surfaces.newtab);
  await preview.start();
  previewNote.textContent = preview.note;

  let saveTimer = 0;
  const scheduleSave = (): void => {
    saveState.textContent = '正在保存…';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveConfig(config).then(() => {
        saveState.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
      });
    }, 260);
  };

  const syncPreview = (): void => {
    preview.setConfig(config.surfaces[surface]);
    previewLabel.textContent = surface === 'newtab' ? '新标签页' : '页面覆盖层';
  };

  /** 重建整个表单。只在切换表面时调用。 */
  const render = (): void => {
    const conf = config.surfaces[surface];
    form.textContent = '';

    for (const group of GROUPS) {
      const visible = group.fields.filter((f) => !f.when || f.when());
      if (visible.length === 0) continue;

      const g = document.createElement('section');
      g.className = 'group';
      const h = document.createElement('h2');
      h.className = 'group__title';
      h.textContent = group.title;
      g.appendChild(h);
      if (group.note) {
        const n = document.createElement('p');
        n.className = 'group__note';
        n.textContent = group.note;
        g.appendChild(n);
      }

      for (const field of visible) g.appendChild(renderField(field, conf));
      form.appendChild(g);
    }
  };

  const renderField = (field: Field, conf: SurfaceConfig): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    label.className = 'row__label';
    label.textContent = field.label;
    if (field.hint) {
      const hint = document.createElement('span');
      hint.className = 'row__hint';
      hint.textContent = field.hint;
      label.appendChild(hint);
    }
    row.appendChild(label);

    const value = getPath(conf, field.path);

    if (field.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true;
      input.addEventListener('change', () => {
        setPath(config.surfaces[surface] as unknown as Record<string, unknown>, field.path, input.checked);
        syncPreview();
        scheduleSave();
      });
      row.appendChild(input);
      return row;
    }

    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '10px';

    if (field.kind === 'select') {
      const select = document.createElement('select');
      for (const opt of field.options ?? []) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.value = String(value ?? '');
      select.addEventListener('change', () => {
        setPath(config.surfaces[surface] as unknown as Record<string, unknown>, field.path, select.value);
        syncPreview();
        scheduleSave();
      });
      wrap.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(field.min ?? 0);
      input.max = String(field.max ?? 1);
      input.step = String(field.step ?? 0.01);
      input.value = String(typeof value === 'number' ? value : 0);

      const readout = document.createElement('span');
      readout.className = 'row__value';
      const show = (v: number): string =>
        (field.step ?? 0.01) < 1 ? v.toFixed(2) : String(Math.round(v));
      readout.textContent = show(input.valueAsNumber);

      input.addEventListener('input', () => {
        const v = input.valueAsNumber;
        readout.textContent = show(v);
        setPath(config.surfaces[surface] as unknown as Record<string, unknown>, field.path, v);
        // 预览立刻更新，保存延后 —— 拖动滑块时不该每次都写存储
        syncPreview();
        scheduleSave();
      });
      wrap.append(input, readout);
    }

    row.appendChild(wrap);
    return row;
  };

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.tabs__btn')) {
    btn.addEventListener('click', () => {
      surface = (btn.dataset['surface'] as SurfaceId) ?? 'newtab';
      for (const b of document.querySelectorAll('.tabs__btn')) {
        b.classList.toggle('is-active', b === btn);
      }
      // 覆盖层的「启用」只在覆盖层有意义
      render();
      syncPreview();
    });
  }

  document.getElementById('reset')?.addEventListener('click', () => {
    const base = defaultSurface(surface);
    config.surfaces[surface] = sanitizeSurface(base, surface);
    render();
    syncPreview();
    scheduleSave();
  });

  // 表单的初始显示
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.tabs__btn')) {
    if (btn.dataset['surface'] === surface) btn.classList.add('is-active');
    else btn.classList.remove('is-active');
  }
  // 覆盖层那一项只在覆盖层标签下出现
  const overlayGroup = GROUPS.find((g) => g.title === '覆盖层');
  if (overlayGroup) overlayGroup.fields[0]!.when = () => surface === 'overlay';

  render();
  syncPreview();

  window.addEventListener('pagehide', () => preview.dispose(), { once: true });
  (window as unknown as Record<string, unknown>)['__aquaUI'] = 'ready';
}

main().catch((err) => {
  console.error('[深海] 设置页初始化失败', err);
});

void ({} as Framing);
void ({} as AnchorY);
void ({} as Quality);
