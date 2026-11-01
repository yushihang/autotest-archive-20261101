/**
 * @file 仓库自身的元数据检查。
 *
 * 这几条是把「克隆下来能不能用」变成会自动失败的断言：
 * script 指向不存在的文件、依赖写成浮动版本、声明了 license 却没有 LICENSE 文件，
 * 这些都只有第一个克隆仓库的人会踩到，CI 不会红。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { DEFAULT_OUTPUT_DIR } from '../src/config.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

test('npm scripts 引用的本地文件都存在', () => {
  const missing = [];
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    for (const token of command.split(/\s+/)) {
      // 只看指向本地文件的参数：src/cli.mjs、scripts/verify-mvp.sh 这类
      if (!/\.(?:mjs|cjs|js|ts|sh)$/.test(token)) continue;
      if (token.startsWith('-')) continue;
      if (!existsSync(join(REPO_ROOT, token))) missing.push(`npm run ${name}：${token} 不存在`);
    }
  }
  expect(missing).toEqual([]);
});

test('直接依赖都写死精确版本', () => {
  const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
  expect(Object.keys(all).length).toBeGreaterThan(0);
  // 精确版本：不带 ^ / ~ / 区间，装出来的就是写下的那个版本
  for (const version of Object.values(all)) {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  }
});

test('playwright 与 @playwright/test 版本一致', () => {
  // @playwright/test 自身依赖 playwright，两个版本必须永远同步，否则装出来的组合不匹配。
  expect(packageJson.devDependencies['@playwright/test']).toBe(packageJson.dependencies.playwright);
});

test('声明了 license 就得有 LICENSE 文件', () => {
  expect(packageJson.license).toBe('MIT');
  const license = join(REPO_ROOT, 'LICENSE');
  expect(existsSync(license)).toBe(true);
  expect(readFileSync(license, 'utf8')).toContain('MIT');
});

test('.gitignore 忽略了依赖目录和默认产物目录', () => {
  const lines = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  expect(lines).toContain('node_modules/');
  // 跟着 config.mjs 的常量走：改了默认产物目录，这里会立刻提醒同步 .gitignore。
  expect(lines).toContain(`${DEFAULT_OUTPUT_DIR}/`);
});
