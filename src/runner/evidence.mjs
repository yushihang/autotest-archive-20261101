/**
 * @file 失败证据：把「工具看到的」摆整齐，让人自己判断责任。
 *
 * 「工具发现的失败 ≠ 业务有 bug」。一次红色可能来自三条路：真有 bug、用例写错、
 * 环境不对。执行器不做判断，只负责把可复核的东西留下来：
 *
 *   input        实际填了什么、点了哪个元素
 *   expected     规划阶段写下的期望（原文，不翻译）
 *   actual       实际发生了什么（失败步骤、页面地址、HTTP 状态、console / 未捕获异常）
 *   minimalRepro 复现到失败为止的最小步骤序列
 *   screenshot   失败现场截图，落在 <output.dir>/artifacts/
 *
 * 截图只存相对路径（相对 output.dir），报告换机器也能读；绝对路径写进去等于把
 * 本机目录结构钉死在产物里。
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 截图目录名，固定为 `<output.dir>/artifacts/`。 */
export const ARTIFACTS_DIRNAME = 'artifacts';

/** 每类 console / 页面错误最多留多少条：证据要够用，不能把内存吃穿。 */
export const MAX_RECORDED_ERRORS = 20;

/**
 * 把任意异常压成带栈的字符串。Attempt.error 是字符串契约，栈必须留在这里，
 * 否则失败只剩一句「Timeout」，根本没法查。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;

  const candidate = /** @type {{ message?: unknown, stack?: unknown }} */ (error);
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  const stack = typeof candidate.stack === 'string' ? candidate.stack : '';

  // Playwright 的 stack 通常已经包含 message；别把同一句话写两遍。
  if (stack === '') return message;
  if (stack.includes(message)) return stack;
  return `${message}\n${stack}`;
}

/**
 * 把一步翻译成人能照着复现的文字。
 * @param {import('../types.mjs').TestStep} step
 * @returns {string}
 */
export function describeStep(step) {
  if (!step || typeof step !== 'object') return '(无效步骤)';

  const target = typeof step.target === 'string' && step.target !== '' ? step.target : '(缺少 target)';
  const value = typeof step.value === 'string' ? step.value : '';

  switch (step.action) {
    case 'goto':
      return `打开 ${step.page ?? '/'}`;
    case 'click':
      return `点击 ${target}`;
    case 'fill':
      return `在 ${target} 填入 ${JSON.stringify(value)}`;
    case 'press':
      return `在 ${target} 按 ${value === '' ? '(缺少按键)' : value}`;
    case 'select':
      return `在 ${target} 选择 ${JSON.stringify(value)}`;
    case 'check':
      return `勾选 ${target}`;
    case 'uncheck':
      return `取消勾选 ${target}`;
    case 'waitFor': {
      const state = step.waitState ?? 'visible';
      const extra =
        state === 'url'
          ? ` ${value}`
          : step.target
            ? ` ${step.target}`
            : '';
      return `等待 ${state}${extra}`;
    }
    default:
      return `${step.action ?? '(缺少 action)'} ${target}`.trim();
  }
}

/**
 * @param {import('../types.mjs').TestStep[]} steps
 * @returns {string[]}
 */
export function describeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => describeStep(step));
}

/**
 * 失败的步骤要连「第几步、做什么、原始错误栈」一起说清楚。
 * @param {number} stepIndex 从 0 开始
 * @param {import('../types.mjs').TestStep} step
 * @param {unknown} cause
 * @returns {string}
 */
export function describeStepFailure(stepIndex, step, cause) {
  return `第 ${stepIndex + 1} 步（${describeStep(step)}）失败：${formatError(cause)}`;
}

/**
 * 给页面装上证据采集器。console.error、未捕获异常、主框架 4xx/5xx 各记一份，
 * 都带条数上限；返回的数组是实时引用，随时可以读。
 *
 * console.error 只进证据、不直接判失败——浏览器会把资源 404、第三方脚本告警都记成 error，
 * 拿它当断言会产生大量假红。未捕获异常和导航 4xx/5xx 才是执行器认可的失败信号。
 *
 * @param {import('playwright').Page} page
 * @param {{ limit?: number }} [options]
 * @returns {{ consoleErrors: string[], pageErrors: string[], navigationErrors: string[] }}
 */
export function attachConsoleRecorder(page, options = {}) {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : MAX_RECORDED_ERRORS;

  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string[]} */
  const navigationErrors = [];

  page.on('console', (message) => {
    if (message.type() !== 'error' || consoleErrors.length >= limit) return;
    const location = message.location?.() ?? {};
    const where =
      typeof location.url === 'string' && location.url !== ''
        ? ` (${location.url}${typeof location.lineNumber === 'number' ? `:${location.lineNumber}` : ''})`
        : '';
    consoleErrors.push(`${message.text()}${where}`);
  });

  page.on('pageerror', (error) => {
    if (pageErrors.length < limit) pageErrors.push(formatError(error));
  });

  page.on('response', (response) => {
    if (navigationErrors.length >= limit) return;

    const request = response.request();
    if (!request.isNavigationRequest()) return;
    if (response.status() < 400) return;

    // 子 iframe 的 4xx 不代表主流程失败；只记主框架的导航。
    let frame;
    try {
      frame = request.frame();
    } catch {
      return;
    }
    if (frame !== page.mainFrame()) return;
    navigationErrors.push(`${response.status()} ${response.url()}`);
  });

  return { consoleErrors, pageErrors, navigationErrors };
}

/**
 * @param {unknown} caseId
 * @returns {string}
 */
function safeFileName(caseId) {
  const raw = typeof caseId === 'string' ? caseId : String(caseId ?? '');
  const safe = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return safe === '' ? 'case' : safe.slice(0, 80);
}

/**
 * 截图文件名：用例 id + 第几次尝试 + 时间戳。时间戳避免同一用例重跑后互相覆盖。
 * @param {string} caseId
 * @param {number} [attemptIndex] 从 0 开始
 * @param {Date} [now]
 * @returns {string}
 */
export function artifactFileName(caseId, attemptIndex = 0, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${safeFileName(caseId)}-attempt-${attemptIndex + 1}-${stamp}.png`;
}

/**
 * 在页面还活着的时候截图，落到 `<output.dir>/artifacts/`。
 *
 * 返回相对 output.dir 的路径（`artifacts/xxx.png`），而不是绝对路径；
 * 截图失败直接抛给调用方，由执行器决定是否吞掉——证据不完整不该反过来把执行搞崩。
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   outputDir?: string,
 *   cwd?: string,
 *   caseId: string,
 *   attemptIndex?: number,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<string>}
 */
export async function captureScreenshot(page, options) {
  const outputDir = options.outputDir ?? 'autotest-output';
  const cwd = options.cwd ?? process.cwd();
  const attemptIndex = options.attemptIndex ?? 0;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : 5_000;

  const artifactDir = resolve(cwd, outputDir, ARTIFACTS_DIRNAME);
  await mkdir(artifactDir, { recursive: true });

  const fileName = artifactFileName(options.caseId, attemptIndex);
  await page.screenshot({
    path: join(artifactDir, fileName),
    fullPage: true,
    timeout: timeoutMs,
  });

  // evidence.screenshot 的契约是「相对 output.dir」，统一用 /，不跟着平台变。
  return `${ARTIFACTS_DIRNAME}/${fileName}`;
}

/**
 * @typedef {object} EvidenceInput
 * @property {import('../types.mjs').TestCase} testCase
 * @property {number} attemptIndex
 * @property {{ message: string, stepIndex: number | null, kind: string } | null} failure
 * @property {import('../types.mjs').TestStep[]} attemptedSteps 已经尝试过的步骤（含失败那一步）
 * @property {string[]} [consoleErrors]
 * @property {string[]} [pageErrors]
 * @property {string[]} [navigationErrors]
 * @property {string} [screenshot]
 * @property {string} [pageUrl]
 */

/**
 * 组装一次尝试的证据。passed 与 failed 都要填：通过时也要写清「测了什么、看到了什么」，
 * 否则报告里只剩一个绿色的字，没法复核。
 *
 * @param {EvidenceInput} input
 * @returns {import('../types.mjs').Evidence}
 */
export function buildEvidence(input) {
  const {
    testCase,
    failure,
    attemptedSteps,
    consoleErrors = [],
    pageErrors = [],
    navigationErrors = [],
    screenshot,
    pageUrl,
  } = input;

  const steps = describeSteps(attemptedSteps);
  const expected = Array.isArray(testCase.expect) ? testCase.expect.join('；') : '';

  /** @type {string[]} */
  const actualParts = [];
  if (failure) {
    actualParts.push(failure.message);
  } else {
    actualParts.push(
      `全部 ${steps.length} 步执行成功${pageUrl ? `，最终地址 ${pageUrl}` : ''}`,
    );
  }

  if (failure && pageUrl) actualParts.push(`出错时页面地址：${pageUrl}`);
  if (pageErrors.length > 0) {
    actualParts.push(`未捕获异常 ${pageErrors.length} 处：${pageErrors[0]}`);
  }
  if (navigationErrors.length > 0) {
    actualParts.push(`主框架导航错误：${navigationErrors.join('；')}`);
  }
  if (consoleErrors.length > 0) {
    actualParts.push(`控制台错误 ${consoleErrors.length} 条：${consoleErrors[0]}`);
  }

  /** @type {import('../types.mjs').Evidence} */
  const evidence = {
    input: steps.length > 0 ? steps.join('；') : '（未执行任何步骤）',
    expected,
    actual: actualParts.join('\n'),
    minimalRepro: steps,
  };

  if (screenshot) evidence.screenshot = screenshot;
  // 契约里没有 consoleErrors 字段，但「抓取 console 错误」必须落到产物里；
  // 按「字段只增不改」的规则新开一个可选字段，不改旧字段语义。
  if (consoleErrors.length > 0) evidence.consoleErrors = consoleErrors.slice();

  return evidence;
}
