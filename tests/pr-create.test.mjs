/**
 * @file src/pr/create.mjs 里不碰 git 的那部分：runId、分支名、标题、PR 正文。
 *
 * 「提 PR」这个动作本身没法在单测里真跑，但最容易出错的是拼装：分支名带非法字符、
 * 标题少了条数、正文漏掉未覆盖原因或失败证据。这些是纯函数，钉住它们比事后看 PR 便宜得多。
 */

import { expect, test } from '@playwright/test';

import {
  branchNameFor,
  buildPullRequestBody,
  buildTitle,
  createRunId,
  PrError,
} from '../src/pr/create.mjs';

test('runId 来自时间戳，固定可复现', () => {
  expect(createRunId(new Date('2026-11-01T09:25:30.000Z'))).toBe('20261101T092530');
});

test('分支名是 autotest/<runId>', () => {
  expect(branchNameFor('20261101T092530')).toBe('autotest/20261101T092530');
});

test('非法 runId 不进 git 引用', () => {
  expect(() => branchNameFor('')).toThrow(PrError);
  expect(() => branchNameFor('a/b')).toThrow(PrError);
  expect(() => branchNameFor('a b')).toThrow(PrError);
  expect(() => branchNameFor('a..b')).toThrow(PrError);
});

test('标题格式：test: 给 <模块> 补 <N> 条用例', () => {
  expect(buildTitle([{ module: 'login', caseIds: ['a', 'b'] }])).toBe('test: 给 login 补 2 条用例');
  expect(
    buildTitle([
      { module: 'login', caseIds: ['a'] },
      { module: 'cart', caseIds: ['b'] },
    ]),
  ).toBe('test: 给 login、cart 补 2 条用例');
  expect(
    buildTitle([
      { module: 'login', caseIds: ['a'] },
      { module: 'cart', caseIds: ['b'] },
      { module: 'todo', caseIds: ['c'] },
    ]),
  ).toBe('test: 给 login 等 3 个模块 补 3 条用例');
});

test('PR 正文包含覆盖清单、未覆盖原因、失败证据', () => {
  const plan = [
    {
      id: 'P0-login-submit',
      title: '提交登录表单',
      priority: 'P0',
      steps: [{ action: 'goto', page: '/' }],
      expect: ['登录成功'],
    },
    {
      id: 'P1-todo-add',
      title: '新增待办',
      priority: 'P1',
      steps: [{ action: 'goto', page: '/' }],
      expect: ['列表出现一项'],
    },
  ];
  plan.dropped = ['P2-long-input'];

  const body = buildPullRequestBody({
    plan,
    results: [
      {
        caseId: 'P0-login-submit',
        status: 'failed',
        attempts: [],
        evidence: {
          input: '填 email 后点登录',
          expected: '进入待办页',
          actual: '停留在登录页',
        },
      },
      { caseId: 'P1-todo-add', status: 'passed', attempts: [], evidence: {} },
    ],
    specFiles: [{ module: 'root', file: 'specs/root.spec.mjs', caseIds: ['P1-todo-add'] }],
    reportPath: 'autotest-output/report.md',
    runId: '20261101T092530',
  });

  expect(body).toContain('## 覆盖清单');
  expect(body).toContain('`specs/root.spec.mjs`');
  expect(body).toContain('`P1-todo-add`');
  expect(body).toContain('## 未覆盖及原因');
  expect(body).toContain('P2-long-input');
  expect(body).toContain('## 失败用例证据');
  expect(body).toContain('停留在登录页');
  expect(body).toContain('autotest-output/report.md');
});

test('没有失败时正文明确写「无」，不留空小节', () => {
  const body = buildPullRequestBody({
    plan: [],
    results: [],
    specFiles: [],
    reportPath: 'autotest-output/report.md',
  });

  expect(body).toContain('- 无失败或 flaky 用例。');
  expect(body).toContain('本次没有生成可提交的测试文件');
});
