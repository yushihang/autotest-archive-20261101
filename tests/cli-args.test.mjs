/**
 * @file src/cli.mjs 的参数解析与计数：默认 dry-run、--pr 才碰 git。
 *
 * 这些断言防的是「看起来在演习，其实已经开火」：拼错的参数被静默忽略、默认模式
 * 悄悄变成 --pr、两个模式同时给还能跑——任何一条都会让人在没准备的时候建分支。
 */

import { expect, test } from '@playwright/test';

import { countStatuses, parseArgs, UsageError } from '../src/cli.mjs';

test('默认是 dry-run', () => {
  expect(parseArgs(['run', '--config', 'autotest.config.json'])).toEqual({
    mode: 'run',
    configPath: 'autotest.config.json',
    pr: false,
  });
});

test('--dry-run 写不写都一样', () => {
  expect(parseArgs(['run', '--config', 'a.json', '--dry-run'])).toEqual({
    mode: 'run',
    configPath: 'a.json',
    pr: false,
  });
});

test('--pr 才把 pr 置为 true', () => {
  expect(parseArgs(['run', '--config', 'a.json', '--pr'])).toEqual({
    mode: 'run',
    configPath: 'a.json',
    pr: true,
  });
});

test('--config=path 与 --config path 等价', () => {
  expect(parseArgs(['run', '--config=a.json']).configPath).toBe('a.json');
});

test('--dry-run 与 --pr 互斥', () => {
  expect(() => parseArgs(['run', '--config', 'a.json', '--dry-run', '--pr'])).toThrow(UsageError);
});

test('缺 --config 报错', () => {
  expect(() => parseArgs(['run'])).toThrow(UsageError);
  expect(() => parseArgs(['run', '--config'])).toThrow(UsageError);
  expect(() => parseArgs(['run', '--config='])).toThrow(UsageError);
});

test('不认识的参数报错，不静默忽略', () => {
  // --dryrun 这种拼写错误如果被忽略，用户会以为在演练，实际却建了分支。
  expect(() => parseArgs(['run', '--config', 'a.json', '--dryrun'])).toThrow(UsageError);
  expect(() => parseArgs(['plan', '--config', 'a.json'])).toThrow(UsageError);
});

test('--help 与 -h', () => {
  expect(parseArgs(['--help'])).toEqual({ mode: 'help' });
  expect(parseArgs(['run', '-h'])).toEqual({ mode: 'help' });
});

test('countStatuses 按契约状态计数，未知状态计入 other', () => {
  const results = [
    { status: 'passed' },
    { status: 'passed' },
    { status: 'failed' },
    { status: 'flaky' },
    { status: 'error' },
    { status: 'weird' },
  ];

  expect(countStatuses(results)).toEqual({
    passed: 2,
    failed: 1,
    flaky: 1,
    error: 1,
    other: 1,
    total: 6,
  });
});
