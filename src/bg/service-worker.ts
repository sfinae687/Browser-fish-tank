/**
 * MV3 service worker。
 *
 * 它**不**负责渲染，也**不**负责模拟 —— MV3 的 service worker 随时会被杀，
 * 任何放在这里的持续状态都是 bug 的温床。鱼缸的模拟是纯函数（DESIGN.md §0），
 * 每个表面各自算各自的，不需要一个常驻的「权威」。
 *
 * 这里只做三件短命的事：
 *   1. 首次安装时写一份默认配置
 *   2. 按配置**运行时注册/注销**覆盖层的 content script
 *   3. 用户点击工具栏图标时打开设置页
 */

import { loadConfig, saveConfig, CONFIG_KEY } from '../core/storage.js';
import { defaultConfig } from '../core/config.js';

const OVERLAY_SCRIPT_ID = 'aqua-overlay';
const OVERLAY_JS = 'overlay/overlay.js';
const TEARDOWN_MESSAGE = 'aqua.overlay.teardown';
const SYNC_MESSAGE = 'overlay.sync';

/**
 * 只在用户显式开启覆盖层时才注册。
 *
 * 静态声明 `<all_urls>` 会让扩展在**每一个**页面里都跑起来 ——
 * 那既费性能，也是隐私上不该给的默认值。
 */
async function syncOverlayRegistration(): Promise<{ registered: boolean; reason?: string }> {
  const config = await loadConfig();
  const wanted = config.surfaces.overlay.enabled;

  let registered = false;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [OVERLAY_SCRIPT_ID],
    });
    registered = existing.length > 0;
  } catch (err) {
    console.warn('[计算水族箱] 无法查询已注册的 content script', err);
  }

  if (wanted && !registered) {
    // 没有 host 权限就注册不了。权限由设置页在用户点击时申请，
    // 这里只是复核 —— service worker 里没法弹权限请求。
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!granted) {
      return { registered: false, reason: '缺少 <all_urls> 权限' };
    }
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: OVERLAY_SCRIPT_ID,
          matches: ['<all_urls>'],
          js: [OVERLAY_JS],
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
      registered = true;
    } catch (err) {
      console.error('[计算水族箱] 注册覆盖层失败', err);
      return { registered: false, reason: String(err) };
    }
  } else if (!wanted && registered) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_SCRIPT_ID] });
    } catch (err) {
      console.warn('[计算水族箱] 注销覆盖层失败', err);
    }
    registered = false;
    // 注销只阻止**将来**的注入。已经跑在页面里的实例必须逐个通知才会消失，
    // 否则用户关掉开关后水影还留在所有已打开的标签页上。
    await teardownAllTabs();
  }

  return { registered };
}

async function teardownAllTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    // 不需要 "tabs" 权限：我们只用 tab.id，不读 url/title
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.id < 0) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { t: TEARDOWN_MESSAGE });
      } catch {
        // 页面里没有我们的 content script —— 这是绝大多数情况，正常
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === 'install') {
      // 只有在真的没有配置时才写默认值，
      // 否则升级会覆盖掉用户精心调过的鱼缸
      const existing = await chrome.storage.sync.get(CONFIG_KEY);
      if (existing[CONFIG_KEY] === undefined) {
        await saveConfig(defaultConfig());
      }
    }
    await syncOverlayRegistration();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void syncOverlayRegistration();
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { t?: string }).t;

  if (t === SYNC_MESSAGE) {
    void syncOverlayRegistration().then(sendResponse);
    return true; // 异步响应
  }

  if (t === 'aqua.openOptions') {
    void chrome.runtime.openOptionsPage();
    return false;
  }

  return false;
});

// 配置可能在别处被改（另一个窗口、另一台设备同步过来）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' && area !== 'local') return;
  if (!(CONFIG_KEY in changes)) return;
  void syncOverlayRegistration();
});

// 工具栏图标：没有 popup，点击直接进设置
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
