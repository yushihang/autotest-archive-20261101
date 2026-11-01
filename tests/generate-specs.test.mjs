/**
 * @file src/generate 的行为：通过的用例 → Playwright spec。
 *
 * 钉住四件事：
 *   1. 只有 passed 生成 spec，failed / flaky / error 只进报告；
 *   2. 同输入两次生成逐字节一致（模板里不能混日期、随机数、无序遍历）；
 *   3. 生成的代码真的有 expect 断言，且不是「只断言标题」；
 *   4. 标题 / 选择器 / 填写值里的引号、换行不会把代码写坏。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { moduleNameOf, writeSpecs } from '../src/generate/specs.mjs';
import { DEFAULT_BASE_URL, renderSpecCase } from '../src/generate/template.mjs';

/**
 * @param {Partial<import('../src/types.mjs').TestCase>} [overrides]
 * @returns {import('../src/types.mjs').TestCase}
 */
function caseOf(overrides = {}) {
  return {
    id: 'P0-todo-add',
    title: '添加待办后出现在列表里',
    priority: 'P0',
    sourceElement: '#todo-add',
    expect: ['列表里出现「买牛奶」'],
    steps: [
      { action: 'goto', page: '/' },
      { action: 'fill', target: '#todo-input', value: '买牛奶' },
      { action: 'click', target: '#todo-add' },
    ],
    ...overrides,
  };
}

/**
 * @param {string} caseId
 * @param {import('../src/types.mjs').RunStatus} status
 * @returns {import('../src/types.mjs').RunResult}
 */
function resultOf(caseId, status) {
  return {
    caseId,
    status,
    attempts: [
      {
        index: 0,
        status: status === 'passed' ? 'passed' : 'failed',
        durationMs: 12,
      },
    ],
    evidence: {
      input: '打开 /；点击 #todo-add',
      expected: '列表里出现「买牛奶」',
      actual: status === 'passed' ? '列表里出现了「买牛奶」' : '列表里没有出现「买牛奶」',
      minimalRepro: ['打开 /', '点击 #todo-add'],
    },
  };
}

/**
 * 在临时目录里跑一段，结束后无论成败都删掉。
 * @param {(dir: string) => void} run
 */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'autotest-specs-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('只给 passed 的用例生成 spec，标题与断言来自 TestCase', () => {
  withTempDir((dir) => {
    const passed = caseOf();
    const failed = caseOf({ id: 'P1-todo-delete', title: '删除待办' });
    const flaky = caseOf({ id: 'P1-todo-toggle', title: '勾选待办' });

    const report = writeSpecs(
      [passed, failed, flaky],
      [resultOf(passed.id, 'passed'), resultOf(failed.id, 'failed'), resultOf(flaky.id, 'flaky')],
      dir,
    );

    expect(report.files).toHaveLength(1);
    expect(report.files[0].file).toBe('specs/root.spec.mjs');
    expect(report.files[0].caseIds).toEqual([passed.id]);
    expect(report.cases).toBe(1);

    const source = readFileSync(join(dir, 'specs', 'root.spec.mjs'), 'utf8');
    // 标题按 TestCase.title 原样出现
    expect(source).toContain(`test('${passed.title}'`);
    // 文件头写明来源与用例 id
    expect(source).toContain('本文件由 autotest 自动生成');
    expect(source).toContain(passed.id);
    // 有真正的断言：地址、可视、填写值、未捕获异常
    expect(source).toContain('await expect(page).toHaveURL(');
    expect(source).toContain('.toBeVisible()');
    expect(source).toContain(".toHaveValue('买牛奶')");
    expect(source).toContain('pageErrors');
    // 失败用例不进代码
    expect(source).not.toContain('P1-todo-delete');
    expect(source).not.toContain('P1-todo-toggle');
  });
});

test('runPlan() 的 baseUrl 非枚举属性决定生成 spec 的地址，不回落到默认值', () => {
  withTempDir((dir) => {
    const passed = caseOf();

    // 与 runPlan() 一致：元信息挂在数组的非枚举属性上，JSON 序列化看不到。
    const results = [resultOf(passed.id, 'passed')];
    Object.defineProperty(results, 'baseUrl', {
      value: 'http://127.0.0.1:4100',
      enumerable: false,
    });

    writeSpecs([passed], results, dir);

    const source = readFileSync(join(dir, 'specs', 'root.spec.mjs'), 'utf8');
    expect(source).toContain('http://127.0.0.1:4100');
    expect(source).not.toContain(DEFAULT_BASE_URL);
  });
});

test('没通过或没有结果的用例进 skipped，说明原因', () => {
  withTempDir((dir) => {
    const passed = caseOf({ id: 'ok-1' });
    const failed = caseOf({ id: 'bad-1' });
    const missing = caseOf({ id: 'missing-1' });

    const report = writeSpecs(
      [passed, failed, missing],
      [resultOf(passed.id, 'passed'), resultOf(failed.id, 'failed')],
      dir,
    );

    const reasons = new Map(report.skipped.map((entry) => [entry.caseId, entry.reason]));
    expect(reasons.get('bad-1')).toContain('failed');
    expect(reasons.get('missing-1')).toContain('没有执行结果');
    expect(reasons.get('ok-1')).toBeUndefined();
  });
});

test('同输入两次生成逐字节一致', () => {
  withTempDir((first) => {
    withTempDir((second) => {
      const testCase = caseOf({
        title: '标题里有「引号」和\n换行',
        steps: [
          { action: 'goto', page: '/todos' },
          { action: 'fill', target: '#todo-input', value: "O'Reilly \\ 换行\n第二行" },
          { action: 'check', target: '#todo-1-toggle' },
        ],
      });
      const results = [resultOf(testCase.id, 'passed')];

      writeSpecs([testCase], results, first, { baseUrl: 'http://127.0.0.1:4173' });
      writeSpecs([testCase], results, second, { baseUrl: 'http://127.0.0.1:4173' });

      const left = readFileSync(join(first, 'specs', 'todos.spec.mjs'), 'utf8');
      const right = readFileSync(join(second, 'specs', 'todos.spec.mjs'), 'utf8');
      expect(left).toBe(right);
    });
  });
});

test('标题与填写值里的特殊字符被转义成合法 JS', () => {
  withTempDir((dir) => {
    const testCase = caseOf({
      title: '提交 O\'Reilly 的表单',
      steps: [
        { action: 'goto', page: '/' },
        { action: 'fill', target: '#name', value: "O'Reilly\n\\ /" },
      ],
    });

    writeSpecs([testCase], [resultOf(testCase.id, 'passed')], dir);
    const source = readFileSync(join(dir, 'specs', 'root.spec.mjs'), 'utf8');

    // 新行必须变成 \n，引号必须转义；原样换行会把字符串拆坏。
    expect(source).toContain("test('提交 O\\'Reilly 的表单'");
    expect(source).toContain("'O\\'Reilly\\n\\\\ /'");
    expect(source).not.toContain("test('提交 O'Reilly");
  });
});

test('空白用例拒绝生成，不落空测试', () => {
  expect(() => renderSpecCase(caseOf({ steps: [] }))).toThrow(/没有步骤/);
  expect(() => renderSpecCase(caseOf({ title: '' }))).toThrow(/没有标题/);
});

test('模块名取路由，根路径固定为 root', () => {
  expect(moduleNameOf(caseOf())).toBe('root');
  expect(
    moduleNameOf(
      caseOf({ steps: [{ action: 'goto', page: '/user/profile' }, { action: 'click', target: '#x' }] }),
    ),
  ).toBe('user-profile');
});

test('多条路由落到不同文件', () => {
  withTempDir((dir) => {
    const home = caseOf({ id: 'home-1' });
    const profile = caseOf({
      id: 'profile-1',
      steps: [{ action: 'goto', page: '/user/profile' }, { action: 'click', target: '#save' }],
    });

    const report = writeSpecs(
      [home, profile],
      [resultOf(home.id, 'passed'), resultOf(profile.id, 'passed')],
      dir,
    );

    expect(report.files.map((file) => file.file)).toEqual([
      'specs/root.spec.mjs',
      'specs/user-profile.spec.mjs',
    ]);
    expect(existsSync(join(dir, 'specs', 'root.spec.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'specs', 'user-profile.spec.mjs'))).toBe(true);
  });
});

test('一条都没通过时不创建 specs 目录', () => {
  withTempDir((dir) => {
    const testCase = caseOf();
    const report = writeSpecs([testCase], [resultOf(testCase.id, 'failed')], dir);

    expect(report.files).toEqual([]);
    expect(existsSync(join(dir, 'specs'))).toBe(false);
  });
});
