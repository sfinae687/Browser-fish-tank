/**
 * 自动化截图底座（CDP）。
 *
 * 为什么不能用 `--screenshot` + `--virtual-time-budget`：
 * 虚拟时间只推进定时器和 requestAnimationFrame 的**调度**，
 * 并不等待 GPU 真正把像素画出来。SwiftShader 渲染一帧 1600×900 的场景
 * 要花可观的真实时间，于是固定预算的截图会间歇性地截到一张空白页 ——
 * 而且看起来像是「扩展坏了」，极难排查。
 *
 * 正确做法是让页面自己报告就绪（runner 会把状态挂到 window.__aqua），
 * 脚本通过 DevTools 协议轮询它，确认真的画出来了再截图。
 * 顺带还拿到了页面的 console 输出。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** 起一个只读的静态服务器。返回的 server 上带有 `.port`。 */
export async function startStaticServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      // 浏览器总会来要 favicon，回 204 免得在控制台里刷 404 噪音
      if (rel === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      // 防目录穿越：解析后必须仍在 root 之内
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.port = server.address().port;
  return server;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端。只需要 send 和事件订阅。 */
function connectCdp(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  return {
    send(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    on(fn) {
      listeners.push(fn);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

function findChromium() {
  return process.env.CHROMIUM ?? 'chromium';
}

/**
 * 打开一个页面、等它就绪、截图。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.out                 截图输出路径
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {string} [opts.loadExtension]     要加载的未打包扩展目录
 * @param {string} [opts.waitFor]           就绪判定的 JS 表达式
 * @param {number} [opts.timeoutMs]         等待就绪的上限
 * @param {number} [opts.settleMs]          就绪后额外等待的时间（让动画走几帧）
 * @returns {Promise<{console: string[], stderr: string, frames: number, ready: boolean}>}
 */
export async function capture(opts) {
  const {
    url,
    out,
    width = 1600,
    height = 900,
    loadExtension,
    waitFor = 'window.__aqua && window.__aqua.ready === true',
    timeoutMs = 45000,
    settleMs = 600,
    keepAnimating = false,
    clicks = [],
    evalAfter = [],
  } = opts;

  // 传入 profileDir 可以跨多次 capture 复用同一个浏览器配置目录 ——
  // 这是验证「世界快照真的写进去、真的读回来」的唯一办法。
  const ownsProfile = !opts.profileDir;
  const profile = opts.profileDir ?? (await mkdtemp(path.join(tmpdir(), 'aqua-cdp-')));

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    // Chrome 127+ 起，没有这个开关 headless 下 WebGL 直接不可用
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ];
  if (loadExtension) {
    args.push(`--load-extension=${loadExtension}`);
    args.push(`--disable-extensions-except=${loadExtension}`);
  }
  // 用 about:blank 起步，真正的导航交给 Page.navigate。
  // 把 URL 作为启动参数是不可靠的：chrome-extension:// 的目标在
  // 扩展注册完成之前导航会失败，而且失败得很安静。
  args.push('about:blank');

  const child = spawn(findChromium(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let wsBrowserUrl = null;
  let exitCode = null;

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (!wsBrowserUrl) {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) wsBrowserUrl = m[1];
    }
  });
  child.on('exit', (code) => (exitCode = code));

  const consoleMessages = [];
  let cdp = null;
  let world = { tick: null, hash: null, diverged: false };

  const cleanup = async () => {
    cdp?.close();
    if (exitCode === null) child.kill('SIGKILL');
    if (ownsProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // ——— 等待 DevTools 端口就绪 ———
    const deadline = Date.now() + timeoutMs;
    while (!wsBrowserUrl && Date.now() < deadline) {
      if (exitCode !== null) throw new Error(`Chromium 提前退出（code ${exitCode}）\n${stderr.slice(-2000)}`);
      await sleep(50);
    }
    if (!wsBrowserUrl) throw new Error('等不到 DevTools 端口');

    const port = new URL(wsBrowserUrl).port;

    // ——— 找到页面 target ———
    let pageTarget = null;
    while (!pageTarget && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await res.json();
        pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
      } catch {
        /* 端口还没起来 */
      }
      if (!pageTarget) await sleep(100);
    }
    if (!pageTarget) throw new Error('找不到可调试的页面 target');

    // ——— 连上页面 ———
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 DevTools 超时')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连接 DevTools 失败'));
      });
    });

    cdp = connectCdp(ws);
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
          .join(' ');
        consoleMessages.push(`[${msg.params.type}] ${text}`);
      } else if (msg.method === 'Log.entryAdded') {
        consoleMessages.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleMessages.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // 固定视口。不这么做的话，Page.captureScreenshot 拿到的是「可见区域」，
    // 高度会被无头窗口的装饰吃掉几十像素，不同次运行还不一样。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ——— 显式导航，失败就重试 ———
    // chrome-extension:// 的页面在扩展刚加载完的那一小段时间里会导航失败，
    // 报 ERR_FILE_NOT_FOUND 或 ERR_BLOCKED_BY_CLIENT。重试几次即可。
    let navigated = false;
    let lastNavError = '';
    for (let attempt = 0; attempt < 12 && !navigated && Date.now() < deadline; attempt++) {
      try {
        const res = await cdp.send('Page.navigate', { url });
        if (res.errorText) {
          lastNavError = res.errorText;
        } else {
          navigated = true;
          break;
        }
      } catch (err) {
        lastNavError = err.message;
      }
      await sleep(250);
    }
    if (!navigated) {
      throw new Error(`导航失败：${url}\n  最后一次错误：${lastNavError || '(无)'}`);
    }

    // ——— 轮询就绪 ———
    let ready = false;
    let frames = 0;
    while (Date.now() < deadline) {
      const res = await cdp
        .send('Runtime.evaluate', {
          expression: `(() => { try {
            const a = window.__aqua || {};
            return { r: !!(${waitFor}), f: a.frames || 0, e: a.error || null,
                     tick: a.tick ?? null, hash: a.hash ?? null,
                     diverged: a.diverged === true };
          } catch (err) { return { r: false, f: 0, e: String(err) }; } })()`,
          returnByValue: true,
        })
        .catch(() => null);

      const value = res?.result?.value;
      if (value) {
        frames = value.f ?? 0;
        world = { tick: value.tick ?? null, hash: value.hash ?? null, diverged: value.diverged === true };
        if (value.e) throw new Error(`页面报告渲染错误：${value.e}`);
        if (value.r) {
          ready = true;
          break;
        }
      }
      await sleep(120);
    }

    if (!ready) {
      // 超时是最需要诊断的时刻 —— 这时把页面的真实状态抓出来，
      // 而不是只丢一句「脚本可能根本没执行」（那句话曾经把我带偏过）。
      let diag = '';
      try {
        const d = await cdp.send('Runtime.evaluate', {
          expression: `(() => ({
            aqua: typeof window.__aqua,
            aquaKeys: window.__aqua ? Object.keys(window.__aqua).join(',') : null,
            ui: window.__aquaUI ?? null,
            chrome: typeof chrome,
            hasTabsApi: typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined',
            scripts: [...document.scripts].map((s) => s.src || '(inline)').join(' | '),
            body: document.body ? document.body.children.length : -1,
            fallbackShown: !!(document.getElementById('fallback') && !document.getElementById('fallback').hidden),
            fallbackMsg: (document.getElementById('fallback-msg') || {}).textContent || null,
            status: (document.getElementById('status') || {}).textContent || null,
          }))()`,
          returnByValue: true,
        });
        diag = '\n页面状态：' + JSON.stringify(d?.result?.value);
      } catch {
        diag = '\n页面状态：读取失败';
      }
      throw new Error(
        `等待就绪超时（${timeoutMs}ms，已渲染 ${frames} 帧）。` +
          diag +
          (consoleMessages.length
            ? '\n页面控制台：\n  ' + consoleMessages.join('\n  ')
            : '\n页面控制台：（没有任何输出）'),
      );
    }

    // 无头 Chromium 里 requestAnimationFrame **几乎不触发** ——
    // 没有东西要求产帧时，合成器就不产帧；一个「等 24 秒」的页面可能总共
    // 只跑了四五帧。任何依赖「渲染循环持续跑」的验证（比如定期写快照）
    // 都会因此失败，而且报出来的症状和真正的原因隔得很远。
    //
    // 打开一个 screencast 就能逼着合成器持续产帧。每帧必须回 ack，
    // 否则流会自己停掉。
    // 探针：脚本到底有没有执行？在模块最外层打一个标记，
  // 这样「没执行」和「执行了但抛异常」能区分开。
  await cdp
    .send('Runtime.evaluate', {
      expression: `(() => { window.__probe = { at: 'nav-done', aqua: typeof window.__aqua,
        ui: window.__aquaUI ?? null, hasChrome: typeof chrome,
        hasTabs: typeof chrome !== 'undefined' && typeof chrome.tabs }; return window.__probe; })()`,
      returnByValue: true,
    })
    .then((r) => console.log('[harness] 探针', JSON.stringify(r?.result?.value)))
    .catch(() => {});

  if (keepAnimating) {
      cdp.on((msg) => {
        if (msg.method === 'Page.screencastFrame') {
          cdp
            .send('Page.screencastFrameAck', { sessionId: msg.params.sessionId })
            .catch(() => {});
        }
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 5, everyNthFrame: 1 });
    }

    // 就绪后再放一会儿，让动画走过开场、也让辉光等需要多帧的效果稳定
    await sleep(settleMs);

    // 探针：脚本到底有没有执行？在模块最外层打一个标记，
  // 这样「没执行」和「执行了但抛异常」能区分开。
  await cdp
    .send('Runtime.evaluate', {
      expression: `(() => { window.__probe = { at: 'nav-done', aqua: typeof window.__aqua,
        ui: window.__aquaUI ?? null, hasChrome: typeof chrome,
        hasTabs: typeof chrome !== 'undefined' && typeof chrome.tabs }; return window.__probe; })()`,
      returnByValue: true,
    })
    .then((r) => console.log('[harness] 探针', JSON.stringify(r?.result?.value)))
    .catch(() => {});

  if (keepAnimating) {
      await cdp.send('Page.stopScreencast').catch(() => {});
    }

    // ——— 交互：把点击派发进页面 ———
    //
    // 必须走真正的鼠标事件而不是 `element.click()`：处理函数读的是
    // clientX / clientY，合成事件里没有坐标。
    for (const c of clicks) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await sleep(200);
    }

    // ——— 在页面里执行任意表达式 ———
    for (const expr of evalAfter) {
      const r = await cdp
        .send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        .catch((err) => ({ exceptionDetails: { text: String(err) } }));
      // 表达式抛异常时报出来 —— 静默吞掉会让「没生效」和「没执行」
      // 看起来一模一样，那正是这一轮浪费最多时间的地方。
      if (r?.exceptionDetails) {
        console.warn(`[harness] 页面表达式抛异常：${r.exceptionDetails.text ?? ''}`);
      }
      await sleep(240);
    }

    // 重新读一次状态。
    //
    // ⚠️ 上面那个 world 是**轮询到就绪的那一刻**读的，之后又过了 settleMs。
    // 不刷新的话，返回的是「刚加载完」的快照而不是「截图时」的快照 ——
    // 这个 bug 让一个等 24 秒的连续性检查看起来像世界完全没推进，
    // 而真正的原因在测试底座里，离症状很远。
    const finalState = await cdp
      .send('Runtime.evaluate', {
        expression: `(() => { const a = window.__aqua || {}; return {
          frames: a.frames || 0, tick: a.tick ?? null, hash: a.hash ?? null,
          actionSeq: a.actionSeq ?? 0, journal: a.journal ?? 0, nutrients: a.nutrients ?? null,
          diverged: a.diverged === true, error: a.error || null,
          aqua: a,
          probe: (() => {
            const el = document.elementFromPoint(500, 400);
            const cv = document.getElementById('tank');
            return {
              top: el ? (el.id || el.tagName) : null,
              pe: cv ? getComputedStyle(cv).pointerEvents : null,
              cvSize: cv ? [cv.clientWidth, cv.clientHeight] : null,
              ui: window.__aquaUI ?? null,
            };
          })() }; })()`,
        returnByValue: true,
      })
      .catch(() => null);
    if (finalState?.result?.value) {
      const v = finalState.result.value;
      frames = v.frames ?? frames;
      world = {
        tick: v.tick ?? world.tick,
        hash: v.hash ?? world.hash,
        diverged: v.diverged === true,
        actionSeq: v.actionSeq ?? 0,
        journal: v.journal ?? 0,
        nutrients: v.nutrients ?? null,
        probe: v.probe ?? null,
        aqua: v.aqua ?? null,
      };
    }

    // ——— 截图 ———
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(out, Buffer.from(shot.data, 'base64'));

    return { console: consoleMessages, stderr, frames, ready, world };
  } finally {
    await cleanup();
  }
}

/**
 * 未打包扩展的 ID：目录绝对路径的 SHA-256 前 16 字节，
 * 每个半字节映射到 a..p。这样脚本不需要去 chrome://extensions 里抄 ID。
 */
export function extensionIdFor(absolutePath) {
  const digest = createHash('sha256').update(absolutePath).digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}
