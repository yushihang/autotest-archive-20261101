/**
 * @file Markdown 报告：一次运行 → 人能读的 `<output.dir>/report.md`。
 *
 * 报告的读者是 reviewer，不是机器。所以固定回答五个问题：
 *
 *   1. 覆盖了哪些行为点（按 P0 / P1 / P2 排）；
 *   2. 哪些没覆盖、为什么（unstable 元素、超出 maxCases、执行阶段跳过、没有结果）；
 *   3. 失败用例的证据（输入 / 期望 / 实际 / 最小复现 / 截图 / console 错误）；
 *   4. flaky 单独归类，不混进失败结论；
 *   5. 这次花了多少时间、多少步。
 *
 * 「工具发现的失败 ≠ 业务有 bug」是这份报告的立场：只陈述看到了什么，不下责任判断。
 * 同输入渲染出的 Markdown 逐字节一致——不写当前时间、不遍历无序集合。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_OUTPUT_DIR } from '../config.mjs';
import { planMetaOf, runMetaOf } from '../views.mjs';

/** 报告文件名（相对 output.dir）。 */
export const REPORT_FILENAME = 'report.md';

/** 优先级展示顺序。数组顺序就是报告里的顺序。 */
const PRIORITY_ORDER = Object.freeze(['P0', 'P1', 'P2']);

const STATUS_LABEL = Object.freeze({
  passed: '✅ 通过',
  failed: '❌ 失败',
  flaky: '⚠️ flaky',
  error: '⛔ 错误',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 表格单元格里的单行文本：换行会拆行，竖线会拆列。
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  const flat = text(value).replace(/\s*\r?\n\s*/g, ' ').trim();
  return flat === '' ? '—' : flat.replace(/\|/g, '\\|');
}

/**
 * 行内代码。内容里有反引号时用双反引号包，避免把 Markdown 拆坏。
 * @param {unknown} value
 * @returns {string}
 */
function code(value) {
  const flat = text(value).replace(/\s*\r?\n\s*/g, ' ').trim();
  if (flat === '') return '—';
  const ticks = flat.includes('`') ? '``' : '`';
  return `${ticks}${flat}${ticks}`;
}

/**
 * 多行文本用 `~~~` 围栏（正文里不会出现波浪线围栏，不会被 ``` 冲突拆坏）。
 * @param {unknown} value
 * @returns {string}
 */
function fenced(value) {
  const body = text(value).replace(/\r\n/g, '\n').trimEnd();
  return body === '' ? '—' : `~~~text\n${body}\n~~~`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function bullet(value) {
  const flat = text(value).replace(/\s*\r?\n\s*/g, ' ').trim();
  return flat === '' ? '—' : flat;
}

/**
 * 毫秒 → 人读的时长，同时保留原始数字，避免「1.2s」掩盖精度。
 * @param {number | null} ms
 * @returns {string}
 */
function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未记录';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s（${ms} ms）`;
}

/**
 * 本次耗时的人读文本。没有结果也没有账本时诚实写「未记录」，不拿 0 冒充。
 * @param {ReturnType<typeof runMetaOf>} run
 * @returns {string}
 */
function elapsedText(run) {
  if (run.elapsedSource === 'none') return '未记录';
  const suffix = run.elapsedSource === 'attempts' ? '（各次尝试耗时累加）' : '';
  return `${duration(run.elapsedMs)}${suffix}`;
}

/**
 * @param {unknown} status
 * @returns {string}
 */
function statusLabel(status) {
  return STATUS_LABEL[status] ?? '⏭ 未执行';
}

/**
 * 计划里的用例 id → 用例，保持计划顺序。
 * @param {import('../types.mjs').TestCase[]} cases
 * @returns {Map<string, import('../types.mjs').TestCase>}
 */
function caseById(cases) {
  const map = new Map();
  for (const testCase of cases) {
    if (typeof testCase?.id !== 'string' || map.has(testCase.id)) continue;
    map.set(testCase.id, testCase);
  }
  return map;
}

/**
 * 执行结果按 caseId 汇总，同一 id 出现多次时以最后一条为准。
 * @param {import('../types.mjs').RunResult[]} results
 * @returns {Map<string, import('../types.mjs').RunResult>}
 */
function resultById(results) {
  const map = new Map();
  for (const result of results) {
    if (typeof result.caseId !== 'string') continue;
    map.set(result.caseId, result);
  }
  return map;
}

/**
 * 「期望」是写给人看的句子，用分号连成一行；空数组时明确标出来。
 * @param {import('../types.mjs').TestCase | undefined} testCase
 * @returns {string}
 */
function expectText(testCase) {
  const list = Array.isArray(testCase?.expect) ? testCase.expect.filter(Boolean) : [];
  return list.length === 0 ? '（规划没有给出期望）' : list.join('；');
}

/**
 * 没有 evidence 时的兜底复现步骤：直接列 TestCase.steps。
 * @param {import('../types.mjs').TestCase | undefined} testCase
 * @returns {string[]}
 */
function stepsOf(testCase) {
  const steps = Array.isArray(testCase?.steps) ? testCase.steps : [];
  return steps.map((step) => {
    const target = step?.target ?? '';
    const value = typeof step?.value === 'string' ? ` ${JSON.stringify(step.value)}` : '';
    switch (step?.action) {
      case 'goto':
        return `打开 ${step.page ?? '/'}`;
      case 'click':
        return `点击 ${target}`;
      case 'fill':
        return `在 ${target} 填入${value}`;
      case 'press':
        return `在 ${target} 按 ${step.value ?? ''}`;
      case 'select':
        return `在 ${target} 选择${value}`;
      case 'check':
        return `勾选 ${target}`;
      case 'uncheck':
        return `取消勾选 ${target}`;
      case 'waitFor':
        return `等待 ${target || step.value || ''}（${step.waitState ?? 'visible'}）`;
      default:
        return `${step?.action ?? '未知动作'} ${target}`.trim();
    }
  });
}

/**
 * 一次尝试的紧凑描述：`passed 120ms` / `failed 80ms`。
 * @param {import('../types.mjs').Attempt} attempt
 * @returns {string}
 */
function attemptSummary(attempt) {
  const label = STATUS_LABEL[attempt?.status] ?? '未知';
  return `${label} ${duration(attempt?.durationMs).replace(/（.*）$/, '')}`;
}

/**
 * 失败 / flaky 的证据块。三个阶段共用，避免「失败有证据、flaky 没证据」。
 *
 * @param {{
 *   testCase?: import('../types.mjs').TestCase,
 *   result: import('../types.mjs').RunResult,
 * }} input
 * @returns {string[]}
 */
function evidenceBlock({ testCase, result }) {
  const evidence = result.evidence ?? {};
  const lines = [];

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const timeline = attempts.map(attemptSummary).join(' → ');
  lines.push(
    `- **结论**：${statusLabel(result.status)}${timeline ? `（${attempts.length} 次尝试：${timeline}）` : ''}${
      result.aborted ? '；预算中止，未跑完全部尝试' : ''
    }`,
  );
  lines.push(`- **输入**：${bullet(evidence.input)}`);
  lines.push(`- **期望**：${bullet(evidence.expected || expectText(testCase))}`);
  lines.push(`- **实际**：`);
  lines.push('');
  const actualBlock = fenced(evidence.actual)
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');
  lines.push(actualBlock);
  lines.push('');

  const repro =
    Array.isArray(evidence.minimalRepro) && evidence.minimalRepro.length > 0
      ? evidence.minimalRepro
      : stepsOf(testCase);
  if (repro.length > 0) {
    lines.push('- **最小复现步骤**：');
    repro.forEach((step, index) => lines.push(`  ${index + 1}. ${cell(step)}`));
  } else {
    lines.push('- **最小复现步骤**：未记录');
  }

  if (typeof evidence.screenshot === 'string' && evidence.screenshot !== '') {
    lines.push(`- **截图**：${code(evidence.screenshot)}`);
  } else {
    lines.push('- **截图**：未留下');
  }

  if (Array.isArray(evidence.consoleErrors) && evidence.consoleErrors.length > 0) {
    lines.push('- **页面 console 错误**：');
    lines.push('');
    const consoleBlock = fenced(evidence.consoleErrors.join('\n\n'))
      .split('\n')
      .map((line) => (line === '' ? '' : `  ${line}`))
      .join('\n');
    lines.push(consoleBlock);
    lines.push('');
  }

  if (attempts.length > 0) {
    lines.push('- **重跑明细**：');
    lines.push('');
    lines.push('  | # | 结论 | 耗时 | 错误 |');
    lines.push('  | --- | --- | --- | --- |');
    for (const attempt of attempts) {
      lines.push(
        `  | ${attempt.index} | ${statusLabel(attempt.status)} | ${duration(attempt.durationMs)} | ${cell(attempt.error)} |`,
      );
    }
    lines.push('');
  }

  return lines;
}

/**
 * 生成报告正文（不落盘，方便测试直接断言字符串）。
 *
 * @param {ReturnType<typeof planMetaOf>} plan
 * @param {ReturnType<typeof runMetaOf>} run
 * @param {{ startedAt?: string, baseUrl?: string }} [options]
 * @returns {string}
 */
function buildReport(plan, run, options = {}) {
  const byId = caseById(plan.cases);
  const resultsById = resultById(run.results);

  const executedIds = [...resultsById.keys()];
  const counts = { passed: 0, failed: 0, flaky: 0, error: 0 };
  for (const id of executedIds) {
    const status = resultsById.get(id).status;
    if (status in counts) counts[status] += 1;
  }

  const specCases = plan.cases.filter((testCase) => resultsById.get(testCase.id)?.status === 'passed');
  const baseUrl =
    (typeof options.baseUrl === 'string' && options.baseUrl !== '' ? options.baseUrl : null) ??
    run.baseUrl ??
    '未记录';

  /** @type {string[]} */
  const lines = [];
  const push = (...values) => lines.push(...values);

  push('# 自动测试报告');
  push('');
  push('> 本报告由 autotest 依据规划结果与执行结果生成。工具发现的失败不等于业务有 bug：');
  push('> 先看证据（输入 / 期望 / 实际 / 复现步骤），再判断是业务问题、用例问题还是环境问题。');
  push('');

  // ------------------------------------------------------------------ 摘要
  push('## 摘要');
  push('');
  push('| 项目 | 数值 |');
  push('| --- | --- |');
  push(`| 被测地址 | ${code(baseUrl)} |`);
  push(`| 计划用例 | ${plan.total} 条（最终保留 ${plan.cases.length} 条） |`);
  push(`| 实际执行 | ${executedIds.length} 条 |`);
  push(
    `| 结论 | 通过 ${counts.passed} / 失败 ${counts.failed} / flaky ${counts.flaky} / 错误 ${counts.error} |`,
  );
  push(`| 生成的测试代码 | ${specCases.length} 条（只含 passed，见 \`specs/\`） |`);
  push(`| 已覆盖的行为点 | ${specCases.length} 个（其余见「未覆盖的部分及原因」） |`);
  push(`| 执行耗时 | ${elapsedText(run)} |`);
  push(`| 执行步数 | ${run.stepsRun === null ? '未记录' : `${run.stepsRun} 步`} |`);
  push(`| 中止 | ${run.aborted ? `是：${bullet(run.abortReason ?? '预算中止')}` : '否'} |`);
  push('');

  // ------------------------------------------------------- 覆盖的行为点
  push('## 覆盖的行为点（按优先级）');
  push('');
  if (plan.cases.length === 0) {
    push('本次没有规划出任何用例。');
    push('');
  } else {
    /** @type {Map<string, import('../types.mjs').TestCase[]>} */
    const grouped = new Map();
    for (const testCase of plan.cases) {
      const priority = PRIORITY_ORDER.includes(testCase.priority) ? testCase.priority : '其他';
      const group = grouped.get(priority);
      if (group) group.push(testCase);
      else grouped.set(priority, [testCase]);
    }

    const order = [...PRIORITY_ORDER, '其他'].filter((priority) => grouped.has(priority));
    for (const priority of order) {
      const cases = grouped.get(priority);
      push(`### ${priority}（${cases.length} 条）`);
      push('');
      push('| 用例 | 行为点 | 断言 | 结果 |');
      push('| --- | --- | --- | --- |');
      for (const testCase of cases) {
        const result = resultsById.get(testCase.id);
        push(
          `| ${code(testCase.id)} | ${cell(testCase.title)} | ${cell(expectText(testCase))} | ${statusLabel(result?.status)} |`,
        );
      }
      push('');
    }
  }

  // ---------------------------------------------------------- 未覆盖部分
  push('## 未覆盖的部分及原因');
  push('');

  let uncovered = false;

  // 1) unstable 元素
  if (plan.unstable.length > 0) {
    uncovered = true;
    push('### 选择器不稳定的元素（unstable）');
    push('');
    push('这些元素的选择器含自增 id / 随机 hash，规划阶段已降权；降到最低仍不值得测的直接跳过。');
    push('');
    push('| 元素 | 选择器 | 页面 | 原因 |');
    push('| --- | --- | --- | --- |');
    for (const element of plan.unstable) {
      push(
        `| ${cell(element.name ?? '未知元素')} | ${code(element.sourceElement)} | ${cell(element.page)} | ${cell(element.reason ?? '选择器不稳定')} |`,
      );
    }
    push('');
  }

  // 2) 超出 maxCases 被截断
  if (plan.dropped.length > 0) {
    uncovered = true;
    push('### 超出 maxCases 被截断的用例');
    push('');
    push(
      `本次上限 ${plan.maxCases === null ? '未知' : `${plan.maxCases} 条`}，下面 ${plan.dropped.length} 条候选没有进入执行：`,
    );
    push('');
    for (const caseId of plan.dropped) {
      push(`- ${code(caseId)}`);
    }
    push('');
  }

  // 3) 执行阶段跳过的用例（单例超步数）
  if (run.skipped.length > 0) {
    uncovered = true;
    push('### 执行阶段跳过的用例');
    push('');
    for (const entry of run.skipped) {
      push(`- ${code(entry.caseId)}：${bullet(entry.reason)}`);
    }
    push('');
  }

  // 4) 计划内有、但没有执行结果
  const noResult = plan.cases.filter(
    (testCase) =>
      !resultsById.has(testCase.id) && !run.skipped.some((entry) => entry.caseId === testCase.id),
  );
  if (noResult.length > 0) {
    uncovered = true;
    push('### 计划内但没有执行结果的用例');
    push('');
    const reason = run.aborted
      ? `未执行：${bullet(run.abortReason ?? '预算中止')}`
      : '没有执行结果（未执行或结果缺失）';
    for (const testCase of noResult) {
      push(`- ${code(testCase.id)} ${bullet(testCase.title)}：${reason}`);
    }
    push('');
  }

  if (!uncovered) {
    push('没有未覆盖的部分。');
    push('');
  }

  // ---------------------------------------------------------- 失败证据
  push('## 失败用例证据');
  push('');
  const failed = executedIds
    .map((id) => resultsById.get(id))
    .filter((result) => result.status === 'failed' || result.status === 'error');

  if (failed.length === 0) {
    push('本次没有失败用例。');
    push('');
  } else {
    // 先按计划顺序，计划外（有结果没计划）的按执行结果顺序排在后面。
    const ordered = [
      ...plan.cases
        .filter((testCase) => failed.some((result) => result.caseId === testCase.id))
        .map((testCase) => ({ testCase, result: resultsById.get(testCase.id) })),
      ...failed
        .filter((result) => !byId.has(result.caseId))
        .map((result) => ({ testCase: byId.get(result.caseId), result })),
    ];
    for (const { testCase, result } of ordered) {
      push(`### ${code(result.caseId)} ${bullet(testCase?.title)}`);
      push('');
      lines.push(...evidenceBlock({ testCase, result }));
      push('');
    }
  }

  // -------------------------------------------------------------- flaky
  push('## flaky（重跑结论不一致）');
  push('');
  const flaky = executedIds
    .map((id) => resultsById.get(id))
    .filter((result) => result.status === 'flaky');

  if (flaky.length === 0) {
    push('本次没有 flaky 用例。');
    push('');
  } else {
    push('这些用例在重跑中既通过过也失败过，单独归类，不混进失败结论；也不生成测试代码。');
    push('');
    const ordered = [
      ...plan.cases
        .filter((testCase) => flaky.some((result) => result.caseId === testCase.id))
        .map((testCase) => ({ testCase, result: resultsById.get(testCase.id) })),
      ...flaky
        .filter((result) => !byId.has(result.caseId))
        .map((result) => ({ testCase: byId.get(result.caseId), result })),
    ];
    for (const { testCase, result } of ordered) {
      push(`### ${code(result.caseId)} ${bullet(testCase?.title)}`);
      push('');
      lines.push(...evidenceBlock({ testCase, result }));
      push('');
    }
  }

  // -------------------------------------------------------------- 用量
  push('## 本次运行的时间与步数用量');
  push('');
  if (typeof options.startedAt === 'string' && options.startedAt !== '') {
    push(`- 开始时间：${cell(options.startedAt)}`);
    push('');
  }
  push('| 指标 | 数值 |');
  push('| --- | --- |');
  push(`| 总耗时 | ${elapsedText(run)} |`);
  if (run.elapsedSource === 'attempts') {
    push('| 耗时来源 | 各次尝试 durationMs 累加（调用方没传预算账本） |');
  }
  push(`| 执行步数 | ${run.stepsRun === null ? '未记录（需要 runPlanReport 的 budget）' : `${run.stepsRun} 步`} |`);
  push(`| 已开始用例 | ${run.casesStarted === null ? '未记录' : `${run.casesStarted} 条`} |`);
  push(`| 已完成用例 | ${run.casesCompleted === null ? '未记录' : `${run.casesCompleted} 条`} |`);
  push(`| 跳过的用例（超出 maxSteps） | ${run.casesSkipped === null ? '未记录' : `${run.casesSkipped} 条`} |`);
  push(`| 用例数上限 | ${run.limits.maxCases === null ? '未记录' : `${run.limits.maxCases} 条`} |`);
  push(`| 单条用例步数上限 | ${run.limits.maxSteps === null ? '未记录' : `${run.limits.maxSteps} 步`} |`);
  push(`| 总时长上限 | ${run.limits.maxWallMs === null ? '未记录' : duration(run.limits.maxWallMs)} |`);
  push('');
  if (run.aborted) {
    push(`> 本次运行被预算中止：${bullet(run.abortReason ?? '未记录原因')}`);
    push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * 渲染 Markdown 报告并写入 `<output.dir>/report.md`。
 *
 * 返回值就是写入的 Markdown 原文，调用方可以顺手贴进 PR 描述或 stdout。
 * 路径优先级：`options.output.dir` → `options.outputDir` → `options.dir` → 默认产物目录；
 * 相对路径按 `options.cwd`（默认 `process.cwd()`）解析。
 *
 * @param {import('../types.mjs').TestCase[] | { cases: import('../types.mjs').TestCase[], dropped?: string[], total?: number, maxCases?: number, unstable?: unknown[] }} plan
 * @param {import('../types.mjs').RunResult[] | { results: import('../types.mjs').RunResult[] }} results
 * @param {{
 *   output?: { dir?: string },
 *   outputDir?: string,
 *   dir?: string,
 *   cwd?: string,
 *   baseUrl?: string,
 *   startedAt?: string,
 * }} [options]
 * @returns {string} 写入磁盘的 Markdown
 */
export function renderReport(plan, results, options = {}) {
  const planMeta = planMetaOf(plan);
  const run = runMetaOf(results);

  const markdown = buildReport(planMeta, run, options);

  const outputDir =
    options.output?.dir ?? options.outputDir ?? options.dir ?? DEFAULT_OUTPUT_DIR;
  const dir = resolve(options.cwd ?? process.cwd(), outputDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, REPORT_FILENAME), markdown, 'utf8');

  return markdown;
}
