/**
 * @file 执行预算：三条硬上限（总时长 / 用例数 / 单例步数）。
 *
 * 预算是执行器的刹车，不是建议值：任何一条先到就立即停，已经跑完的结果照常返回，
 * 没跑的部分在 `abortReason` 里写清楚停在哪、为什么停。判断「要不要再试一次」
 * 之前必须先问预算，不能等跑完再回头算账。
 *
 * 三种上限的分工：
 *   - maxWallMs：从 runPlan 开始计时，覆盖建 context、导航、点击、截图在内的全部耗时；
 *   - maxCases：最多开始多少条用例，超出的用例连浏览器都不打开；
 *   - maxSteps：单条用例最多多少步，步骤数超限的用例不执行——砍掉后半段会让断言失去意义。
 *
 * MVP 没有 LLM，token 预算不在这里；调用方给的 token / 金额上限属于任务参数，
 * 与这里的「这次跑多少」互不替代。
 */

/** 没给 limits.maxWallMs 时的兜底总预算（毫秒），与 probe 的默认值保持一致。 */
export const DEFAULT_MAX_WALL_MS = 300_000;

/** 没给 limits.maxCases 时视为不限制。config 校验会保证正常配置里一定有值。 */
export const DEFAULT_MAX_CASES = Number.POSITIVE_INFINITY;

/** 没给 limits.maxSteps 时视为不限制。config 校验会保证正常配置里一定有值。 */
export const DEFAULT_MAX_STEPS = Number.POSITIVE_INFINITY;

/**
 * 预算耗尽后抛出的错误。执行器内部的正常路径用 `beginCase()` 的返回值判断，
 * 这个错误只留给「已经跑到一半、必须立刻中断」的调用方使用。
 */
export class BudgetExceededError extends Error {
  /**
   * @param {string} message 人能读懂的中止原因
   * @param {{ limit?: BudgetLimit, caseId?: string, stepIndex?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    /** @type {BudgetLimit | undefined} */
    this.limit = options.limit;
    /** @type {string | undefined} */
    this.caseId = options.caseId;
    /** @type {number | undefined} */
    this.stepIndex = options.stepIndex;
  }
}

/**
 * @typedef {'maxWallMs' | 'maxCases' | 'maxSteps'} BudgetLimit
 */

/**
 * 把外部传入的上限规范化成非负整数；非法值回落到默认值。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function normalizeLimit(value, fallback, min) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/**
 * @param {unknown} testCase
 * @returns {string}
 */
function caseIdOf(testCase) {
  const id = /** @type {{ id?: unknown }} */ (testCase)?.id;
  return typeof id === 'string' && id !== '' ? id : '(无 id 用例)';
}

/**
 * 一次 runPlan 的预算账本。
 *
 * 用法（每一步之前都要问，不能事后补账）：
 *
 *   const budget = new RunBudget(limits);
 *   for (const testCase of cases) {
 *     if (!budget.beginCase(testCase)) break;   // 超限，已自动记下原因
 *     ...
 *     budget.recordStep();
 *     budget.endCase();
 *   }
 *   budget.abortReason; // 没超限时是 null
 */
export class RunBudget {
  /**
   * @param {{ maxWallMs?: number, maxCases?: number, maxSteps?: number }} [limits]
   * @param {{ now?: () => number }} [options] now 可注入，便于测试时间相关逻辑
   */
  constructor(limits = {}, options = {}) {
    /** @type {() => number} */
    this.now = options.now ?? Date.now;

    /** @type {number} */
    this.maxWallMs = normalizeLimit(limits?.maxWallMs, DEFAULT_MAX_WALL_MS, 1);
    /** @type {number} */
    this.maxCases = normalizeLimit(limits?.maxCases, DEFAULT_MAX_CASES, 0);
    /** @type {number} */
    this.maxSteps = normalizeLimit(limits?.maxSteps, DEFAULT_MAX_STEPS, 0);

    /** @type {number} */
    this.startedAt = this.now();
    /** @type {number} */
    this.deadline = this.startedAt + this.maxWallMs;

    /** 已经开始执行的用例数（含正在跑的那条）。 */
    this.casesStarted = 0;
    /** 已经完整跑完的用例数。 */
    this.casesCompleted = 0;
    /** 已经执行过的步骤数，用于中止报告。 */
    this.stepsRun = 0;

    /** @type {boolean} */
    this.aborted = false;
    /** @type {BudgetLimit | null} */
    this.abortLimit = null;
    /** @type {string | null} */
    this.abortReason = null;
  }

  /** 从开始到现在花掉的毫秒数。 */
  elapsedMs() {
    return Math.max(0, this.now() - this.startedAt);
  }

  /** 距离总时长上限还剩多少毫秒；已耗尽时返回 0，不返回负数。 */
  remainingMs() {
    return Math.max(0, this.deadline - this.now());
  }

  /**
   * 为一次操作取可用时长：请求值与剩余总预算取小，且至少留 1ms。
   * 预算已经耗尽时返回 0，调用方必须停下来。
   * @param {number} [requestedMs]
   * @returns {number}
   */
  timeoutFor(requestedMs) {
    const remaining = this.remainingMs();
    if (remaining <= 0) return 0;
    if (typeof requestedMs !== 'number' || !Number.isFinite(requestedMs) || requestedMs <= 0) {
      return Math.max(1, Math.floor(remaining));
    }
    return Math.max(1, Math.min(Math.floor(requestedMs), Math.floor(remaining)));
  }

  /**
   * 开始一条用例前的闸门。返回 false 时预算已标记为中止，调用方必须立即退出。
   * @param {import('../types.mjs').TestCase} testCase
   * @returns {boolean}
   */
  beginCase(testCase) {
    if (this.aborted) return false;

    if (this.remainingMs() <= 0) {
      return this.abort(
        'maxWallMs',
        `用例 ${caseIdOf(testCase)} 开始前总时长预算已耗尽`,
      );
    }

    if (this.casesStarted >= this.maxCases) {
      return this.abort(
        'maxCases',
        `用例 ${caseIdOf(testCase)} 未执行，已到用例数上限 ${this.maxCases} 条`,
      );
    }

    const stepCount = Array.isArray(testCase?.steps) ? testCase.steps.length : 0;
    if (stepCount > this.maxSteps) {
      return this.abort(
        'maxSteps',
        `用例 ${caseIdOf(testCase)} 有 ${stepCount} 步，超过单例上限 ${this.maxSteps} 步，整条不执行`,
      );
    }

    this.casesStarted += 1;
    return true;
  }

  /** 记一步已经真正交给浏览器执行。 */
  recordStep() {
    this.stepsRun += 1;
  }

  /** 一条用例的全部尝试都结束了（即使是失败结论，也算跑完）。 */
  endCase() {
    this.casesCompleted += 1;
  }

  /**
   * 立刻中止，并记下原因。重复调用只保留第一次的原因。
   * @param {BudgetLimit} limit
   * @param {string} [detail]
   * @returns {false} 始终返回 false，方便 `return this.abort(...)`
   */
  abort(limit, detail = '') {
    if (this.aborted) return false;

    const label = {
      maxWallMs: `总时长上限 ${this.maxWallMs}ms 已用尽`,
      maxCases: `用例数上限 ${this.maxCases} 条已用尽`,
      maxSteps: `单条用例步骤上限 ${this.maxSteps} 步已超出`,
    }[limit];

    const usage = `已执行 ${this.casesCompleted}/${this.casesStarted} 条用例、${this.stepsRun} 步，耗时 ${this.elapsedMs()}ms`;
    this.aborted = true;
    this.abortLimit = limit;
    this.abortReason = `${label}${detail ? `：${detail}` : ''}；${usage}`;
    return false;
  }

  /**
   * 预算快照，便于调用方把「这次允许跑多少」原样写进报告。
   * @returns {{ maxWallMs: number, maxCases: number, maxSteps: number, elapsedMs: number, casesStarted: number, casesCompleted: number, stepsRun: number }}
   */
  snapshot() {
    return {
      maxWallMs: this.maxWallMs,
      maxCases: this.maxCases,
      maxSteps: this.maxSteps,
      elapsedMs: this.elapsedMs(),
      casesStarted: this.casesStarted,
      casesCompleted: this.casesCompleted,
      stepsRun: this.stepsRun,
    };
  }
}

/**
 * `new RunBudget()` 的简写，给只想传一个 limits 的调用方。
 * @param {{ maxWallMs?: number, maxCases?: number, maxSteps?: number }} [limits]
 * @param {{ now?: () => number }} [options]
 * @returns {RunBudget}
 */
export function createBudget(limits, options) {
  return new RunBudget(limits, options);
}
