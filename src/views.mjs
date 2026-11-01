/**
 * @file 产物视图：把上游返回值规范成生成器 / 报告要用的只读结构。
 *
 * 规划与执行都有两种返回形状，取决于调用方要的详细程度：
 *
 *   planCasesReport() → { cases, dropped, total, maxCases, unstable }
 *   planCases()       → TestCase[]，dropped / maxCases / unstable 挂在数组的非枚举属性上
 *   runPlanReport()   → { results, aborted, skipped, limits, elapsedMs, budget, ... }
 *   runPlan()         → RunResult[]，aborted / abortReason / skipped / elapsedMs / budget / baseUrl
 *                       挂在数组的非枚举属性上
 *
 * 下游（生成测试代码、写 Markdown 报告）不该关心调用方走的是哪条路径，
 * 所以统一在这里剥一层。这里只做只读适配，不补造字段：拿不到就是 null / 空数组，
 * 报告里会显示「未记录」，而不是编一个数字。
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 取出 TestCase 列表。- 传入 PlanReport 取 `cases`；传入数组原样返回。
 * @param {unknown} plan
 * @returns {import('./types.mjs').TestCase[]}
 */
export function casesOf(plan) {
  if (Array.isArray(plan)) return plan.filter(isObject);
  if (isObject(plan) && Array.isArray(plan.cases)) return plan.cases.filter(isObject);
  return [];
}

/**
 * 规划侧元信息。数组形态时读非枚举属性（与 planCases 的约定一致）。
 *
 * @param {unknown} plan
 * @returns {{
 *   cases: import('./types.mjs').TestCase[],
 *   dropped: string[],
 *   total: number,
 *   maxCases: number | null,
 *   unstable: Array<{ sourceElement?: string, page?: string, name?: string, reason?: string }>
 * }}
 */
export function planMetaOf(plan) {
  const cases = casesOf(plan);
  const dropped = stringArray(plan?.dropped);
  const total = finiteNumber(plan?.total) ?? cases.length + dropped.length;
  // 发生了截断时，保留条数就是本次生效的 maxCases；数组形态没有这个属性也能推出来。
  const maxCases = finiteNumber(plan?.maxCases) ?? (dropped.length > 0 ? cases.length : null);

  return {
    cases,
    dropped,
    total,
    maxCases,
    unstable: Array.isArray(plan?.unstable) ? plan.unstable.map(readUnstable).filter(Boolean) : [],
  };
}

/**
 * @param {unknown} raw
 * @returns {{ sourceElement?: string, page?: string, name?: string, reason?: string } | null}
 */
function readUnstable(raw) {
  if (typeof raw === 'string') return { sourceElement: raw };
  if (!isObject(raw)) return null;
  return {
    sourceElement: typeof raw.sourceElement === 'string' ? raw.sourceElement : undefined,
    page: typeof raw.page === 'string' ? raw.page : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

/**
 * 取出 RunResult 列表。- 传入 RunReport 取 `results`；传入数组原样返回。
 * @param {unknown} results
 * @returns {import('./types.mjs').RunResult[]}
 */
export function resultsOf(results) {
  if (Array.isArray(results)) return results.filter(isObject);
  if (isObject(results) && Array.isArray(results.results)) return results.results.filter(isObject);
  return [];
}

/**
 * 执行侧元信息。时间与步数的来源按可信度排序：
 *   1. RunReport 自带的 elapsedMs；
 *   2. 预算账本 budget.elapsedMs（与 1 通常相同）；
 *   3. 各次尝试 durationMs 之和（没有账本时的下界，会标明来源）。
 *
 * @param {unknown} results
 * @returns {{
 *   results: import('./types.mjs').RunResult[],
 *   elapsedMs: number,
 *   elapsedSource: 'report' | 'budget' | 'attempts' | 'none',
 *   stepsRun: number | null,
 *   casesStarted: number | null,
 *   casesCompleted: number | null,
 *   casesSkipped: number | null,
 *   limits: { maxWallMs: number | null, maxCases: number | null, maxSteps: number | null },
 *   skipped: Array<{ caseId: string, reason: string }>,
 *   aborted: boolean,
 *   abortReason: string | null,
 *   baseUrl: string | null
 * }}
 */
export function runMetaOf(results) {
  const list = resultsOf(results);
  const container = isObject(results) ? results : {};
  const budget = isObject(container.budget) ? container.budget : {};
  const limits = isObject(container.limits) ? container.limits : {};

  const attemptMs = list.reduce((sum, result) => {
    if (!Array.isArray(result.attempts)) return sum;
    return (
      sum +
      result.attempts.reduce(
        (inner, attempt) => inner + (finiteNumber(attempt?.durationMs) ?? 0),
        0,
      )
    );
  }, 0);

  const reportedMs = finiteNumber(container.elapsedMs);
  const budgetMs = finiteNumber(budget.elapsedMs);

  /** @type {'report' | 'budget' | 'attempts' | 'none'} */
  let elapsedSource = 'none';
  let elapsedMs = 0;
  if (reportedMs !== null) {
    elapsedMs = reportedMs;
    elapsedSource = 'report';
  } else if (budgetMs !== null) {
    elapsedMs = budgetMs;
    elapsedSource = 'budget';
  } else if (list.length > 0) {
    elapsedMs = attemptMs;
    elapsedSource = 'attempts';
  }

  const skipped = Array.isArray(container.skipped)
    ? container.skipped
        .filter(isObject)
        .filter((entry) => typeof entry.caseId === 'string')
        .map((entry) => ({
          caseId: entry.caseId,
          reason: typeof entry.reason === 'string' ? entry.reason : '未说明原因',
        }))
    : [];

  return {
    results: list,
    elapsedMs,
    elapsedSource,
    stepsRun: finiteNumber(budget.stepsRun),
    casesStarted: finiteNumber(budget.casesStarted),
    casesCompleted: finiteNumber(budget.casesCompleted),
    casesSkipped: finiteNumber(budget.casesSkipped),
    limits: {
      maxWallMs: finiteNumber(limits.maxWallMs) ?? finiteNumber(budget.maxWallMs),
      maxCases: finiteNumber(limits.maxCases) ?? finiteNumber(budget.maxCases),
      maxSteps: finiteNumber(limits.maxSteps) ?? finiteNumber(budget.maxSteps),
    },
    skipped,
    aborted: container.aborted === true,
    abortReason: typeof container.abortReason === 'string' ? container.abortReason : null,
    baseUrl: typeof container.baseUrl === 'string' ? container.baseUrl : null,
  };
}
