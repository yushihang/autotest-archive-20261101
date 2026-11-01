/**
 * @file 用例规划：Inventory → TestCase[]。
 *
 * 这一层刻意保持成纯函数：只读入 Inventory 与 limits，不做 IO、不碰浏览器、
 * 不使用随机数和当前时间，所以同一份输入永远得到同一份输出，可以离线单测，
 * 也可以在将来整体替换成 AI 规划而不影响上下游。
 *
 * 职责边界很清楚：
 *   - 生成什么行为、优先级怎么定、边界条件怎么展开 → 全在 rules.mjs；
 *   - 这里只做元素规范化、组装、断言兜底、去重、排序和按 maxCases 截断。
 */

import { ELEMENT_KINDS, STEP_ACTIONS } from '../types.mjs';
import {
  BOUNDARY_RULES,
  KIND_RULES,
  PRIORITY_RANK,
  detectSemantic,
  downgradePriority,
  slugOf,
} from './rules.mjs';

/** limits.maxCases 缺省时的上限。与 examples 里的默认值保持一致。 */
export const DEFAULT_MAX_CASES = 20;

/**
 * 因选择器不稳定而被降权 / 跳过的元素。
 * 报告要写清「为什么这个元素没有用例」，所以规划阶段不能把它静默丢掉。
 *
 * @typedef {object} UnstableElement
 * @property {string} sourceElement 元素选择器，对应 Inventory.elements[].selector
 * @property {string} page 元素所在路由
 * @property {string} name 元素的可访问名
 * @property {string} reason 人可读的原因
 */

/**
 * 规划报告。cases 是契约要求的 TestCase[]；dropped 是被 maxCases 截断的用例 id。
 * @typedef {object} PlanReport
 * @property {import('../types.mjs').TestCase[]} cases 最终用例，已按优先级排序
 * @property {string[]} dropped 因 maxCases 被丢弃的用例 id，保留原优先级顺序
 * @property {number} total 去重后、截断前的候选数量
 * @property {number} maxCases 本次生效的用例数上限，报告里要写「超出多少条」时用
 * @property {UnstableElement[]} unstable 选择器不稳定、被降权或跳过的元素，按 Inventory 顺序
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMaxCases(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_CASES;
  return Math.max(0, Math.floor(value));
}

/**
 * maxSteps 缺省 / 非法时视为不限制；边界用例步骤较长，截断步骤会破坏语义，
 * 所以超过预算的候选直接不生成，而不是砍掉后半段。
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMaxSteps(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * 把外部输入规范成 InventoryElement，并丢掉无法定位的元素。
 * 不修改调用方对象；未知 kind 归为 'other'。
 * @param {unknown} raw
 * @returns {import('../types.mjs').InventoryElement | null}
 */
function normalizeElement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const selector = typeof source.selector === 'string' ? source.selector.trim() : '';
  if (!selector) return null;

  const page =
    typeof source.page === 'string' && source.page.trim() ? source.page.trim() : '/';
  const kind = ELEMENT_KINDS.includes(source.kind) ? source.kind : 'other';

  return {
    ...source,
    selector,
    page,
    kind,
    name: typeof source.name === 'string' ? source.name : String(source.name ?? ''),
    role: typeof source.role === 'string' ? source.role : 'other',
  };
}

/**
 * 一条步骤是否可执行。fill 的 value 允许是空字符串——空输入正是要测的边界。
 * @param {unknown} step
 * @returns {boolean}
 */
function isValidStep(step) {
  if (!step || typeof step !== 'object') return false;
  const candidate = /** @type {import('../types.mjs').TestStep} */ (step);
  if (!STEP_ACTIONS.includes(candidate.action)) return false;

  if (candidate.action === 'goto') {
    return typeof candidate.page === 'string' && candidate.page.startsWith('/');
  }
  if (candidate.action === 'waitFor' && candidate.waitState === 'networkidle') {
    return true;
  }
  return typeof candidate.target === 'string' && candidate.target.length > 0;
}

/**
 * 稳定 id：`P0-login-email-fill` 这样的可读形式。
 * 页面语义与元素 slug 重叠时省略一段，避免出现 `P0-login-login-submit-submit`。
 * @param {import('../types.mjs').Priority} priority
 * @param {string} semantic
 * @param {string} slug
 * @param {string} behavior
 * @returns {string}
 */
function makeCaseId(priority, semantic, slug, behavior) {
  const parts = [priority];
  if (semantic !== 'generic' && !slug.startsWith(`${semantic}-`)) {
    parts.push(semantic);
  }
  parts.push(slug);
  if (slug !== behavior && !slug.endsWith(`-${behavior}`)) {
    parts.push(behavior);
  }
  return parts.join('-');
}

/**
 * 由一条规则 + 一个元素组装候选。任何一项不满足契约（无步骤、无断言、无标题、
 * 优先級非法）都返回 null，宁可不生成，也不产出无法 review 的空壳用例。
 * @param {import('./rules.mjs').PlanRule} rule
 * @param {import('./rules.mjs').PlanContext} ctx
 * @param {number} order
 * @returns {{ testCase: import('../types.mjs').TestCase, dedupeKey: string, order: number } | null}
 */
function buildCandidate(rule, ctx, order) {
  if (typeof rule.when === 'function' && !rule.when(ctx)) return null;

  const rawSteps = rule.steps(ctx);
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  if (!rawSteps.every(isValidStep)) return null;

  const expect = rule.expect(ctx)
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (expect.length === 0) return null;

  let priority = rule.priority(ctx);
  if (!(priority in PRIORITY_RANK)) return null;

  // 选择器不稳定：降权；已经是最低优先级就宁可不测。
  if (ctx.element.unstable === true) {
    priority = downgradePriority(priority);
    if (!priority) return null;
  }

  const title = String(rule.title(ctx)).trim();
  if (!title) return null;

  const steps = [{ action: 'goto', page: ctx.element.page }, ...rawSteps];
  const actionKey =
    typeof rule.dedupeAction === 'function'
      ? rule.dedupeAction(ctx)
      : rule.dedupeAction ?? rawSteps.find((step) => step.action !== 'goto')?.action ?? 'action';

  const slug = slugOf(ctx.element);
  const id = makeCaseId(priority, ctx.semantic, slug, rule.id);

  return {
    testCase: {
      id,
      title,
      priority,
      steps,
      expect,
      sourceElement: ctx.element.selector,
    },
    dedupeKey: `${ctx.element.page}\u0000${ctx.element.selector}\u0000${actionKey}`,
    order,
  };
}

/**
 * 完整的规划结果。
 * @param {import('../types.mjs').Inventory} inventory
 * @param {import('../config.mjs').LimitsConfig | { maxCases?: number, maxSteps?: number }} [limits]
 * @returns {PlanReport}
 */
export function planCasesReport(inventory, limits) {
  const maxCases = normalizeMaxCases(limits?.maxCases);

  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.elements)) {
    return { cases: [], dropped: [], total: 0, maxCases, unstable: [] };
  }

  const maxSteps = normalizeMaxSteps(limits?.maxSteps);

  /** @type {import('../types.mjs').InventoryElement[]} */
  const elements = [];
  for (const raw of inventory.elements) {
    const element = normalizeElement(raw);
    if (element) elements.push(element);
  }

  /** @type {Map<string, import('../types.mjs').InventoryElement[]>} */
  const byPage = new Map();
  for (const element of elements) {
    const group = byPage.get(element.page);
    if (group) group.push(element);
    else byPage.set(element.page, [element]);
  }

  /** @type {Map<string, import('../types.mjs').InventoryRoute>} */
  const routes = new Map();
  if (Array.isArray(inventory.routes)) {
    for (const route of inventory.routes) {
      if (route && typeof route.path === 'string') routes.set(route.path, route);
    }
  }

  /** @type {Array<{ testCase: import('../types.mjs').TestCase, dedupeKey: string, order: number }>} */
  const candidates = [];
  const seen = new Set();
  const usedIds = new Set();

  for (const [index, element] of elements.entries()) {
    const semantic = detectSemantic(element);
    /** @type {import('./rules.mjs').PlanContext} */
    const ctx = {
      element,
      semantic,
      siblings: byPage.get(element.page) ?? [element],
      route: routes.get(element.page),
      index,
    };

    const rules = [...(KIND_RULES[element.kind] ?? []), ...BOUNDARY_RULES];

    for (const rule of rules) {
      const candidate = buildCandidate(rule, ctx, candidates.length);
      if (!candidate) continue;

      // 同一页、同一选择器、同一动作只留第一条，避免探测重复收集元素时用例翻倍。
      if (seen.has(candidate.dedupeKey)) continue;
      if (candidate.testCase.steps.length > maxSteps) continue;

      // id 必须唯一：不同元素可能得到同一个 slug，用稳定序号区分。
      const baseId = candidate.testCase.id;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      candidate.testCase.id = id;

      seen.add(candidate.dedupeKey);
      candidates.push(candidate);
    }
  }

  // 优先级从高到低；同优先级保持生成顺序（Inventory 顺序），不依赖排序实现的稳定性。
  const sorted = candidates
    .slice()
    .sort(
      (left, right) =>
        PRIORITY_RANK[left.testCase.priority] - PRIORITY_RANK[right.testCase.priority] ||
        left.order - right.order,
    );

  const kept = sorted.slice(0, maxCases);
  const dropped = sorted.slice(maxCases).map((candidate) => candidate.testCase.id);

  // 不稳定元素按 Inventory 顺序原样报出来；它们可能降级后仍有用例，也可能被整条跳过。
  const unstable = elements
    .filter((element) => element.unstable === true)
    .map((element) => ({
      sourceElement: element.selector,
      page: element.page,
      name: element.name,
      reason: '选择器含自增 id / 随机 hash，不稳定：已降权，降到最低仍不值的直接跳过',
    }));

  return {
    cases: kept.map((candidate) => candidate.testCase),
    dropped,
    total: sorted.length,
    maxCases,
    unstable,
  };
}

/**
 * 从 Inventory 规划用例。
 *
 * 返回值是 TestCase[]；被 maxCases 截断的 id、生效的 maxCases、不稳定元素以非枚举
 * 属性挂在数组上，既保持数组形状，又能让下游报告「哪些没测、为什么没测」：
 *
 *   const cases = planCases(inventory, limits);
 *   cases.dropped   // string[]
 *   cases.maxCases  // number
 *   cases.unstable  // UnstableElement[]
 *
 * 需要一次拿到 cases / dropped / total 时用 planCasesReport。
 *
 * @param {import('../types.mjs').Inventory} inventory
 * @param {import('../config.mjs').LimitsConfig | { maxCases?: number, maxSteps?: number }} [limits]
 * @returns {import('../types.mjs').TestCase[]}
 */
export function planCases(inventory, limits) {
  const report = planCasesReport(inventory, limits);

  // 与 dropped 一致：非枚举，避免污染 JSON 里的 TestCase[]。
  for (const [name, value] of [
    ['dropped', report.dropped],
    ['maxCases', report.maxCases],
    ['unstable', report.unstable],
  ]) {
    Object.defineProperty(report.cases, name, {
      value,
      enumerable: false,
      configurable: false,
    });
  }

  return report.cases;
}
