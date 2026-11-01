/**
 * @file src/runner 的地址拼接。
 *
 * 回归的是「baseUrl 带路径前缀」这一类事故：`new URL('/login', baseUrl)` 按 origin 解析，
 * 会把 `https://example.com/app` 的前缀整段丢掉，所有挂在子路径下的应用每条用例都会
 * 打开 404 页面，而 origin 校验又不会拦住它。探测与执行必须共用 config.mjs 的 joinUrl。
 */

import { expect, test } from '@playwright/test';

import { joinUrl } from '../src/config.mjs';
import { toUrl } from '../src/runner/index.mjs';

test('baseUrl 带路径前缀时，根相对路由拼在前缀后面', () => {
  expect(toUrl('https://example.com/app', '/login')).toBe('https://example.com/app/login');
  expect(toUrl('https://example.com/app', '/')).toBe('https://example.com/app/');
});

test('路由里的查询串原样保留', () => {
  expect(toUrl('https://example.com/app', '/todos?filter=done')).toBe(
    'https://example.com/app/todos?filter=done',
  );
});

test('page 缺失或为空时落到站点根', () => {
  expect(toUrl('https://example.com/app', undefined)).toBe('https://example.com/app/');
  expect(toUrl('https://example.com/app', '  ')).toBe('https://example.com/app/');
});

test('完整 URL 不会被当成路由，直接拒绝', () => {
  // 契约要求 page 是以 '/' 开头的路由；混进完整地址时宁可直接报错，
  // 也不要拼出一个奇怪的地址再靠 origin 校验兜底。
  expect(() => toUrl('https://example.com/app', 'https://other.example.com/x')).toThrow(
    "必须以 '/' 开头",
  );
  expect(() => toUrl('https://example.com/app', 'login')).toThrow("必须以 '/' 开头");
});

test('joinUrl 是探测与执行共用的唯一拼接规则', () => {
  // 与 src/probe/index.mjs 使用同一个 helper：两边各写一套就会再次漂移。
  expect(joinUrl('https://example.com/app', '/login')).toBe('https://example.com/app/login');
  expect(joinUrl('https://example.com', '/')).toBe('https://example.com/');
});
