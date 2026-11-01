/**
 * @file src/pr/guard.mjs 的行为：PR 里只能有测试文件。
 *
 * 这个护栏是产品边界（「业务代码一行都不改」）的唯一执行点，所以要钉住的不是
 * 「happy path 能过」，而是每一条绕过路径都会失败：
 *
 *   - 业务文件（新增 / 修改 / 删除都算）必须拦住；
 *   - 前缀相似但不在目录内的路径（test-old/、test 本身）必须拦住；
 *   - 越出仓库根的路径必须拦住；
 *   - 没有 force / 第三个参数之类的跳过开关。
 */

import { expect, test } from '@playwright/test';

import { assertOnlyTests, GuardError } from '../src/pr/guard.mjs';

test('testsDir 下的文件放行', () => {
  const changed = ['test/login.spec.mjs', 'test/cart.spec.mjs'];
  expect(assertOnlyTests(changed, 'test/')).toEqual(changed);
});

test('新增 / 修改 / 删除一视同仁：只看路径', () => {
  // 护栏拿到的是文件路径清单，本来就分不清状态；这里确认删除的文件也照样检查。
  expect(() => assertOnlyTests(['test/login.spec.mjs', 'src/api/login.mjs'], 'test/')).toThrow(
    GuardError,
  );
});

test('业务文件被拦住，错误里带完整清单', () => {
  let error;
  try {
    assertOnlyTests(['test/a.spec.mjs', 'src/config.mjs', 'README.md'], 'test/');
  } catch (cause) {
    error = cause;
  }

  expect(error).toBeInstanceOf(GuardError);
  expect(error.offending).toEqual(['src/config.mjs', 'README.md']);
  expect(error.message).toContain('src/config.mjs');
  expect(error.message).toContain('README.md');
});

test('前缀相似但不在目录内的路径被拦住', () => {
  // test-old/ 不是 test/ 的子目录；文件名叫 test 的也不是「test/ 下的文件」。
  expect(() => assertOnlyTests(['test-old/a.spec.mjs'], 'test/')).toThrow(GuardError);
  expect(() => assertOnlyTests(['test'], 'test/')).toThrow(GuardError);
});

test('路径规范化：./ 前缀与 Windows 分隔符等价', () => {
  expect(assertOnlyTests(['./test/a.spec.mjs', 'test\\b.spec.mjs'], 'test/')).toEqual([
    'test/a.spec.mjs',
    'test/b.spec.mjs',
  ]);
});

test('越出仓库根的路径被拦住', () => {
  expect(() => assertOnlyTests(['../outside/a.spec.mjs'], 'test/')).toThrow(GuardError);
});

test('自定义 testsDir 生效', () => {
  expect(assertOnlyTests(['tests/unit/a.test.mjs'], 'tests/')).toEqual(['tests/unit/a.test.mjs']);
  expect(() => assertOnlyTests(['test/a.spec.mjs'], 'tests/')).toThrow(GuardError);
});

test('没有强制跳过开关：多余参数也不会让业务文件通过', () => {
  // @ts-expect-error 故意传第三个参数，模拟「有人想加个 force」
  expect(() => assertOnlyTests(['src/config.mjs'], 'test/', { force: true })).toThrow(GuardError);
});

test('空清单放行（没有改动就没有可拦的）', () => {
  expect(assertOnlyTests([], 'test/')).toEqual([]);
});

test('testsDir 非法时直接报错，不能静默把白名单放大', () => {
  // 白名单目录写错（绝对路径 / 空串 / 仓库根）必须报错，否则护栏等于没有。
  expect(() => assertOnlyTests(['src/config.mjs'], '/etc')).toThrow(GuardError);
  expect(() => assertOnlyTests(['src/config.mjs'], '')).toThrow(GuardError);
  expect(() => assertOnlyTests(['src/config.mjs'], './')).toThrow(GuardError);
});

test('changedFiles 不是数组时抛 TypeError', () => {
  // @ts-expect-error 故意传错类型
  expect(() => assertOnlyTests('test/a.spec.mjs')).toThrow(TypeError);
});
