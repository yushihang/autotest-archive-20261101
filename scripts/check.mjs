#!/usr/bin/env node
/**
 * @file 语法门禁：仓库里每个 .mjs 都过一遍 `node --check`。
 *
 * 为什么按目录遍历、而不是在 package.json 里点名文件：点名的那份列表一加模块就会悄悄漏检
 * （`src/cli.mjs` 一落地就没人记得回来改那一行），这正是 `tests/package.test.mjs` 开头反对的、
 * 「只有第一个克隆的人踩到、CI 不会红」的那类问题。遍历也不会在第一个错处停下，
 * 一次把所有失败文件都打出来，不用修一个跑一次。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 依赖和产物目录里是别人的文件或生成物，与 .gitignore 对应。
const SKIP_DIRS = new Set([
  'node_modules',
  'coverage',
  'test-results',
  'playwright-report',
  'autotest-output',
]);

/**
 * 递归收集待检查的模块。
 * @param {string} dir 起始目录（绝对路径）
 * @returns {string[]} 文件的绝对路径
 */
function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      files.push(...collect(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const files = collect(ROOT).sort();
if (files.length === 0) {
  // 一个文件都没扫到，说明遍历逻辑坏了或者目录结构变了，别静默通过。
  console.error('没找到任何 .mjs 文件，检查等于没跑。');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  // 用 process.execPath 而不是 'node'：走的是当前这次调用的同一个 node，不依赖 PATH。
  // --check 只做语法解析，不执行文件（demo-app/server.mjs 这类带副作用的也能安全检查）。
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed.push({ file, output: `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() });
  }
}

if (failed.length > 0) {
  for (const { file, output } of failed) {
    console.error(`✗ ${relative(ROOT, file)}`);
    if (output) console.error(output);
  }
  console.error(`\n${failed.length}/${files.length} 个文件语法检查失败。`);
  process.exit(1);
}

console.log(`✓ ${files.length} 个 .mjs 文件语法检查通过。`);
