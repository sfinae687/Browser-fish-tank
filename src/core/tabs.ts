/**
 * 标签页访问层。
 *
 * ## 一只生物 = 一个标签页
 *
 * 这是整个插件的核心概念：新标签页不是屏保，是一个**可视化的标签页管理器**。
 *
 * ## 权限：为什么「不授权」也能用
 *
 * Chrome 的 `tabs` 权限只影响 Tab 对象上的 `title` / `url` / `favIconUrl`
 * 这三个字段。**其余全部字段**（id、pinned、audible、discarded、active、
 * index、status…）在任何情况下都能拿到，而**激活一个标签页
 * （`chrome.tabs.update`）根本不需要任何权限**。
 *
 * 所以降级是干净的：
 *
 * | 能力 | 没有 `tabs` 权限 |
 * |---|---|
 * | 一只生物对应一个标签页 | ✅ |
 * | 休眠变暗 / 出声脉动 / 固定变大 | ✅ |
 * | 点击切换标签页 | ✅ |
 * | 悬停显示标题 | ❌ |
 *
 * 一个美化插件不该因为看不了标题就用不了，所以 `tabs` 做成**可选权限**，
 * 只在用户想要标题时才请求。
 */

/** 一个标签页里我们关心的全部信息。 */
export interface TabInfo {
  id: number;
  /** 标题。没有 `tabs` 权限时是空串。 */
  title: string;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  active: boolean;
  index: number;
  windowId: number;
}

export interface TabSource {
  /**
   * 当前拿不拿得到标题。
   *
   * 界面据此决定「悬停显示标题」这个功能要不要提示用户去授权 ——
   * 静默地什么都不显示是最糟的处理。
   */
  readonly hasTitles: boolean;
  /** 当前窗口的标签页，按 index 排序。 */
  list(): Promise<TabInfo[]>;
  /** 订阅任何可能影响画面的事件。返回退订函数。 */
  subscribe(cb: () => void): () => void;
  /** 切到某个标签页。不需要任何权限。 */
  activate(tabId: number): Promise<void>;
  /** 关掉某个标签页。 */
  close(tabId: number): Promise<void>;
  /** 请求 `tabs` 权限。必须在用户手势里调用。 */
  requestTitles?(): Promise<boolean>;
}

/** 有 chrome.tabs 可用吗。 */
function hasTabsApi(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.tabs !== 'undefined' &&
    typeof chrome.tabs.query === 'function'
  );
}

/**
 * 真实实现。
 *
 * 事件订阅覆盖了所有会改变画面的东西 —— 漏掉任何一个，画面就会和
 * 浏览器状态不一致（比如关掉标签页之后生物还留在水里）。
 */
export function createChromeTabSource(): TabSource {
  const api = chrome.tabs;

  // 标题权限是异步查的，这里不预判 —— 改成「第一次真的拿到标题就置位」。
  // 这样不需要额外的异步初始化，也不会在权限查询失败时误判。
  let titlesAvailable = false;

  const toInfo = (t: chrome.tabs.Tab): TabInfo | null => {
    if (typeof t.id !== 'number') return null;
    if (typeof t.title === 'string' && t.title.length > 0) titlesAvailable = true;
    return {
      id: t.id,
      title: t.title ?? '',
      pinned: t.pinned === true,
      audible: t.audible === true,
      discarded: t.discarded === true,
      active: t.active === true,
      index: t.index ?? 0,
      windowId: t.windowId ?? -1,
    };
  };

  return {
    get hasTitles() {
      return titlesAvailable;
    },

    async list(): Promise<TabInfo[]> {
      const tabs = await api.query({ currentWindow: true });
      const out: TabInfo[] = [];
      for (const t of tabs) {
        const info = toInfo(t);
        if (info) out.push(info);
      }
      out.sort((a, b) => a.index - b.index);
      return out;
    },

    subscribe(cb: () => void): () => void {
      // 漏掉任何一个事件，画面就会和浏览器状态不一致 ——
      // 比如关掉标签页之后生物还留在水里。
      //
      // 这里全部当成「无参事件」处理：我们只关心「有变化」，不关心
      // 具体变了什么，反正每次都会重查一遍。这让十几个签名各不相同的事件
      // 能用同一段代码订阅。
      const events: Array<chrome.events.Event<() => void>> = [
        api.onCreated,
        api.onRemoved,
        api.onMoved,
        api.onActivated,
        api.onUpdated,
        api.onAttached,
        api.onDetached,
        api.onReplaced,
      ].filter((e): e is chrome.events.Event<() => void> => typeof e?.addListener === 'function');

      const handler = (): void => cb();
      for (const ev of events) ev.addListener(handler);

      // 当前窗口换了也要重查
      const onFocus = (): void => cb();
      chrome.windows?.onFocusChanged?.addListener(onFocus);

      return () => {
        for (const ev of events) ev.removeListener(handler);
        chrome.windows?.onFocusChanged?.removeListener(onFocus);
      };
    },

    async activate(tabId: number): Promise<void> {
      // 不需要任何权限
      await api.update(tabId, { active: true });
      const t = await api.get(tabId);
      if (typeof t.windowId === 'number') {
        await chrome.windows?.update(t.windowId, { focused: true });
      }
    },

    async close(tabId: number): Promise<void> {
      await api.remove(tabId);
    },

    async requestTitles(): Promise<boolean> {
      try {
        const granted = await chrome.permissions.request({ permissions: ['tabs'] });
        return granted === true;
      } catch {
        return false;
      }
    },
  };
}

// ————————————————————————————————————————————————————————————
// 演示 / 降级用的假数据源
// ————————————————————————————————————————————————————————————

/**
 * 假数据源。
 *
 * 两个用途：
 *
 *   1. **非扩展环境**（`tools/look.mjs`、设置页预览）下让画面能出来 ——
 *      空水缸什么也验证不了
 *   2. **演示模式**：让用户在不暴露真实标签页的情况下看到完整效果
 *
 * 刻意造出各种状态（休眠 / 出声 / 固定），否则四种表现差异没法自检。
 */
export function createMockTabSource(): TabSource {
  const titles = [
    '图表 · 季度复盘',
    '文档 · 设计稿评论',
    '邮件 · 收件箱',
    '代码 · 拉取请求',
    '视频 · 讲座回放',
    '购物 · 显示器对比',
    '新闻 · 早报',
    '音乐 · 专注歌单',
    '日历 · 本周安排',
    '地图 · 通勤路线',
    '相册 · 周末',
    '笔记 · 灵感',
    '终端 · 部署日志',
    '论文 · 注意力机制',
  ];

  const listeners = new Set<() => void>();
  let count = 12;

  const list = async (): Promise<TabInfo[]> => {
    const out: TabInfo[] = [];
    for (let i = 0; i < count; i++) {
      out.push({
        id: 1000 + i * 137,
        title: titles[i % titles.length] as string,
        pinned: i < 2,
        audible: i === 3,
        discarded: i === 5 || i === 9,
        active: i === 0,
        index: i,
        windowId: 1,
      });
    }
    return out;
  };

  return {
    hasTitles: true,
    list,
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async activate(): Promise<void> {
      /* 演示模式没有真实标签页可切 */
    },
    async close(): Promise<void> {
      count = Math.max(1, count - 1);
      for (const cb of listeners) cb();
    },
  };
}

/** 按当前环境挑一个数据源。 */
export function createTabSource(): TabSource {
  return hasTabsApi() ? createChromeTabSource() : createMockTabSource();
}
