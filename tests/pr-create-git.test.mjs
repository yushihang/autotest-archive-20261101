/**
 * @file src/pr/create.mjs 里碰 git 的那部分——在临时仓库里跑，不碰当前工作区。
 *
 * 这里钉的是一条会静默误报的边界：`--pr` 第一步要确认工作区是干净的，而工具自己
 * 的产物（report / 截图 / specs）会被写在 output.dir 里。git 默认把整个未跟踪目录
 * 折叠成一条 `dir/`；output.dir 一旦嵌套（`autotest-output/verify-mvp` 就是
 * scripts/verify-mvp.sh 的写法），折叠出来的 `autotest-output/` 匹配不上白名单，
 * 工具就会把自己的产物报成「工作区不是干净的」。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { changedPaths } from '../src/pr/create.mjs';

/** 建一个空的临时 git 仓库（不提交：只看未跟踪文件的展开方式）。 */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'autotest-pr-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/**
 * 在仓库里写文件，自动建父目录。
 * @param {string} root
 * @param {string} relative
 * @param {string} content
 */
function writeFile(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test('嵌套 output.dir 下的未跟踪产物不算工作区改动', () => {
  const dir = tempRepo();
  try {
    writeFile(dir, 'autotest-output/verify-mvp/report.md', '# report');
    writeFile(dir, 'autotest-output/verify-mvp/screenshots/01.png', 'png');
    writeFile(dir, 'src/biz.mjs', 'export {};');

    // 产物被过滤掉，只剩业务文件——不是 `autotest-output/` 这条折叠路径。
    expect(changedPaths(dir, 'autotest-output/verify-mvp')).toEqual(['src/biz.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('顶层 output.dir 与默认值同样被过滤，白名单之外照样算脏', () => {
  const dir = tempRepo();
  try {
    writeFile(dir, 'autotest-output/report.md', '# report');
    writeFile(dir, 'src/biz.mjs', 'export {};');

    expect(changedPaths(dir, 'autotest-output')).toEqual(['src/biz.mjs']);
    // 没配 output.dir 时不能凭空忽略任何路径。
    expect(changedPaths(dir, undefined)).toEqual([
      'autotest-output/report.md',
      'src/biz.mjs',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
