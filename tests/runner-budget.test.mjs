/**
 * @file src/runner/budget（执行预算）的行为。
 *
 * 钉住三件事：
 *   1. maxSteps 是「单条用例」的上限：超限只跳过这条用例，不中止整轮；
 *   2. maxWallMs / maxCases 是整轮上限：到顶即中止，并如实报告原因；
 *   3. 被跳过的用例不计入 casesStarted / casesCompleted，账本对得上。
 */

import { expect, test } from '@playwright/test';

import { RunBudget } from '../src/runner/budget.mjs';
import { runPlanReport } from '../src/runner/index.mjs';

/**
 * 造一条最小可用的 TestCase，只关心步数。
 * @param {string} id
 * @param {number} steps
 * @returns {import('../src/types.mjs').TestCase}
 */
function caseOf(id, steps) {
  return {
    id,
    title: id,
    priority: 'P1',
    sourceElement: 'role=button[name="提交"]',
    expect: ['提交后页面显示成功'],
    steps: Array.from({ length: steps }, () => ({
      action: 'click',
      target: 'role=button[name="提交"]',
    })),
  };
}

test('maxSteps 超限只跳过该用例，不中止整轮', () => {
  const budget = new RunBudget({ maxWallMs: 60_000, maxCases: 10, maxSteps: 3 });

  expect(budget.beginCase(caseOf('ok-1', 3))).toEqual({ allowed: true, skipReason: null });

  const decision = budget.beginCase(caseOf('too-long', 4));
  expect(decision.allowed).toBe(false);
  expect(decision.skipReason).toContain('超过单例上限 3 步');

  // 关键：这是一条用例自己的问题，不是整轮中止的条件。
  expect(budget.aborted).toBe(false);
  expect(budget.abortReason).toBeNull();

  // 后面的用例照常开跑，账本里只多一条 skipped。
  expect(budget.beginCase(caseOf('ok-2', 1)).allowed).toBe(true);
  const snapshot = budget.snapshot();
  expect(snapshot.casesSkipped).toBe(1);
  expect(snapshot.casesStarted).toBe(2);
});

test('maxCases 到顶仍然中止整轮', () => {
  const budget = new RunBudget({ maxWallMs: 60_000, maxCases: 1, maxSteps: 5 });

  expect(budget.beginCase(caseOf('a', 1)).allowed).toBe(true);

  expect(budget.beginCase(caseOf('b', 1))).toEqual({ allowed: false, skipReason: null });
  expect(budget.aborted).toBe(true);
  expect(budget.abortLimit).toBe('maxCases');
  expect(budget.abortReason).toContain('用例数上限 1 条已用尽');
  expect(budget.snapshot().casesSkipped).toBe(0);
});

test('总时长耗尽时中止，并且不会被当成「跳过」', () => {
  let now = 0;
  const budget = new RunBudget(
    { maxWallMs: 1000, maxCases: 5, maxSteps: 5 },
    { now: () => now },
  );

  expect(budget.beginCase(caseOf('a', 1)).allowed).toBe(true);

  now = 1000;
  expect(budget.beginCase(caseOf('b', 1))).toEqual({ allowed: false, skipReason: null });
  expect(budget.aborted).toBe(true);
  expect(budget.abortLimit).toBe('maxWallMs');
});

test('全部用例都超步数时，报告记为 skipped 而不是 aborted', async () => {
  // 一条都开不了跑，所以不会启动浏览器：这是能在单元测试里跑通的整轮路径。
  const report = await runPlanReport([caseOf('long-1', 3), caseOf('long-2', 2)], {
    baseUrl: 'http://127.0.0.1:4173',
    limits: { maxWallMs: 60_000, maxCases: 5, maxSteps: 1 },
  });

  expect(report.aborted).toBe(false);
  expect(report.abortReason).toBeNull();
  expect(report.results).toEqual([]);
  expect(report.skipped.map((item) => item.caseId)).toEqual(['long-1', 'long-2']);
  expect(report.budget.casesSkipped).toBe(2);
  expect(report.budget.casesStarted).toBe(0);
});
