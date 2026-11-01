#!/usr/bin/env node
/**
 * @file 一条命令把零件串起来：配置 → 探测 → 规划 → 执行 → 生成测试代码 → 报告。
 *
 * 用法：
 *
 *   node src/cli.mjs run --config autotest.config.json            # 默认 dry-run
 *   node src/cli.mjs run --config autotest.config.json --dry-run  # 显式写出来也一样
 *   node src/cli.mjs run --config autotest.config.json --pr       # 建分支、开 PR
 *
 * **默认是 dry-run**：只往 config.output.dir 写 inventory / 截图 / specs / report，
 * 不建分支、不 commit、不 push。这个默认值是刻意的——看到「只写本地」才会有人放心地先跑一遍。
 * `--pr` 是唯一会动 git 的模式，并且在 push 前强制经过 src/pr/guard.mjs。
 *
 * 退出码：
 *   0  全部通过（flaky 不算失败；被跳过的用例原因写在报告里）
 *   1  有 failed / error 结论，或运行被预算中止
 *   2  参数、配置、探测、PR 阶段出错（这类错误不是「用例失败」）
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { writeSpecs } from './generate/specs.mjs';
import { planCases } from './plan/index.mjs';
import { createPullRequest } from './pr/create.mjs';
import { probe } from './probe/index.mjs';
import { renderReport, REPORT_FILENAME } from './report/markdown.mjs';
import { runPlan } from './runner/index.mjs';

/** 退出码常量。 */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  failed: 1,
  error: 2,
});

/** `--help` 的正文。新增参数必须同步写进这里。 */
export const USAGE = `autotest：探测 Web 应用、规划用例、在浏览器里跑，产出测试代码和报告。

用法：
  node src/cli.mjs run --config <path> [--dry-run | --pr]
  node src/cli.mjs --help

参数：
  run                要执行的动作（目前只有 run）
  --config <path>    配置文件路径，必须提供；相对路径按当前工作目录解析
                     也可以写成 --config=<path>
  --dry-run          默认模式：只写本地 output.dir，不建分支、不 commit、不 push
  --pr               建分支 autotest/<runId>、提交生成的测试文件、开 PR；
                     push 前强制通过「PR 里只有测试」护栏，失败即中止
  -h, --help         打印这段说明并退出

示例：
  node src/cli.mjs run --config autotest.config.json
  node src/cli.mjs run --config autotest.config.json --pr

退出码：
  0  全部通过
  1  有用例失败 / 错误，或运行被预算中止
  2  参数、配置、探测或 PR 阶段出错
`;

/** 参数错误：CLI 自己用，和配置错误区分开。 */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * 解析 argv。
 *
 * 不做「猜」：不认识的参数直接报错而不是忽略——`--dryrun` 这种拼写错误被静默忽略，
 * 用户会以为自己在 dry-run，实际却建了分支，这是最不该发生的事。
 *
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {{ mode: 'help' } | { mode: 'run', configPath: string, pr: boolean }}
 * @throws {UsageError} 参数缺失、冲突或无法识别时抛出
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];

  if (args.includes('--help') || args.includes('-h')) return { mode: 'help' };

  const [command, ...rest] = args;
  if (command === undefined) {
    throw new UsageError('缺少动作，用法：node src/cli.mjs run --config <path>');
  }
  if (command !== 'run') {
    throw new UsageError(`不认识的动作：${command}（目前只支持 run）`);
  }

  /** @type {string | undefined} */
  let configPath;
  let dryRun = false;
  let pr = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--pr') {
      pr = true;
      continue;
    }
    if (argument === '--config' || argument.startsWith('--config=')) {
      if (configPath !== undefined) {
        throw new UsageError('--config 只能给一次');
      }
      const value = argument === '--config' ? rest[index + 1] : argument.slice('--config='.length);
      if (argument === '--config') index += 1;
      if (value === undefined || value.trim() === '') {
        throw new UsageError('--config 需要一个文件路径，例如 --config autotest.config.json');
      }
      configPath = value;
      continue;
    }

    throw new UsageError(`不认识的参数：${argument}（用 --help 看全部参数）`);
  }

  if (dryRun && pr) {
    throw new UsageError('--dry-run 与 --pr 互斥：要么只看本地产物，要么真的开 PR');
  }
  if (configPath === undefined) {
    throw new UsageError('缺少 --config，例如：node src/cli.mjs run --config autotest.config.json');
  }

  // 默认 dry-run：只有显式 --pr 才会碰 git。
  return { mode: 'run', configPath, pr: pr && !dryRun };
}

/**
 * 按契约里的 RunStatus 计数。未知状态不静默丢掉，计入 `other`。
 * @param {import('./types.mjs').RunResult[]} results
 * @returns {{ passed: number, failed: number, flaky: number, error: number, other: number, total: number }}
 */
export function countStatuses(results) {
  /** @type {Record<string, number>} */
  const counts = { passed: 0, failed: 0, flaky: 0, error: 0, other: 0 };
  const list = Array.isArray(results) ? results : [];

  for (const result of list) {
    const status = result?.status;
    if (status === 'passed' || status === 'failed' || status === 'flaky' || status === 'error') {
      counts[status] += 1;
    } else {
      counts.other += 1;
    }
  }

  return { ...counts, total: list.length };
}

/**
 * 跑完整条流水线。返回结构化结果，打印交给调用方。
 *
 * @param {{
 *   configPath: string,
 *   pr?: boolean,
 *   cwd?: string,
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 *   now?: () => Date,
 * }} options
 * @returns {Promise<{
 *   config: import('./config.mjs').AutotestConfig,
 *   inventory: import('./types.mjs').Inventory,
 *   plan: import('./types.mjs').TestCase[],
 *   results: import('./types.mjs').RunResult[],
 *   specs: { dir: string, files: { module: string, file: string, caseIds: string[] }[], cases: number, skipped: unknown[], unmatched: string[] },
 *   reportPath: string,
 *   counts: ReturnType<typeof countStatuses>,
 *   skipped: number,
 *   aborted: boolean,
 *   elapsedMs: number,
 *   pullRequest: Awaited<ReturnType<typeof createPullRequest>> | null,
 * }>}
 */
export async function runAutotest(options) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? {};
  const pr = options.pr === true;
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();

  const step = (index, text) => logger.info?.(`[${index}/6] ${text}`);

  step(1, `读取配置 ${options.configPath}`);
  const config = loadConfig(resolve(cwd, options.configPath));

  step(2, `探测 ${config.target.baseUrl}（${config.target.routes.length} 个路由）`);
  const inventory = await probe(config, { cwd, logger });

  step(3, '规划用例');
  const plan = planCases(inventory, config.limits);
  logger.info?.(`  规划出 ${plan.length} 条用例`);

  step(4, `执行 ${plan.length} 条用例（每条重复 ${config.runner.repeat} 次）`);
  const results = await runPlan(plan, {
    baseUrl: config.target.baseUrl,
    repeat: config.runner.repeat,
    limits: config.limits,
    output: { dir: config.output.dir },
    cwd,
  });

  step(5, '生成测试代码');
  const specs = writeSpecs(plan, results, config.output.dir, {
    baseUrl: config.target.baseUrl,
    cwd,
  });
  logger.info?.(`  ${specs.files.length} 个 spec 文件 / ${specs.cases} 条用例`);

  step(6, '渲染报告');
  const reportPath = resolve(cwd, config.output.dir, REPORT_FILENAME);
  renderReport(plan, results, {
    output: { dir: config.output.dir },
    cwd,
    baseUrl: config.target.baseUrl,
    startedAt: now().toISOString(),
  });

  const counts = countStatuses(results);
  const elapsedMs = Date.now() - startedAt;
  const aborted = results.aborted === true;
  const skipped = Array.isArray(results.skipped) ? results.skipped.length : 0;

  const summary = {
    config,
    inventory,
    plan,
    results,
    specs,
    reportPath,
    counts,
    skipped,
    aborted,
    elapsedMs,
    pullRequest: null,
  };

  if (pr) {
    logger.info?.('创建分支并提交测试文件（push 前会先过 guard）');
    try {
      summary.pullRequest = await createPullRequest({
        specReport: specs,
        testsDir: config.testsDir,
        outputDir: config.output.dir,
        plan,
        results,
        reportPath,
        skipped: specs.skipped,
        cwd,
        logger,
      });
    } catch (cause) {
      // PR 阶段失败不该把已经跑完的结果吞掉：先给出报告与计数，再抛错退出。
      for (const line of formatSummary(summary, { pr: true })) logger.info?.(line);
      logger.info?.('  PR：未创建（失败原因见下面的错误）');
      throw cause;
    }
  }

  return summary;
}

/**
 * 人读的收尾摘要：报告路径、通过 / 失败 / flaky 计数、耗时。
 *
 * @param {Awaited<ReturnType<typeof runAutotest>>} summary
 * @param {{ pr: boolean, logger?: { info?: (message: string) => void } }} options
 * @returns {string[]} 逐行输出
 */
export function formatSummary(summary, options) {
  const { counts } = summary;
  const seconds = (summary.elapsedMs / 1000).toFixed(1);
  const lines = [];

  lines.push('');
  lines.push(`完成：${counts.total} 条用例，耗时 ${seconds}s（${summary.elapsedMs} ms）`);
  lines.push(
    `  通过 ${counts.passed} / 失败 ${counts.failed} / flaky ${counts.flaky} / 错误 ${counts.error}` +
      (counts.other > 0 ? ` / 未知状态 ${counts.other}` : '') +
      (summary.skipped > 0 ? `（跳过 ${summary.skipped} 条，原因见报告）` : ''),
  );

  if (summary.aborted) {
    lines.push('  ⚠ 运行被预算中止：结果不完整，报告里写明了停在哪一步');
  }

  lines.push(`  报告：${summary.reportPath}`);

  if (options.pr) {
    if (summary.pullRequest) {
      lines.push(`  PR：${summary.pullRequest.url}`);
      lines.push(`  分支：${summary.pullRequest.branch}（commit ${summary.pullRequest.commit}）`);
    }
  } else {
    lines.push(`  dry-run：测试代码在 ${summary.specs.dir}；未创建分支、未提交、未推送`);
  }

  return lines;
}

/**
 * CLI 入口。返回进程退出码，方便单测直接调。
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, logger?: { info?: Function, warn?: Function, error?: Function } }} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  const logger = options.logger ?? console;

  /** @type {ReturnType<typeof parseArgs>} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error?.(`✗ ${message}`);
    logger.error?.(USAGE);
    return EXIT_CODES.error;
  }

  if (args.mode === 'help') {
    logger.info?.(USAGE);
    return EXIT_CODES.ok;
  }

  try {
    const summary = await runAutotest({
      configPath: args.configPath,
      pr: args.pr,
      cwd: options.cwd,
      logger,
    });

    for (const line of formatSummary(summary, { pr: args.pr })) logger.info?.(line);

    const failed = summary.counts.failed + summary.counts.error + summary.counts.other;
    if (failed > 0 || summary.aborted) return EXIT_CODES.failed;
    return EXIT_CODES.ok;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error?.(`✗ ${message}`);
    return EXIT_CODES.error;
  }
}

// 只有被 `node src/cli.mjs` 直接执行时才跑；被 import 时（测试、别的脚本）只拿函数。
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
