/**
 * @file src/report/markdown 的行为：一次运行 → report.md。
 *
 * 报告是 reviewer 唯一的入口，所以逐节钉住必需信息：
 *   覆盖的行为点（按优先级）、未覆盖及原因、失败证据、flaky 单列、时间与步数用量。
 * 另外钉住「同输入逐字节一致」——报告里不能混进当前时间。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { renderReport } from '../src/report/markdown.mjs';

/**
 * @param {Partial<import('../src/types.mjs').TestCase>} [overrides]
 * @returns {import('../src/types.mjs').TestCase}
 */
function caseOf(overrides = {}) {
  return {
    id: 'P0-login-submit',
    title: '提交登录表单后进入待办页',
    priority: 'P0',
    sourceElement: '#login-submit',
    expect: ['登录成功后页面出现待办输入框'],
    steps: [
      { action: 'goto', page: '/' },
      { action: 'fill', target: '#email', value: 'user@example.com' },
      { action: 'click', target: '#login-submit' },
    ],
    ...overrides,
  };
}

/**
 * @param {string} caseId
 * @param {import('../src/types.mjs').RunStatus} status
 * @param {Partial<import('../src/types.mjs').Evidence>} [evidence]
 * @returns {import('../src/types.mjs').RunResult}
 */
function resultOf(caseId, status, evidence = {}) {
  const attemptStatus = (index) => {
    if (status === 'passed') return 'passed';
    if (status === 'flaky') return index === 0 ? 'failed' : 'passed';
    return status === 'error' ? 'error' : 'failed';
  };

  return {
    caseId,
    status,
    attempts: [
      { index: 0, status: attemptStatus(0), durationMs: 120 },
      { index: 1, status: attemptStatus(1), durationMs: 80 },
    ],
    evidence: {
      input: '打开 /；在 #email 填入 user@example.com；点击 #login-submit',
      expected: '登录成功后页面出现待办输入框',
      actual: status === 'passed' ? '出现了待办输入框' : '页面停在登录页',
      minimalRepro: ['打开 /', '点击 #login-submit'],
      ...evidence,
    },
  };
}

/**
 * 一份覆盖所有分支的输入：通过 / 失败 / flaky / 错误，外加截断、unstable、跳过的用例。
 * @returns {{ plan: any, run: any }}
 */
function fixture() {
  const passed = caseOf();
  const failed = caseOf({ id: 'P1-todo-add', title: '添加待办', priority: 'P1' });
  const flaky = caseOf({ id: 'P1-todo-toggle', title: '勾选待办', priority: 'P1' });
  const error = caseOf({ id: 'P2-todo-delete', title: '删除待办', priority: 'P2' });

  const plan = {
    cases: [passed, failed, flaky, error],
    dropped: ['P2-docs-link'],
    total: 5,
    maxCases: 4,
    unstable: [
      {
        sourceElement: '#todo-1-toggle',
        page: '/',
        name: '第一条待办',
        reason: '选择器含自增 id / 随机 hash，不稳定',
      },
    ],
  };

  const run = {
    results: [
      resultOf(passed.id, 'passed'),
      resultOf(failed.id, 'failed', {
        screenshot: 'artifacts/P1-todo-add-attempt-0.png',
        consoleErrors: ['TypeError: cannot read properties of null (reading "value")'],
      }),
      resultOf(flaky.id, 'flaky'),
      resultOf(error.id, 'error'),
    ],
    aborted: false,
    abortReason: null,
    skipped: [
      { caseId: 'P1-skipped', reason: '用例有 13 步，超过单例上限 12 步，整条不执行' },
    ],
    limits: { maxWallMs: 60_000, maxCases: 4, maxSteps: 12 },
    elapsedMs: 4321,
    budget: {
      maxWallMs: 60_000,
      maxCases: 4,
      maxSteps: 12,
      elapsedMs: 4321,
      casesStarted: 4,
      casesCompleted: 4,
      casesSkipped: 1,
      stepsRun: 17,
    },
    baseUrl: 'http://127.0.0.1:4173',
  };

  return { plan, run };
}

/**
 * @param {(dir: string) => void} run
 */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'autotest-report-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('报告写到 output.dir/report.md，并返回同一份 Markdown', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    const file = join(dir, 'report.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(markdown);
    expect(markdown.endsWith('\n')).toBe(true);
  });
});

test('覆盖的行为点按优先级分组', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    expect(markdown).toContain('## 覆盖的行为点（按优先级）');
    expect(markdown).toContain('### P0（1 条）');
    expect(markdown).toContain('### P1（2 条）');
    expect(markdown).toContain('### P2（1 条）');
    expect(markdown).toContain('提交登录表单后进入待办页');
    // P0 段必须出现在 P1 段前面
    expect(markdown.indexOf('### P0')).toBeLessThan(markdown.indexOf('### P1'));
  });
});

test('未覆盖的部分写清 unstable、maxCases 截断与执行跳过', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    expect(markdown).toContain('## 未覆盖的部分及原因');
    expect(markdown).toContain('选择器不稳定的元素（unstable）');
    expect(markdown).toContain('#todo-1-toggle');
    expect(markdown).toContain('超出 maxCases 被截断的用例');
    expect(markdown).toContain('P2-docs-link');
    expect(markdown).toContain('本次上限 4 条');
    expect(markdown).toContain('执行阶段跳过的用例');
    expect(markdown).toContain('P1-skipped');
  });
});

test('失败证据包含 input / expected / actual / 复现步骤 / 截图', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    expect(markdown).toContain('## 失败用例证据');
    expect(markdown).toContain('P1-todo-add');
    expect(markdown).toContain('打开 /；在 #email 填入 user@example.com；点击 #login-submit');
    expect(markdown).toContain('登录成功后页面出现待办输入框');
    expect(markdown).toContain('页面停在登录页');
    expect(markdown).toContain('最小复现步骤');
    expect(markdown).toContain('artifacts/P1-todo-add-attempt-0.png');
    expect(markdown).toContain('TypeError: cannot read properties of null');
  });
});

test('flaky 单独一节，不混进失败用例', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    expect(markdown).toContain('## flaky（重跑结论不一致）');
    const flakySection = markdown.slice(markdown.indexOf('## flaky'));
    const failedSection = markdown.slice(
      markdown.indexOf('## 失败用例证据'),
      markdown.indexOf('## flaky'),
    );

    expect(flakySection).toContain('P1-todo-toggle');
    expect(failedSection).not.toContain('P1-todo-toggle');
  });
});

test('用量一节包含耗时、步数与预算上限', () => {
  withTempDir((dir) => {
    const { plan, run } = fixture();
    const markdown = renderReport(plan, run, { outputDir: dir });

    expect(markdown).toContain('## 本次运行的时间与步数用量');
    expect(markdown).toContain('4.3s（4321 ms）');
    expect(markdown).toContain('17 步');
    expect(markdown).toContain('12 步');
    expect(markdown).toContain('4 条');
  });
});

test('同输入两次渲染逐字节一致，且不写生成时间', () => {
  withTempDir((first) => {
    withTempDir((second) => {
      const left = renderReport(fixture().plan, fixture().run, { outputDir: first });
      const right = renderReport(fixture().plan, fixture().run, { outputDir: second });

      expect(left).toBe(right);
      // 报告里不能混进生成时间这类每次都变的字段（ISO 时间戳一出现就说明不可复现）。
      expect(left).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });
});

test('没有预算账本时如实写「未记录」，不编造步数', () => {
  withTempDir((dir) => {
    const passed = caseOf();
    // 裸的 RunResult[] 字面量：没有 limits / budget / elapsedMs，只有 attempt 的 durationMs。
    // 注意这不是 runPlan() 的返回——后者会把元信息挂成数组的非枚举属性，见下一条。
    const markdown = renderReport([passed], [resultOf(passed.id, 'passed')], { outputDir: dir });

    expect(markdown).toContain('未记录（需要 runPlanReport 的 budget）');
    expect(markdown).toContain('200 ms（各次尝试耗时累加）');
  });
});

test('runPlan() 的返回形状：RunResult[] 上的非枚举元信息不能丢', () => {
  withTempDir((dir) => {
    const passed = caseOf();
    const skippedCase = caseOf({
      id: 'P1-too-many-steps',
      title: '步骤数超过单例上限',
      priority: 'P1',
    });

    // 与 runPlan() 一致：元信息挂在数组的非枚举属性上，JSON 序列化看不到，但报告必须读得到。
    const results = [resultOf(passed.id, 'passed')];
    Object.defineProperties(results, {
      aborted: { value: false, enumerable: false },
      abortReason: { value: null, enumerable: false },
      skipped: {
        value: [{ caseId: skippedCase.id, reason: '用例有 13 步，超过单例上限 12 步，整条不执行' }],
        enumerable: false,
      },
      elapsedMs: { value: 1500, enumerable: false },
      budget: {
        value: {
          maxWallMs: 60_000,
          maxCases: 10,
          maxSteps: 12,
          elapsedMs: 1500,
          casesStarted: 1,
          casesCompleted: 1,
          casesSkipped: 1,
          stepsRun: 3,
        },
        enumerable: false,
      },
      limits: { value: { maxWallMs: 60_000, maxCases: 10, maxSteps: 12 }, enumerable: false },
      baseUrl: { value: 'http://127.0.0.1:4100', enumerable: false },
    });

    const markdown = renderReport([passed, skippedCase], results, { outputDir: dir });

    // 被测地址来自 results.baseUrl，而不是「未记录」。
    expect(markdown).toContain('| 被测地址 | `http://127.0.0.1:4100` |');
    // 耗时 / 步数来自 elapsedMs / budget。
    expect(markdown).toContain('1.5s（1500 ms）');
    expect(markdown).toContain('3 步');
    // 被跳过的用例走「执行阶段跳过」，而不是被当成没有结果的用例。
    expect(markdown).toContain('### 执行阶段跳过的用例');
    expect(markdown).toContain('P1-too-many-steps');
    expect(markdown).toContain('超过单例上限 12 步');
    expect(markdown).not.toContain('没有执行结果（未执行或结果缺失）');
  });
});

test('aborted 的非枚举属性要显示真实的中止原因', () => {
  withTempDir((dir) => {
    const passed = caseOf();
    const pending = caseOf({ id: 'P1-pending', title: '还没执行的用例', priority: 'P1' });

    const results = [resultOf(passed.id, 'passed')];
    Object.defineProperties(results, {
      aborted: { value: true, enumerable: false },
      abortReason: { value: '超出 maxWallMs 预算（60000 ms）', enumerable: false },
      skipped: { value: [], enumerable: false },
      elapsedMs: { value: 60_100, enumerable: false },
      budget: {
        value: {
          maxWallMs: 60_000,
          maxCases: 10,
          maxSteps: 12,
          elapsedMs: 60_100,
          casesStarted: 1,
          casesCompleted: 1,
          casesSkipped: 0,
          stepsRun: 3,
        },
        enumerable: false,
      },
      limits: { value: { maxWallMs: 60_000, maxCases: 10, maxSteps: 12 }, enumerable: false },
      baseUrl: { value: 'http://127.0.0.1:4100', enumerable: false },
    });

    const markdown = renderReport([passed, pending], results, { outputDir: dir });

    expect(markdown).toContain('是：超出 maxWallMs 预算（60000 ms）');
    expect(markdown).toContain('未执行：超出 maxWallMs 预算（60000 ms）');
  });
});
