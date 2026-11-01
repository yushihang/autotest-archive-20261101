/**
 * @file 执行器：TestCase[] → RunResult[]。
 *
 * 执行是整条链路里唯一产生「结论」的环节，所以这里的每条规则都偏向「不骗人」：
 *
 *   - 每条用例按 `runner.repeat` 跑多次，再按 retry.mjs 归因成 passed / failed / flaky；
 *   - 每次尝试都新建 BrowserContext（空 cookie / 空 storage / 屏蔽 Service Worker），
 *     上一条用例的登录态、localStorage、页面内存都无法污染下一条；
 *   - 每条尝试、每一步之前都问预算（budget.mjs）：总时长 / 用例数到顶立即停，已跑完的结果
 *     照常返回；单例步数超限只跳过那一条用例，其余用例继续跑；
 *   - 失败时截图、抓 console、记录到失败那一步为止的最小复现步骤（evidence.mjs）。
 *
 * 关于断言：TestCase.expect 是写给人 review 的自然语言，执行器不从文字反推结论
 * （见 types.mjs 的说明）。机器能判的部分都编码在步骤和页面信号里——步骤抛错、
 * 主框架导航 4xx/5xx、页面未捕获异常，任一出现都算这次尝试失败。这样「同一个用例
 * 跑两次结论一致」不依赖模型读懂一句中文。
 *
 * 网络边界：除了 `baseUrl` 同源地址，其他请求一律在浏览器层 abort。探测阶段已经
 * 排除了外链，这里再兜一层，避免点击把执行器带到外网去。
 */

import { chromium } from 'playwright';

import { DEFAULT_OUTPUT_DIR, joinUrl } from '../config.mjs';
import { RunBudget } from './budget.mjs';
import {
  attachConsoleRecorder,
  buildEvidence,
  captureScreenshot,
  describeStepFailure,
  formatError,
} from './evidence.mjs';
import { runWithRetry, toContractAttempts } from './retry.mjs';

/** 单条用例（一次尝试）的硬超时：30s。再久就不是「跑用例」，而是在等一个死页面。 */
export const DEFAULT_CASE_TIMEOUT_MS = 30_000;

/** 失败截图最多等多久；截图不可用不能反过来拖垮整轮执行。 */
const SCREENSHOT_TIMEOUT_MS = 5_000;

/**
 * 执行报告的完整形态。runPlan 只返回 results（契约要求的数组），
 * 需要一次性拿到 aborted / abortReason / 预算账本时用 runPlanReport。
 *
 * @typedef {object} RunReport
 * @property {import('../types.mjs').RunResult[]} results 已完成的用例结果
 * @property {boolean} aborted 是否因预算/上限提前中止
 * @property {string | null} abortReason 中止原因；没中止时为 null
 * @property {{ caseId: string, reason: string }[]} skipped 因超过 maxSteps 而整条跳过的用例（不算中止）
 * @property {string} baseUrl 规范化后的站点根地址
 * @property {{ maxWallMs: number, maxCases: number, maxSteps: number }} limits 本次生效的上限
 * @property {number} elapsedMs 总耗时
 * @property {ReturnType<RunBudget['snapshot']>} budget 预算账本快照
 */

/**
 * 校验并补全 TestCase。字段只补 default，不修改调用方对象。
 * @param {unknown} plan TestCase[] 或 planCasesReport() 的返回值
 * @returns {import('../types.mjs').TestCase[]}
 */
function normalizeCases(plan) {
  if (plan === undefined || plan === null) {
    throw new TypeError('runPlan 需要 TestCase[]（或 planCasesReport() 的返回值）');
  }

  const source = Array.isArray(plan)
    ? plan
    : Array.isArray(/** @type {{ cases?: unknown }} */ (plan).cases)
      ? /** @type {{ cases: unknown[] }} */ (plan).cases
      : null;

  if (!source) {
    throw new TypeError('runPlan 的 plan 必须是 TestCase[]，或带 cases 数组的规划报告');
  }

  return source.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`plan[${index}] 不是 TestCase 对象`);
    }

    const testCase = /** @type {import('../types.mjs').TestCase} */ (raw);
    if (!Array.isArray(testCase.steps) || testCase.steps.length === 0) {
      throw new TypeError(`plan[${index}]（${testCase.id ?? '无 id'}）缺少非空 steps`);
    }

    return {
      ...testCase,
      id:
        typeof testCase.id === 'string' && testCase.id !== ''
          ? testCase.id
          : `case-${index + 1}`,
      steps: testCase.steps.slice(),
      expect: Array.isArray(testCase.expect) ? testCase.expect.map(String) : [],
    };
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('runPlan 需要 options.baseUrl，例如 http://127.0.0.1:4173');
  }

  /** @type {URL} */
  let url;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new TypeError(`baseUrl 不是合法 URL：${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`baseUrl 只支持 http / https，当前是 ${url.protocol}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('baseUrl 不能带查询串或 hash，具体路由写在步骤的 page 里');
  }

  // 与 config.mjs 保持一致：统一去掉结尾斜杠，拼接时只在一处加。
  return url.toString().replace(/\/+$/, '');
}

/**
 * 起一个 headless Chromium；失败信息直接指向安装命令。
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (cause) {
    throw new Error(
      `启动 Chromium 失败：确认已安装浏览器（npx playwright install chromium）。原始错误：${formatError(cause)}`,
      { cause },
    );
  }
}

/**
 * 只允许 baseUrl 同源请求和 data/blob/about 这类本地协议。
 * @param {string} rawUrl
 * @param {string} origin
 * @returns {boolean}
 */
function isLocalRequest(rawUrl, origin) {
  if (
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('about:')
  ) {
    return true;
  }

  try {
    return new URL(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 为一次尝试创建干净、且被限制在 baseUrl 内的上下文。
 *
 * 新建 context 本身就是空存储；这里再显式 clearCookies，是为了防止以后有人把它改成
 * 「复用 context」时悄悄把上一条用例的登录态带进来。Service Worker 直接屏蔽：
 * 它会跨 context 持久化缓存和后台逻辑，是测试之间最常见的隐形污染源。
 *
 * @param {import('playwright').Browser} browser
 * @param {string} baseUrl
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function createIsolatedContext(browser, baseUrl) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.clearCookies().catch(() => {});

  const origin = new URL(baseUrl).origin;
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (isLocalRequest(requestUrl, origin)) {
      await route.continue().catch(() => {});
      return;
    }
    // 除 baseUrl 外不联网：外链、CDN、统计脚本一律在浏览器层掐断。
    await route.abort('blockedbyclient').catch(() => {});
  });

  return context;
}

/**
 * 把步骤里的 page（以 '/' 开头）拼到 baseUrl 上，并确认没有跑出站点。
 *
 * 拼接必须走 config.mjs 的 joinUrl：`new URL('/login', baseUrl)` 会按 origin 解析，
 * 把 baseUrl 的路径前缀丢掉（`https://example.com/app` + `/login` → `https://example.com/login`），
 * 与探测 / 规划存下的路由对不上。导出是为了让测试直接钉住带前缀的 baseUrl。
 *
 * @param {string} baseUrl
 * @param {unknown} pagePath
 * @returns {string}
 */
export function toUrl(baseUrl, pagePath) {
  const raw =
    typeof pagePath === 'string' && pagePath.trim() !== '' ? pagePath.trim() : '/';

  if (!raw.startsWith('/')) {
    throw new Error(`步骤里的地址必须以 '/' 开头（相对站点根），当前是：${raw}`);
  }

  /** @type {URL} */
  let url;
  try {
    url = new URL(joinUrl(baseUrl, raw));
  } catch {
    throw new Error(`步骤里的地址不合法：${raw}`);
  }

  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error(`步骤要打开 ${url.href}，不在 baseUrl（${baseUrl}）内，已阻止`);
  }

  return url.href;
}

/**
 * 取步骤的 locator；target 缺失时给出能直接定位问题的错误。
 * @param {import('playwright').Page} page
 * @param {import('../types.mjs').TestStep} step
 * @returns {import('playwright').Locator}
 */
function locatorOf(page, step) {
  if (typeof step.target !== 'string' || step.target.trim() === '') {
    throw new Error(`${step.action} 步骤缺少 target`);
  }
  return page.locator(step.target);
}

/**
 * waitFor 的 value 是「地址片段或正则源码」：先按正则编译；不是合法正则时按字面量匹配。
 * @param {string} value
 * @returns {RegExp}
 */
function toUrlPattern(value) {
  try {
    return new RegExp(value);
  } catch {
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

/**
 * 执行单个步骤。所有超时都由调用方按「剩余预算 / 单例 30s」算好传进来，
 * 这里不再自己发明超时值。
 *
 * @param {import('playwright').Page} page
 * @param {import('../types.mjs').TestStep} step
 * @param {{ baseUrl: string, timeout: number }} context
 * @returns {Promise<void>}
 */
async function executeStep(page, step, context) {
  const { baseUrl, timeout } = context;

  switch (step.action) {
    case 'goto': {
      const url = toUrl(baseUrl, step.page);
      const response = await page.goto(url, { timeout, waitUntil: 'load' });
      if (response && response.status() >= 400) {
        throw new Error(`打开 ${url} 返回 HTTP ${response.status()}`);
      }
      return;
    }
    case 'click':
      await locatorOf(page, step).click({ timeout });
      return;
    case 'fill':
      await locatorOf(page, step).fill(String(step.value ?? ''), { timeout });
      return;
    case 'press':
      await locatorOf(page, step).press(String(step.value ?? ''), { timeout });
      return;
    case 'select':
      await locatorOf(page, step).selectOption(String(step.value ?? ''), { timeout });
      return;
    case 'check':
      await locatorOf(page, step).check({ timeout });
      return;
    case 'uncheck':
      await locatorOf(page, step).uncheck({ timeout });
      return;
    case 'waitFor': {
      const state = step.waitState ?? 'visible';

      if (state === 'visible' || state === 'hidden') {
        await locatorOf(page, step).waitFor({ state, timeout });
        return;
      }
      if (state === 'url') {
        if (typeof step.value !== 'string' || step.value === '') {
          throw new Error('waitFor(url) 步骤缺少 value');
        }
        await page.waitForURL(toUrlPattern(step.value), { timeout, waitUntil: 'load' });
        return;
      }
      if (state === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout });
        return;
      }
      throw new Error(`未知的 waitState：${state}`);
    }
    default:
      throw new Error(`未知的步骤动作：${step.action}`);
  }
}

/**
 * 步骤自己的 timeoutMs 与剩余可用时间取小；剩余时间必须 >= 1ms。
 * @param {import('../types.mjs').TestStep} step
 * @param {number} remaining
 * @returns {number}
 */
function stepTimeoutFor(step, remaining) {
  const available = Math.max(1, Math.floor(remaining));
  const requested = step?.timeoutMs;

  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return available;
  }
  return Math.max(1, Math.min(Math.floor(requested), available));
}

/**
 * @param {import('playwright').Page} page
 * @returns {string | undefined}
 */
function currentUrl(page) {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/**
 * 跑一次尝试。调用方保证每次调用都新建 context；这里只关心这一条用例。
 *
 * @param {{
 *   browser: import('playwright').Browser,
 *   baseUrl: string,
 *   testCase: import('../types.mjs').TestCase,
 *   attemptIndex: number,
 *   budget: RunBudget,
 *   outputDir: string,
 *   cwd: string,
 * }} options
 * @returns {Promise<import('./retry.mjs').InternalAttempt>}
 */
async function runAttempt(options) {
  const { browser, baseUrl, testCase, attemptIndex, budget, outputDir, cwd } = options;

  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const startedMs = Date.now();
  const caseDeadline = startedMs + DEFAULT_CASE_TIMEOUT_MS;

  /** @type {import('playwright').BrowserContext | undefined} */
  let context;
  /** @type {import('playwright').Page | undefined} */
  let page;
  /** @type {ReturnType<typeof attachConsoleRecorder> | undefined} */
  let recorder;

  /** @type {{ message: string, stepIndex: number | null, kind: string } | null} */
  let failure = null;
  let aborted = false;
  /** @type {string | undefined} */
  let screenshot;

  /** @type {import('../types.mjs').TestStep[]} 已尝试过的步骤，含失败那一步 */
  const attemptedSteps = [];

  try {
    context = await createIsolatedContext(browser, baseUrl);
    page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_CASE_TIMEOUT_MS);
    recorder = attachConsoleRecorder(page);

    for (let stepIndex = 0; stepIndex < testCase.steps.length; stepIndex += 1) {
      const step = testCase.steps[stepIndex];

      // 真正开跑之前先问预算：总时长和单例 30s 谁先耗尽就停谁。
      const wallRemaining = budget.remainingMs();
      const caseRemaining = caseDeadline - Date.now();
      const remaining = Math.min(wallRemaining, caseRemaining);

      if (remaining <= 0) {
        if (wallRemaining <= 0) {
          budget.abort(
            'maxWallMs',
            `用例 ${testCase.id} 第 ${stepIndex + 1} 步前预算耗尽`,
          );
          aborted = true;
          failure = {
            message: `超出总时长上限 ${budget.maxWallMs}ms，第 ${stepIndex + 1} 步未执行`,
            stepIndex,
            kind: 'budget',
          };
        } else {
          failure = {
            message: `单条用例超过 ${DEFAULT_CASE_TIMEOUT_MS}ms 上限，第 ${stepIndex + 1} 步未执行`,
            stepIndex,
            kind: 'timeout',
          };
        }
        break;
      }

      attemptedSteps.push(step);
      budget.recordStep();

      try {
        await executeStep(page, step, {
          baseUrl,
          timeout: stepTimeoutFor(step, remaining),
        });
      } catch (cause) {
        failure = {
          message: describeStepFailure(stepIndex, step, cause),
          stepIndex,
          kind: 'step',
        };
        break;
      }
    }

    // 步骤本身都过了，再核一遍页面级信号：未捕获异常和主框架 4xx/5xx 同样算失败。
    if (!failure && recorder.pageErrors.length > 0) {
      failure = {
        message: `页面出现未捕获异常（${recorder.pageErrors.length} 处）：${recorder.pageErrors[0]}`,
        stepIndex: null,
        kind: 'pageerror',
      };
    } else if (!failure && recorder.navigationErrors.length > 0) {
      failure = {
        message: `主框架导航返回错误状态：${recorder.navigationErrors[0]}`,
        stepIndex: null,
        kind: 'http',
      };
    }

    // 预算中止时不再花时间截图：超限的第一原则是立刻停。
    if (failure && !aborted) {
      const shotBudget = Math.min(SCREENSHOT_TIMEOUT_MS, budget.remainingMs());
      if (shotBudget > 0) {
        screenshot = await captureScreenshot(page, {
          outputDir,
          cwd,
          caseId: testCase.id,
          attemptIndex,
          timeoutMs: shotBudget,
        }).catch(() => undefined);
      }
    }

    const evidence = buildEvidence({
      testCase,
      attemptIndex,
      failure,
      attemptedSteps,
      consoleErrors: recorder.consoleErrors,
      pageErrors: recorder.pageErrors,
      navigationErrors: recorder.navigationErrors,
      screenshot,
      pageUrl: currentUrl(page),
    });

    /** @type {import('./retry.mjs').InternalAttempt} */
    const attempt = {
      index: attemptIndex,
      status: failure ? (aborted ? 'error' : 'failed') : 'passed',
      durationMs: Date.now() - startedMs,
      startedAt,
      evidence,
      aborted,
    };
    if (failure) attempt.error = failure.message;

    return attempt;
  } catch (cause) {
    // 建 context / 开页面这类执行环境问题：结论是 error，不是 failed。
    const evidence = buildEvidence({
      testCase,
      attemptIndex,
      failure: {
        message: `执行环境异常：${formatError(cause)}`,
        stepIndex: null,
        kind: 'environment',
      },
      attemptedSteps,
      consoleErrors: recorder?.consoleErrors ?? [],
      pageErrors: recorder?.pageErrors ?? [],
      navigationErrors: recorder?.navigationErrors ?? [],
      pageUrl: page ? currentUrl(page) : undefined,
    });

    return {
      index: attemptIndex,
      status: 'error',
      durationMs: Date.now() - startedMs,
      startedAt,
      error: formatError(cause),
      evidence,
      aborted,
    };
  } finally {
    // 无论成败都关掉 context：下一次尝试必须从零开始。
    if (context) await context.close().catch(() => {});
  }
}

/**
 * 选一条最有信息量的证据：
 *   - passed：任意一次（都用最后一次，避免把中途的偶发 console 错误当成结论）；
 *   - failed / error：第一次非 passed 的尝试；
 *   - flaky：第一次失败的那次——这才是需要归因的对象。
 *
 * @param {{ status: string | null, attempts: import('./retry.mjs').InternalAttempt[] }} outcome
 * @returns {import('../types.mjs').Evidence}
 */
function pickEvidence(outcome) {
  const attempts = outcome.attempts;

  if (outcome.status === 'passed') {
    return attempts[attempts.length - 1].evidence;
  }

  const firstBad = attempts.find((attempt) => attempt.status !== 'passed');
  return (firstBad ?? attempts[0]).evidence;
}

/**
 * 内部尝试 → 契约里的 RunResult。
 *
 * 预算在重试中途耗尽时，`repeat` 次没有跑完，不能拿已有的一两次结果冒充最终结论，
 * 所以整条用例落成 error，并把中止原因追加进证据；已经完成的尝试仍然原样保留。
 *
 * @param {import('../types.mjs').TestCase} testCase
 * @param {{ status: import('../types.mjs').RunStatus | null, attempts: import('./retry.mjs').InternalAttempt[], aborted: boolean }} outcome
 * @param {RunBudget} budget
 * @returns {import('../types.mjs').RunResult}
 */
function toRunResult(testCase, outcome, budget) {
  const evidence = pickEvidence(outcome);

  /** @type {import('../types.mjs').RunResult} */
  const result = {
    caseId: testCase.id,
    status: outcome.aborted ? 'error' : outcome.status ?? 'error',
    attempts: toContractAttempts(outcome.attempts),
    evidence,
  };

  if (outcome.aborted) {
    result.aborted = true;
    result.evidence = {
      ...evidence,
      actual: `${evidence.actual}\n预算中止：${budget.abortReason ?? '未知原因'}`,
    };
  }

  return result;
}

/**
 * 执行整份计划，返回包含预算元信息的完整报告。
 *
 * @param {import('../types.mjs').TestCase[] | { cases: import('../types.mjs').TestCase[] }} plan
 * @param {{
 *   baseUrl: string,
 *   repeat?: number,
 *   limits?: { maxWallMs?: number, maxCases?: number, maxSteps?: number },
 *   maxAttempts?: number,
 *   output?: { dir?: string },
 *   outputDir?: string,
 *   cwd?: string,
 *   browser?: import('playwright').Browser,
 * }} options
 * @returns {Promise<RunReport>}
 */
export async function runPlanReport(plan, options = {}) {
  const cases = normalizeCases(plan);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const budget = new RunBudget(options.limits);
  const startedAt = Date.now();

  const outputDir = options.output?.dir ?? options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const cwd = options.cwd ?? process.cwd();

  /** @type {import('../types.mjs').RunResult[]} */
  const results = [];
  /** @type {{ caseId: string, reason: string }[]} 单例超步数被跳过的用例，不当成中止 */
  const skipped = [];
  let aborted = false;

  const ownsBrowser = !options.browser;
  /** @type {import('playwright').Browser | undefined} */
  let browser = options.browser;

  try {
    for (const testCase of cases) {
      const decision = budget.beginCase(testCase);
      if (!decision.allowed) {
        // 单例超步数只跳过这一条；总时长 / 用例数耗尽才中止整轮。
        if (decision.skipReason !== null) {
          skipped.push({ caseId: testCase.id, reason: decision.skipReason });
          continue;
        }
        aborted = true;
        break;
      }

      // 懒启动：计划为空或第一条就被预算挡下时，不用白起一个浏览器。
      if (!browser) browser = await launchBrowser();

      const outcome = await runWithRetry(
        testCase,
        (attemptIndex) =>
          runAttempt({
            browser: /** @type {import('playwright').Browser} */ (browser),
            baseUrl,
            testCase,
            attemptIndex,
            budget,
            outputDir,
            cwd,
          }),
        {
          repeat: options.repeat,
          maxAttempts: options.maxAttempts,
          beforeAttempt: () => {
            if (budget.remainingMs() <= 0) {
              budget.abort(
                'maxWallMs',
                `用例 ${testCase.id} 下一次尝试前预算已耗尽`,
              );
              return false;
            }
            return true;
          },
        },
      );

      // 一次都没跑成（例如上一次尝试刚结束时预算耗尽），不给这条用例编结论。
      if (outcome.aborted && outcome.attempts.length === 0) {
        aborted = true;
        break;
      }

      results.push(toRunResult(testCase, outcome, budget));
      budget.endCase();

      if (outcome.aborted) {
        aborted = true;
        break;
      }
    }
  } finally {
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }

  return {
    results,
    aborted: aborted || budget.aborted,
    abortReason: budget.abortReason,
    skipped,
    baseUrl,
    limits: {
      maxWallMs: budget.maxWallMs,
      maxCases: budget.maxCases,
      maxSteps: budget.maxSteps,
    },
    elapsedMs: Date.now() - startedAt,
    budget: budget.snapshot(),
  };
}

/**
 * 执行整份计划：`TestCase[]` → `RunResult[]`。
 *
 * 返回值保持契约要求的数组形状；预算中止的信息以非枚举属性挂在数组上
 * （与 planCases 挂 `dropped` 的做法一致），既不影响 JSON 序列化，也能直接读：
 *
 *   const results = await runPlan(cases, { baseUrl, repeat, limits });
 *   results.aborted;    // boolean
 *   results.abortReason; // string | null
 *   results.skipped;    // { caseId, reason }[]：单例超步数被整条跳过的用例
 *   results.elapsedMs;  // number：整轮耗时
 *   results.budget;     // 预算账本快照（含 stepsRun）
 *   results.baseUrl;    // string：本次实际使用的地址，生成 spec 时要用
 *
 * 单例步数（limits.maxSteps）超限的用例只跳过它自己，不中止整轮，也不会出现在 results 里，
 * 所以读结果时必须看 `skipped`：只数数组长度会以为这条用例凭空消失了。
 * 需要可序列化的完整报告（含预算账本）时用 runPlanReport()。
 *
 * @param {import('../types.mjs').TestCase[] | { cases: import('../types.mjs').TestCase[] }} plan
 * @param {{
 *   baseUrl: string,
 *   repeat?: number,
 *   limits?: { maxWallMs?: number, maxCases?: number, maxSteps?: number },
 *   maxAttempts?: number,
 *   output?: { dir?: string },
 *   outputDir?: string,
 *   cwd?: string,
 *   browser?: import('playwright').Browser,
 * }} options
 * @returns {Promise<import('../types.mjs').RunResult[] & { aborted: boolean, abortReason: string | null, skipped: { caseId: string, reason: string }[], elapsedMs: number, budget: object, baseUrl: string, limits: object }>}
 */
export async function runPlan(plan, options = {}) {
  const report = await runPlanReport(plan, options);
  const results = report.results;

  // 与 planCases 的 dropped 一致：非枚举，避免污染 JSON 里的 RunResult[]。
  Object.defineProperty(results, 'aborted', {
    value: report.aborted,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(results, 'abortReason', {
    value: report.abortReason,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(results, 'skipped', {
    value: report.skipped,
    enumerable: false,
    configurable: false,
  });
  // 生成 spec / 写报告要用的运行元信息：不挂上去的话调用方只能再跑一次 runPlanReport。
  for (const name of ['elapsedMs', 'budget', 'baseUrl', 'limits']) {
    Object.defineProperty(results, name, {
      value: report[name],
      enumerable: false,
      configurable: false,
    });
  }

  return /** @type {import('../types.mjs').RunResult[] & { aborted: boolean, abortReason: string | null, skipped: { caseId: string, reason: string }[], elapsedMs: number, budget: object, baseUrl: string, limits: object }} */ (
    results
  );
}
