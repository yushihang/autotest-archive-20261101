/**
 * @file 共享契约 src/types.mjs 的检查。
 *
 * 契约只有类型，能自动检查的只有运行时导出的那几组常量，
 * 而它们正是各模块做校验时会依赖的东西，所以值得钉住。
 */

import { expect, test } from '@playwright/test';

import {
  ATTEMPT_STATUSES,
  ELEMENT_KINDS,
  PRIORITIES,
  RUN_STATUSES,
  STEP_ACTIONS,
  WAIT_STATES,
} from '../src/types.mjs';

test('单次 attempt 的结论里没有 flaky', () => {
  // flaky 是多次尝试汇总出来的结论，不属于任何一次尝试。
  expect(ATTEMPT_STATUSES).not.toContain('flaky');
  expect(ATTEMPT_STATUSES).toEqual(['passed', 'failed', 'error']);
});

test('ATTEMPT_STATUSES 就是 RUN_STATUSES 去掉 flaky', () => {
  expect(RUN_STATUSES.filter((status) => !ATTEMPT_STATUSES.includes(status))).toEqual(['flaky']);
});

test("waitFor 步骤的等待条件有明确取值", () => {
  expect(STEP_ACTIONS).toContain('waitFor');
  expect(WAIT_STATES).toEqual(['visible', 'hidden', 'url', 'networkidle']);
});

test('契约常量在运行时不可改', () => {
  for (const values of [PRIORITIES, RUN_STATUSES, ATTEMPT_STATUSES, STEP_ACTIONS, WAIT_STATES, ELEMENT_KINDS]) {
    expect(Object.isFrozen(values)).toBe(true);
  }
});
