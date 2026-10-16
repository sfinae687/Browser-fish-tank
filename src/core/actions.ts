/**
 * 玩家意图。
 *
 * ## 为什么操作必须走「日志 + 重放」，而不能直接改世界
 *
 * 这个架构里**每个表面各持一份世界**（DESIGN §3.1）。如果用户在新标签页里
 * 投了食、直接改本地那份世界，那么：
 *
 *   - 覆盖层那份世界完全不知道发生了什么
 *   - 覆盖层稍后写回快照，这次投食就被抹掉了
 *
 * 「确定性 ⇒ 不需要仲裁者」这条性质，前提是**所有表面看到同样的输入**。
 * 玩家操作也是一种输入，所以它必须变成**有序、带时间戳、可重放**的记录：
 *
 *   用户点击 → 追加一条带时刻的记录 → 各表面在下一次推进时
 *   把它应用到**正确的 tick 上**
 *
 * 于是：
 *   - 两个表面各自重放同一份日志，世界保持逐位一致
 *   - 关掉标签页三天再回来，日志里的投食会在快进时被正确地补上
 *   - 日志只是一串记录，坏掉了最坏也只是丢几次投食，不会毁掉世界
 *
 * ## 序号与去重
 *
 * 每条记录有单调递增的 `seq`，世界状态里记住 `lastActionSeq`。
 * 表面只应用序号更大的记录 —— 重复读取、重复重放都是幂等的。
 */

import { fx, unfx, clampFx } from './fixed.js';

export type ActionKind = 'feed' | 'breed';

export interface Action {
  /** 单调递增的序号 */
  seq: number;
  /** 发生的真实时刻（ms）。决定它落在世界的哪一步上。 */
  atMs: number;
  kind: ActionKind;
  /** feed：落点（缸内 uv，定点） */
  x?: number;
  y?: number;
  /** feed：投食量（定点） */
  amount?: number;
  /** breed：两条亲本的鱼 id */
  parentA?: number;
  parentB?: number;
}

/** 日志上限。超出的最旧记录被丢弃。 */
export const JOURNAL_LIMIT = 64;

/**
 * 一次投食的量，折算成无机盐。
 *
 * 这是玩家对系统最主要的**外部扰动** —— P4 那套生态会收敛到稳定平衡，
 * 而真正的藻华需要有人往里倒能量。投食就是那件事。
 */
export const FEED_NUTRIENTS = fx(0.55);
/** 投食同时带来的一点有机碎屑（没被吃掉的部分）。 */
export const FEED_DETRITUS = fx(0.06);

export function makeFeedAction(seq: number, atMs: number, x: number, y: number): Action {
  return {
    seq,
    atMs,
    kind: 'feed',
    x: clampFx(Math.round(x), 0, 1048576),
    y: clampFx(Math.round(y), 0, 1048576),
    amount: FEED_NUTRIENTS,
  };
}

export function makeBreedAction(seq: number, atMs: number, parentA: number, parentB: number): Action {
  return { seq, atMs, kind: 'breed', parentA, parentB };
}

/** 校验从存储里读回来的动作。坏记录直接丢掉，不影响其它记录。 */
export function sanitizeAction(raw: unknown): Action | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const seq = r['seq'];
  const atMs = r['atMs'];
  const kind = r['kind'];
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return null;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return null;
  if (kind !== 'feed' && kind !== 'breed') return null;

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const action: Action = { seq: Math.round(seq), atMs: Math.round(atMs), kind };
  if (kind === 'feed') {
    const x = num(r['x']);
    const y = num(r['y']);
    if (x === undefined || y === undefined) return null;
    action.x = x;
    action.y = y;
    action.amount = num(r['amount']) ?? FEED_NUTRIENTS;
  } else {
    const a = num(r['parentA']);
    const b = num(r['parentB']);
    if (a === undefined || b === undefined) return null;
    action.parentA = Math.round(a);
    action.parentB = Math.round(b);
  }
  return action;
}

/**
 * 整理日志：按序号排序、去重、截断到上限。
 *
 * 多个表面可能同时追加记录，所以读回来的日志未必是有序的、
 * 也未必没有重复。
 */
export function normalizeJournal(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: Action[] = [];
  for (const item of raw) {
    const a = sanitizeAction(item);
    if (!a || seen.has(a.seq)) continue;
    seen.add(a.seq);
    out.push(a);
  }
  out.sort((p, q) => p.seq - q.seq);
  return out.length > JOURNAL_LIMIT ? out.slice(out.length - JOURNAL_LIMIT) : out;
}

/** 供诊断与 HUD。 */
export function describeAction(a: Action): string {
  if (a.kind === 'feed') {
    return `投食 @ (${unfx(a.x ?? 0).toFixed(2)}, ${unfx(a.y ?? 0).toFixed(2)})`;
  }
  return `杂交 #${a.parentA} × #${a.parentB}`;
}
