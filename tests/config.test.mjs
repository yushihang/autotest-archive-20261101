/**
 * @file src/config.mjs 的单元测试。
 *
 * 契约 PR 最该有测试：normalizeConfig 的每一条错误分支都是调用方会撞上的边界，
 * 靠人眼看不住。normalizeConfig 接受已解析好的对象，所以大部分用例不用碰文件系统。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  ConfigError,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_TESTS_DIR,
  loadConfig,
  normalizeConfig,
} from '../src/config.mjs';

const EXAMPLE_CONFIG = fileURLToPath(new URL('../autotest.config.example.json', import.meta.url));

/**
 * 一份只写必填字段的最小配置。
 * @param {Record<string, unknown>} [overrides] 整段替换某个顶层字段
 * @returns {Record<string, unknown>}
 */
function minimalConfig(overrides = {}) {
  return JSON.parse(
    JSON.stringify({
      target: { baseUrl: 'http://127.0.0.1:4173', routes: ['/'] },
      limits: { maxCases: 1, maxWallMs: 1000, maxSteps: 1 },
      runner: { repeat: 1 },
      ...overrides,
    }),
  );
}

/**
 * 跑一段必然会抛错的逻辑，返回抛出的 ConfigError。
 * @param {() => unknown} run
 * @returns {ConfigError}
 */
function captureError(run) {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('期望抛出 ConfigError，但没有抛');
}

/**
 * @param {unknown} input
 * @returns {ConfigError}
 */
function normalizeErrorOf(input) {
  return captureError(() => normalizeConfig(input));
}

test.describe('合法配置', () => {
  test('只写必填字段时补齐默认值', () => {
    expect(normalizeConfig(minimalConfig())).toEqual({
      target: { baseUrl: 'http://127.0.0.1:4173', routes: ['/'] },
      limits: { maxCases: 1, maxWallMs: 1000, maxSteps: 1 },
      runner: { repeat: 1 },
      output: { dir: DEFAULT_OUTPUT_DIR },
      testsDir: DEFAULT_TESTS_DIR,
    });
  });

  test('默认值就是正常化的形态（不含多余斜杠）', () => {
    expect(DEFAULT_OUTPUT_DIR.endsWith('/')).toBe(false);
    expect(DEFAULT_TESTS_DIR.endsWith('/')).toBe(true);
  });

  test('示例配置 autotest.config.example.json 能真实加载', () => {
    expect(loadConfig(EXAMPLE_CONFIG)).toEqual({
      target: {
        baseUrl: 'http://127.0.0.1:4173',
        routes: ['/', '/login', '/cart'],
      },
      limits: { maxCases: 20, maxWallMs: 300000, maxSteps: 12 },
      runner: { repeat: 2 },
      output: { dir: DEFAULT_OUTPUT_DIR },
      testsDir: DEFAULT_TESTS_DIR,
    });
  });

  test('baseUrl 去掉结尾斜杠', () => {
    const normalized = normalizeConfig(
      minimalConfig({ target: { baseUrl: 'https://example.com/app/', routes: ['/'] } }),
    );
    expect(normalized.target.baseUrl).toBe('https://example.com/app');
  });

  test('路由去重、去掉结尾斜杠、保留原顺序', () => {
    const normalized = normalizeConfig(
      minimalConfig({ target: { baseUrl: 'http://127.0.0.1:4173', routes: ['/a', '/a/', '/b', '/'] } }),
    );
    expect(normalized.target.routes).toEqual(['/a', '/b', '/']);
  });

  test('字符串字段两头的空白被去掉', () => {
    const normalized = normalizeConfig(
      minimalConfig({
        target: { baseUrl: '  http://127.0.0.1:4173  ', routes: [' /a '] },
        testsDir: ' spec ',
      }),
    );
    expect(normalized.target.baseUrl).toBe('http://127.0.0.1:4173');
    expect(normalized.target.routes).toEqual(['/a']);
    expect(normalized.testsDir).toBe('spec/');
  });

  test('目录去掉开头的 ./，结尾斜杠按字段统一', () => {
    const normalized = normalizeConfig(
      minimalConfig({ testsDir: './spec/', output: { dir: './out/' } }),
    );
    expect(normalized.testsDir).toBe('spec/');
    expect(normalized.output.dir).toBe('out');
  });
});

test.describe('未知字段', () => {
  test('顶层多写一个字段就报错', () => {
    const error = normalizeErrorOf(minimalConfig({ extra: true }));
    expect(error.field).toBe('extra');
    expect(error.message).toContain('未知字段');
  });

  test('拼错的可选字段 testsdir 不会被静默忽略', () => {
    const error = normalizeErrorOf(minimalConfig({ testsdir: 'spec/' }));
    expect(error.field).toBe('testsdir');
    expect(error.message).toContain('testsDir');
  });

  test('拼错的可选字段 outp 不会被静默忽略', () => {
    const error = normalizeErrorOf(minimalConfig({ outp: { dir: 'o' } }));
    expect(error.field).toBe('outp');
  });

  test('嵌套对象里的未知字段报错，字段路径带父级', () => {
    expect(normalizeErrorOf(minimalConfig({ limits: { maxCases: 1, maxWallMs: 1, maxSteps: 1, maxCase: 2 } })).field)
      .toBe('limits.maxCase');
    expect(normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', url: '/a', routes: ['/'] } })).field)
      .toBe('target.url');
    expect(normalizeErrorOf(minimalConfig({ runner: { repeat: 1, retry: 1 } })).field)
      .toBe('runner.retry');
    expect(normalizeErrorOf(minimalConfig({ output: { dir: 'o', keep: true } })).field)
      .toBe('output.keep');
  });
});

test.describe('必填字段', () => {
  test('根节点必须是对象', () => {
    expect(normalizeErrorOf([]).field).toBe('config');
    expect(normalizeErrorOf(null).field).toBe('config');
    expect(normalizeErrorOf('{}').field).toBe('config');
    expect(normalizeErrorOf([]).message).toContain('根节点必须是 JSON 对象');
  });

  for (const field of ['target', 'limits', 'runner']) {
    test(`缺 ${field} 时报错并指出字段名`, () => {
      const config = minimalConfig();
      delete config[field];
      const error = normalizeErrorOf(config);
      expect(error.field).toBe(field);
      expect(error.message).toContain('缺少必填字段');
    });
  }

  test('target 不是对象时报错', () => {
    const error = normalizeErrorOf(minimalConfig({ target: 'http://127.0.0.1:4173' }));
    expect(error.field).toBe('target');
    expect(error.message).toContain('必须是对象');
  });

  test('缺 target.baseUrl / target.routes 时报错', () => {
    expect(normalizeErrorOf(minimalConfig({ target: { routes: ['/'] } })).field).toBe('target.baseUrl');
    expect(normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test' } })).field).toBe('target.routes');
  });
});

test.describe('类型与取值', () => {
  test('数字字段写成字符串时报错', () => {
    const error = normalizeErrorOf(minimalConfig({ limits: { maxCases: '20', maxWallMs: 1, maxSteps: 1 } }));
    expect(error.field).toBe('limits.maxCases');
    expect(error.message).toContain('必须是数字');
  });

  test('非有限数字不算数字', () => {
    // 这里不走 minimalConfig 的 JSON 往返：JSON 会把 Infinity 变成 null。
    const config = minimalConfig();
    config.limits.maxWallMs = Infinity;
    const error = normalizeErrorOf(config);
    expect(error.field).toBe('limits.maxWallMs');
    expect(error.message).toContain('必须是数字');
  });

  test('小数不是整数', () => {
    const error = normalizeErrorOf(minimalConfig({ runner: { repeat: 1.5 } }));
    expect(error.field).toBe('runner.repeat');
    expect(error.message).toContain('必须是整数');
  });

  test('小于下限的值被拒绝', () => {
    expect(normalizeErrorOf(minimalConfig({ runner: { repeat: 0 } })).message).toContain('必须 >= 1');
    expect(normalizeErrorOf(minimalConfig({ runner: { repeat: 0 } })).field).toBe('runner.repeat');
    expect(normalizeErrorOf(minimalConfig({ limits: { maxCases: 0, maxWallMs: 1, maxSteps: 1 } })).field)
      .toBe('limits.maxCases');
    expect(normalizeErrorOf(minimalConfig({ limits: { maxCases: 1, maxWallMs: 1, maxSteps: -1 } })).field)
      .toBe('limits.maxSteps');
  });

  test('空字符串和纯空白都被拒绝', () => {
    for (const testsDir of ['', '   ']) {
      const error = normalizeErrorOf(minimalConfig({ testsDir }));
      expect(error.field).toBe('testsDir');
      expect(error.message).toContain('不能是空字符串');
    }
  });

  test('output 必须是对象', () => {
    const error = normalizeErrorOf(minimalConfig({ output: 'out' }));
    expect(error.field).toBe('output');
    expect(error.message).toContain('必须是对象');
  });

  test('routes 必须是数组、不能为空、元素必须是字符串', () => {
    expect(normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', routes: '/' } })).field)
      .toBe('target.routes');
    expect(normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', routes: [] } })).message)
      .toContain('不能是空数组');

    const error = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', routes: ['/a', 3] } }));
    expect(error.field).toBe('target.routes[1]');
    expect(error.message).toContain('必须是字符串');
  });

  test('路由必须以 / 开头、不能带 hash', () => {
    const notSlash = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', routes: ['a'] } }));
    expect(notSlash.field).toBe('target.routes[0]');
    expect(notSlash.message).toContain("必须以 '/' 开头");

    const withHash = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test', routes: ['/a#top'] } }));
    expect(withHash.field).toBe('target.routes[0]');
    expect(withHash.message).toContain('hash');
  });

  test('baseUrl 必须是合法 URL 且只支持 http / https', () => {
    const notUrl = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'not a url', routes: ['/'] } }));
    expect(notUrl.field).toBe('target.baseUrl');
    expect(notUrl.message).toContain('不是合法 URL');

    const protocol = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'ftp://x.test', routes: ['/'] } }));
    expect(protocol.message).toContain('只支持 http / https');
  });

  test('baseUrl 不能带查询串或 hash', () => {
    const withQuery = normalizeErrorOf(
      minimalConfig({ target: { baseUrl: 'http://x.test/?a=1', routes: ['/'] } }),
    );
    expect(withQuery.field).toBe('target.baseUrl');
    expect(withQuery.message).toContain('不能带查询串或 hash');

    const withHash = normalizeErrorOf(minimalConfig({ target: { baseUrl: 'http://x.test/#top', routes: ['/'] } }));
    expect(withHash.message).toContain('不能带查询串或 hash');
  });
});

test.describe('目录边界：只能写仓库内', () => {
  // 这个工具的边界是「只加测试文件、不碰别处」，写到仓库根之外等于把边界交给配置拼写。
  test("testsDir 不能是 '..'", () => {
    const error = normalizeErrorOf(minimalConfig({ testsDir: '..' }));
    expect(error.field).toBe('testsDir');
    expect(error.message).toContain("'..'");
  });

  test('testsDir 不能带 .. 段', () => {
    for (const testsDir of ['../outside', 'a/../b', 'a/..']) {
      const error = normalizeErrorOf(minimalConfig({ testsDir }));
      expect(error.field).toBe('testsDir');
      expect(error.message).toContain("'..'");
    }
  });

  test('testsDir / output.dir 不能是绝对路径', () => {
    for (const testsDir of ['/etc/foo', '/tmp/tests/', 'C:/tests', 'C:\\tests']) {
      const error = normalizeErrorOf(minimalConfig({ testsDir }));
      expect(error.field).toBe('testsDir');
      expect(error.message).toContain('绝对路径');
    }
    const output = normalizeErrorOf(minimalConfig({ output: { dir: '/tmp/out' } }));
    expect(output.field).toBe('output.dir');
    expect(output.message).toContain('绝对路径');
  });

  test('根目录和当前目录仍然被拒绝', () => {
    expect(normalizeErrorOf(minimalConfig({ testsDir: '/' })).field).toBe('testsDir');
    expect(normalizeErrorOf(minimalConfig({ testsDir: '.' })).field).toBe('testsDir');
    expect(normalizeErrorOf(minimalConfig({ testsDir: './' })).field).toBe('testsDir');
  });
});

test.describe('loadConfig 读文件', () => {
  test('读不到文件时报 config 错误', () => {
    const error = captureError(() => loadConfig('/nonexistent-dir/autotest.config.json'));
    expect(error.field).toBe('config');
    expect(error.message).toContain('读不到配置文件');
  });

  test('没给路径时报 config 错误', () => {
    expect(captureError(() => loadConfig('')).field).toBe('config');
    expect(captureError(() => loadConfig('   ')).field).toBe('config');
  });

  test('不是合法 JSON 时报 config 错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autotest-config-'));
    try {
      const file = join(dir, 'autotest.config.json');
      writeFileSync(file, '{ "target": }', 'utf8');
      const error = captureError(() => loadConfig(file));
      expect(error.field).toBe('config');
      expect(error.message).toContain('不是合法 JSON');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('合法文件读出来与 normalizeConfig 一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autotest-config-'));
    try {
      const file = join(dir, 'autotest.config.json');
      const config = minimalConfig({ testsDir: './spec/' });
      writeFileSync(file, JSON.stringify(config), 'utf8');
      expect(loadConfig(file)).toEqual(normalizeConfig(config));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
