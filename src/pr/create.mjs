/**
 * @file 建分支、提交、开 PR——以及 push 之前的最后一道护栏。
 *
 * 顺序是刻意的：
 *
 *   1. 先检查环境（git 仓库、工作区干净、gh 可用）——失败时还没动过任何东西；
 *   2. 只把生成的测试文件复制进 testsDir，然后显式 `git add` 这些路径；
 *   3. 提交前用 git status 再跑一次 assertOnlyTests；
 *   4. 提交，用 `git diff --name-only <base>..HEAD` 复核这次提交改了哪些文件；
 *   5. 护栏通过才 `git push` 和 `gh pr create`。
 *
 * 第 3、4 步看起来重复，但挡的不是同一件事：第 3 步挡「工作区里混进别人的改动」，
 * 第 4 步挡「提交本身包含目录外文件」。任何一步抛错都不 push——分支和提交留在本地，
 * 人还能看、能改，但错误进不了远端。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { assertOnlyTests, GuardError } from './guard.mjs';

/** 分支名前缀：`autotest/<runId>`。 */
export const BRANCH_PREFIX = 'autotest/';

/**
 * 创建 PR 阶段的错误（环境不满足、git / gh 命令失败、没有可提交的测试）。
 * 与 GuardError 分开，方便 CLI 用不同的提示语。
 */
export class PrError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, stderr?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'PrError';
    if (details.stderr !== undefined) this.stderr = details.stderr;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/**
 * 用时间戳生成 runId（不用随机数：同一个时刻跑两次会撞名，但那本来就该让人看见，
 * 而不是靠随机后缀把冲突藏起来）。
 *
 * 格式：`YYYYMMDDTHHMMSS`，UTC，秒级；对 git 引用和分支名都安全。
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function createRunId(now = new Date()) {
  const iso = now.toISOString(); // 2026-11-01T09:25:30.000Z
  return iso.slice(0, 19).replace(/[-:]/g, '');
}

/**
 * runId → 分支名。
 *
 * @param {string} runId
 * @returns {string}
 * @throws {PrError} runId 不能安全地放进 git 引用时抛出
 */
export function branchNameFor(runId) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new PrError('runId 不能为空');
  }
  // git 引用的限制：不能有空格、~ ^ : ? * [ \ 、不能以 '.' 结尾、不能有 '..'。
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes('..') || runId.endsWith('.')) {
    throw new PrError(`runId 不能安全地放进分支名：${runId}`);
  }
  return `${BRANCH_PREFIX}${runId}`;
}

/**
 * PR 标题：`test: 给 <模块> 补 <N> 条用例`。
 *
 * 多个模块时模块名用 '、' 连接；模块太多（> 2）时只写首个 + 总数，避免标题长到被截断。
 *
 * @param {{ module: string, caseIds: string[] }[]} specFiles
 * @returns {string}
 */
export function buildTitle(specFiles) {
  const files = Array.isArray(specFiles) ? specFiles : [];
  const modules = files.map((file) => file.module).filter((name) => typeof name === 'string' && name !== '');
  const count = files.reduce(
    (sum, file) => sum + (Array.isArray(file.caseIds) ? file.caseIds.length : 0),
    0,
  );

  const moduleText =
    modules.length === 0
      ? '未识别模块'
      : modules.length <= 2
        ? modules.join('、')
        : `${modules[0]} 等 ${modules.length} 个模块`;

  return `test: 给 ${moduleText} 补 ${count} 条用例`;
}

/**
 * 单行化：PR 正文里换行会拆散列表项。
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  const flat = value === undefined || value === null ? '' : String(value);
  return flat.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * 报告里的相对路径：PR 正文要能在仓库里找到证据文件。
 * @param {string} reportPath
 * @returns {string}
 */
function reportLink(reportPath) {
  return oneLine(reportPath) === '' ? '（未生成）' : oneLine(reportPath);
}

/**
 * 拼 PR 正文：覆盖清单、未覆盖原因、失败用例证据三块是硬要求。
 *
 * 正文只写「看到了什么」，不判定「业务有没有 bug」——和 report.md 的立场一致。
 *
 * @param {{
 *   plan: import('../types.mjs').TestCase[] & { dropped?: string[], unstable?: unknown[] },
 *   results: import('../types.mjs').RunResult[],
 *   specFiles: { module: string, file: string, caseIds: string[] }[],
 *   reportPath: string,
 *   skipped?: { caseId: string, reason: string }[],
 *   runId?: string,
 *   baseUrl?: string,
 * }} input
 * @returns {string}
 */
export function buildPullRequestBody(input) {
  const plan = Array.isArray(input.plan) ? input.plan : [];
  const results = Array.isArray(input.results) ? input.results : [];
  const specFiles = Array.isArray(input.specFiles) ? input.specFiles : [];

  const statusById = new Map();
  for (const result of results) {
    if (typeof result?.caseId === 'string') statusById.set(result.caseId, result.status);
  }

  /** @type {string[]} */
  const lines = [];
  lines.push('本 PR 只包含测试文件，业务代码一行未改（由 `assertOnlyTests` 在 push 前校验）。');
  lines.push('');

  // ---------------------------------------------------------------- 覆盖清单
  const totalSpecCases = specFiles.reduce(
    (sum, file) => sum + (Array.isArray(file.caseIds) ? file.caseIds.length : 0),
    0,
  );
  lines.push(`## 覆盖清单（${totalSpecCases} 条用例）`);
  lines.push('');
  if (specFiles.length === 0) {
    lines.push('- 本次没有生成可提交的测试文件。');
  } else {
    for (const file of specFiles) {
      const moduleName = oneLine(file.module);
      const caseIds = Array.isArray(file.caseIds) ? file.caseIds : [];
      lines.push(`### \`${oneLine(file.file)}\`（${caseIds.length} 条）`);
      lines.push('');
      const cases = caseIds
        .map((caseId) => plan.find((item) => item?.id === caseId))
        .filter(Boolean);
      if (cases.length === 0) {
        lines.push('- 用例详情见报告。');
      } else {
        for (const testCase of cases) {
          const status = statusById.get(testCase.id);
          const mark = status === 'passed' ? '✅' : status === 'flaky' ? '⚠️' : status ? '❌' : '⏭';
          lines.push(
            `- ${mark} \`${oneLine(testCase.id)}\` ${oneLine(testCase.title)}（${oneLine(testCase.priority)}，${moduleName}）`,
          );
        }
      }
      lines.push('');
    }
  }

  // ---------------------------------------------------------------- 未覆盖
  lines.push('## 未覆盖及原因');
  lines.push('');
  /** @type {string[]} */
  const uncovered = [];

  const dropped = Array.isArray(plan.dropped) ? plan.dropped : [];
  if (dropped.length > 0) {
    uncovered.push(`- 超出用例数上限被截断：${dropped.map((id) => `\`${oneLine(id)}\``).join('、')}`);
  }

  const unstable = Array.isArray(plan.unstable) ? plan.unstable : [];
  if (unstable.length > 0) {
    const names = unstable
      .map((item) => oneLine(item?.selector ?? item?.name ?? item?.reason))
      .filter((name) => name !== '');
    uncovered.push(`- 选择器不稳定，未生成用例：${names.length > 0 ? names.join('、') : `${unstable.length} 个元素`}`);
  }

  const skipped = Array.isArray(input.skipped) ? input.skipped : [];
  for (const item of skipped) {
    const name = oneLine(item?.caseId ?? item?.module) || '未命名项';
    uncovered.push(`- \`${name}\`：${oneLine(item?.reason)}`);
  }

  const plannedIds = new Set(plan.map((item) => item?.id));
  for (const result of results) {
    if (result.status === 'passed') continue;
    // 有结果的失败用例在下一节展开，这里只记「没跑成」的。
    if (plannedIds.has(result.caseId)) continue;
    uncovered.push(`- \`${oneLine(result.caseId)}\`：执行了但计划里没有对应用例`);
  }

  const notRun = plan.filter((item) => !statusById.has(item?.id));
  if (notRun.length > 0) {
    uncovered.push(
      `- 未执行（预算中止或结果缺失）：${notRun.map((item) => `\`${oneLine(item.id)}\``).join('、')}`,
    );
  }

  if (uncovered.length === 0) {
    lines.push('- 无。计划内的用例全部执行并生成了测试代码。');
  } else {
    lines.push(...uncovered);
  }
  lines.push('');

  // ---------------------------------------------------------------- 失败证据
  lines.push('## 失败用例证据');
  lines.push('');
  const failures = results.filter(
    (result) => result.status === 'failed' || result.status === 'error' || result.status === 'flaky',
  );

  if (failures.length === 0) {
    lines.push('- 无失败或 flaky 用例。');
  } else {
    for (const result of failures) {
      const evidence = result.evidence ?? {};
      lines.push(`### \`${oneLine(result.caseId)}\`（${oneLine(result.status)}）`);
      lines.push('');
      lines.push(`- 输入：${oneLine(evidence.input) || '—'}`);
      lines.push(`- 期望：${oneLine(evidence.expected) || '—'}`);
      lines.push(`- 实际：${oneLine(evidence.actual) || '—'}`);
      if (evidence.repro) lines.push(`- 最小复现：${oneLine(evidence.repro)}`);
      if (evidence.screenshot) lines.push(`- 截图：\`${oneLine(evidence.screenshot)}\``);
      if (Array.isArray(evidence.consoleErrors) && evidence.consoleErrors.length > 0) {
        lines.push(`- Console 错误：${evidence.consoleErrors.map(oneLine).join('；')}`);
      }
      lines.push('');
    }
    lines.push('> 工具发现的失败不等于业务有 bug：可能是真有 bug、用例写错了、或环境不对。');
    lines.push('> 判断责任在人，这份 PR 只负责把证据摆整齐。');
    lines.push('');
  }

  // ---------------------------------------------------------------- 运行信息
  lines.push('## 本次运行');
  lines.push('');
  if (input.runId) lines.push(`- runId：\`${oneLine(input.runId)}\``);
  if (input.baseUrl) lines.push(`- 目标：${oneLine(input.baseUrl)}`);
  lines.push(`- 报告：${reportLink(input.reportPath)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * 把生成的 spec 复制进 testsDir，返回实际新增的文件。
 *
 * 只新增、不覆盖：同名文件内容一致就跳过；内容不同则跳过并在 `skipped` 里说明原因。
 * 「补充已有测试文件里的用例」是人做的事，自动覆盖等于改别人写好的断言，不能干。
 *
 * @param {{
 *   dir: string,
 *   files: { module: string, file: string, caseIds: string[] }[],
 * }} specReport writeSpecs() 的返回
 * @param {{ testsDir: string, cwd?: string }} options
 * @returns {{ files: string[], skipped: { module: string, reason: string }[] }} files 是相对仓库根的路径
 */
export function copySpecsIntoTestsDir(specReport, options) {
  const cwd = options.cwd ?? process.cwd();
  const testsDir = options.testsDir;
  const targetDir = resolve(cwd, testsDir);

  /** @type {string[]} */
  const files = [];
  /** @type {{ module: string, reason: string }[]} */
  const skipped = [];

  for (const specFile of specReport?.files ?? []) {
    const fileName = basename(specFile.file);
    const source = join(specReport.dir, fileName);
    const target = join(targetDir, fileName);
    const relative = `${testsDir.replace(/\/+$/, '')}/${fileName}`;

    let content;
    try {
      content = readFileSync(source, 'utf8');
    } catch (cause) {
      throw new PrError(`读不到生成的测试文件 ${source}`, { cause });
    }

    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8');
      if (existing === content) continue; // 内容一样，不算改动
      skipped.push({
        module: specFile.module,
        reason: `${relative} 已存在且内容不同，拒绝覆盖（人工合并后再跑）`,
      });
      continue;
    }

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, content, 'utf8');
    files.push(relative);
  }

  return { files, skipped };
}

/**
 * 同步跑一条命令，失败时抛出带 stdout / stderr 的 PrError。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, trim?: boolean }} [options] trim=false 用于 `git status -z`：
 *   它的输出以状态字符开头，` M file` 的首尾空白是有意义的，trim 会把路径削错位。
 * @returns {string} stdout
 */
function exec(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return options.trim === false ? output : output.trim();
  } catch (cause) {
    const stdout = String(cause?.stdout ?? '').trim();
    const stderr = String(cause?.stderr ?? '').trim();
    const detail = [stderr, stdout].filter((text) => text !== '').join('\n');
    throw new PrError(`${command} ${args.join(' ')} 失败${detail === '' ? '' : `：\n${detail}`}`, {
      cause,
      stderr,
    });
  }
}

/**
 * path 是否在 dir 下（两者都是相对仓库根、`/` 分隔）。
 * @param {string} path
 * @param {string | undefined} dir
 * @returns {boolean}
 */
function isInsideDir(path, dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return false;
  const normalized = dir.trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (normalized === '') return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

/**
 * `git status --porcelain` → 改动过的文件路径（新增 / 修改 / 删除都在内）。
 *
 * 用 `-z` 读：默认格式对含空格的文件名加引号，对重命名写 `old -> new`，
 * 两种都会让路径和真实文件对不上，护栏就可能放错人。
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function gitStatusPaths(cwd) {
  const raw = exec('git', ['status', '--porcelain=v1', '-z'], { cwd, trim: false });
  if (raw === '') return [];

  /** @type {string[]} */
  const paths = [];
  const entries = raw.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.push(path);

    // -z 下重命名 / 复制会多一段「原路径」，跳过它，别把原文件也算成改动。
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths;
}

/**
 * 默认目标分支：优先读 origin/HEAD，读不到就回落 main。
 * @param {string} cwd
 * @returns {string}
 */
function defaultBaseBranch(cwd) {
  try {
    const ref = exec('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
    });
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  } catch {
    // 没有 origin（本地仓库 / 刚 init）时走回落值。
  }
  return 'main';
}

/**
 * 建分支 → 复制测试 → 提交 → 护栏 → push → gh pr create。
 *
 * @param {{
 *   specReport: { dir: string, files: { module: string, file: string, caseIds: string[] }[] },
 *   testsDir: string,
 *   outputDir?: string,
 *   plan: import('../types.mjs').TestCase[],
 *   results: import('../types.mjs').RunResult[],
 *   reportPath: string,
 *   skipped?: { caseId?: string, module?: string, reason: string }[],
 *   cwd?: string,
 *   runId?: string,
 *   base?: string,
 *   title?: string,
 *   body?: string,
 *   logger?: { info?: (message: string) => void },
 * }} options
 * @returns {Promise<{
 *   branch: string,
 *   runId: string,
 *   title: string,
 *   url: string,
 *   files: string[],
 *   commit: string,
 *   skipped: { module: string, reason: string }[],
 * }>}
 * @throws {GuardError} 改动包含 testsDir 之外的文件时抛出（此时还没 push）
 * @throws {PrError} 环境不满足 / git / gh 命令失败 / 没有可提交的测试文件时抛出
 */
export async function createPullRequest(options) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? {};
  const testsDir = options.testsDir;
  // 本工具自己写的产物（inventory / 截图 / report / specs）。如果目标仓库没把 output.dir
  // 加进 .gitignore，它们会出现在 git status 里；这些是产物不是业务改动，不该让 guard 误报。
  const outputDir = options.outputDir;

  // ------------------------------------------------------------ 1. 环境检查
  try {
    exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch (cause) {
    throw new PrError('--pr 需要在 git 仓库里运行', { cause });
  }

  const dirty = gitStatusPaths(cwd).filter((path) => !isInsideDir(path, outputDir));
  if (dirty.length > 0) {
    throw new PrError(
      [
        '工作区不是干净的，--pr 会拒绝继续：',
        ...dirty.map((path) => `  - ${path}`),
        '',
        '先提交或 stash 这些改动，再重新运行。这样 guard 看到的每一处改动',
        '都能确定是本工具产生的，不会把别人的工作顺手带进 PR。',
      ].join('\n'),
    );
  }

  try {
    exec('gh', ['--version'], { cwd });
  } catch (cause) {
    throw new PrError('找不到 gh CLI，--pr 需要它来创建 PR。安装后先跑一次 gh auth login。', {
      cause,
    });
  }

  // ------------------------------------------------------------ 2. 复制测试文件
  const copied = copySpecsIntoTestsDir(options.specReport, { testsDir, cwd });
  if (copied.files.length === 0) {
    throw new PrError(
      copied.skipped.length === 0
        ? '没有生成任何通过的用例，不创建空 PR。'
        : `没有可新增的测试文件：\n${copied.skipped.map((item) => `  - ${item.reason}`).join('\n')}`,
    );
  }

  const runId = options.runId ?? createRunId();
  const branch = branchNameFor(runId);

  // 标题 / 正文只统计真正进了本次提交的 spec 文件：内容相同而跳过、或拒绝覆盖的文件
  // 并没有出现在 PR 里，把它们算进「补了 N 条用例」就是虚报。
  const copiedNames = new Set(
    copied.files.map((path) => path.slice(path.lastIndexOf('/') + 1)),
  );
  const includedFiles = (options.specReport.files ?? []).filter((file) =>
    copiedNames.has(basename(file.file)),
  );

  const title = options.title ?? buildTitle(includedFiles);
  const notGenerated = Array.isArray(options.skipped) ? options.skipped : [];
  const body =
    options.body ??
    buildPullRequestBody({
      plan: options.plan,
      results: options.results,
      specFiles: includedFiles,
      reportPath: options.reportPath,
      skipped: [...notGenerated, ...copied.skipped],
      runId,
    });

  const baseSha = exec('git', ['rev-parse', 'HEAD'], { cwd });
  const base = options.base ?? defaultBaseBranch(cwd);

  // ------------------------------------------------------------ 3. 建分支 + 提交
  exec('git', ['checkout', '-b', branch], { cwd });
  logger.info?.(`已创建分支 ${branch}`);

  // 显式列路径，不用 `git add -A`：只暂存本工具写出来的文件。
  exec('git', ['add', '--', ...copied.files], { cwd });

  // 提交前护栏：工作区里除了刚复制的测试文件，不允许有别的东西。
  assertOnlyTests(
    gitStatusPaths(cwd).filter((path) => !isInsideDir(path, outputDir)),
    testsDir,
  );

  exec('git', ['commit', '-m', title], { cwd });

  // ------------------------------------------------------------ 4. 提交后复核
  const changed = exec('git', ['diff', '--name-only', `${baseSha}..HEAD`], { cwd })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  // 只要这里抛错，下面的 push 就不会执行——这是「先过 guard 才允许 push」的落点。
  const guarded = assertOnlyTests(changed, testsDir);
  logger.info?.(`护栏通过：${guarded.length} 个文件全部在 ${testsDir} 下`);
  if (guarded.length === 0) {
    throw new PrError('提交后没有任何文件改动，已停止（不会 push 空分支）');
  }

  // ------------------------------------------------------------ 5. push + 开 PR
  exec('git', ['push', '-u', 'origin', branch], { cwd });
  logger.info?.(`已推送 ${branch}`);

  const url = exec(
    'gh',
    ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body],
    { cwd },
  );

  return {
    branch,
    runId,
    title,
    url: url.split('\n').filter((line) => line !== '').pop() ?? url,
    files: guarded,
    commit: exec('git', ['rev-parse', '--short', 'HEAD'], { cwd }),
    skipped: copied.skipped,
  };
}
