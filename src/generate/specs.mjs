/**
 * @file 生成测试代码：通过的 TestCase → `<outDir>/specs/<module>.spec.mjs`。
 *
 * 只生成「执行结论为 passed」的用例。failed / flaky / error 不写进代码：
 *   - failed / error 进 Markdown 报告，交给人判断是业务 bug 还是用例写错；
 *   - flaky 单独归类，混进测试代码只会让 CI 时红时绿。
 * 这条筛选没有开关：自动 PR 里不允许出现「跑不过的用例」。
 *
 * 「模块」= 用例打开的路由（`goto` 步骤的 page）。`/` 记为 root，`/user/profile`
 * 记为 user-profile，中文等无法转写的路径用稳定哈希兜底（page-xxxxxxxx），
 * 保证同名路由永远落到同一个文件，也不会因为路径里有 `../` 写到目录外面。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { casesOf, resultsOf, runMetaOf } from '../views.mjs';
import { DEFAULT_BASE_URL, renderSpecCase, renderSpecFile } from './template.mjs';

/** spec 落盘子目录名。 */
export const SPECS_DIRNAME = 'specs';

/**
 * 文件名片段：只保留 ASCII 字母数字，其余折叠成 `-`。
 * 中文等非 ASCII 路径全部折叠后为空，再用稳定哈希区分，避免 `/登录` 和 `/注册`
 * 都变成同一个文件。
 *
 * @param {string} text
 * @returns {string}
 */
function slugOfText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * FNV-1a（32 位）。只用来给无法转写的路由取稳定文件名，不做安全用途。
 * @param {string} text
 * @returns {string}
 */
function stableHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 用例所属模块（= 文件名的前半段）。取第一条 `goto` 的 page。
 * @param {import('../types.mjs').TestCase} testCase
 * @returns {string}
 */
export function moduleNameOf(testCase) {
  const steps = Array.isArray(testCase?.steps) ? testCase.steps : [];
  const goto = steps.find((step) => step?.action === 'goto');
  const pagePath = typeof goto?.page === 'string' && goto.page !== '' ? goto.page : '/';

  const slug = slugOfText(pagePath);
  if (slug !== '') return slug;
  if (pagePath === '/') return 'root';
  return `page-${stableHash(pagePath)}`;
}

/**
 * 生成结果：写出的文件清单 + 没写的原因。
 * 报告只读 RunResult，所以这里也把筛掉的原因交还给调用方，方便 CLI 打印。
 *
 * @typedef {object} SpecFile
 * @property {string} module 模块名（文件名前半段）
 * @property {string} file 相对 outDir 的路径，统一用 `/`：`specs/<module>.spec.mjs`
 * @property {string[]} caseIds 文件内的用例 id，保持计划顺序
 */

/**
 * @typedef {object} WriteSpecsReport
 * @property {string} dir specs 目录的绝对路径；没有通过的用例时不创建目录
 * @property {SpecFile[]} files 已写出的文件，按模块名排序
 * @property {number} cases 写进代码的用例总数
 * @property {Array<{ caseId: string, reason: string }>} skipped 计划内但没有生成的用例
 * @property {string[]} unmatched 有 passed 结果、但计划里找不到对应用例的 id
 */

/**
 * 把通过的用例写成 Playwright spec。
 *
 * 同步写盘：一次任务最多几十个小文件，没必要让调用方为几个 `writeFile` 加一层 await；
 * 而且同步写能保证「返回时文件已经在磁盘上」，测试和 CLI 都好断言。
 *
 * @param {import('../types.mjs').TestCase[] | { cases: import('../types.mjs').TestCase[], dropped?: string[] }} plan
 * @param {import('../types.mjs').RunResult[] | { results: import('../types.mjs').RunResult[] }} results
 * @param {string} outDir 产物根目录（`output.dir`）
 * @param {{ baseUrl?: string, cwd?: string }} [options]
 * @returns {WriteSpecsReport}
 */
export function writeSpecs(plan, results, outDir, options = {}) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new Error('writeSpecs 需要 outDir（config 里的 output.dir）');
  }

  const cases = casesOf(plan);
  const run = runMetaOf(results);
  const baseUrl =
    typeof options.baseUrl === 'string' && options.baseUrl !== ''
      ? options.baseUrl
      : run.baseUrl ?? DEFAULT_BASE_URL;

  /** @type {Map<string, string>} caseId → 汇总结论；同一 id 出现多次时以最后一条为准 */
  const statusById = new Map();
  for (const result of resultsOf(results)) {
    if (typeof result.caseId === 'string') statusById.set(result.caseId, result.status);
  }

  /** @type {Map<string, import('../types.mjs').TestCase[]>} 模块 → 用例，保持计划顺序 */
  const grouped = new Map();
  /** @type {Array<{ caseId: string, reason: string }>} */
  const skipped = [];
  const plannedIds = new Set();

  for (const testCase of cases) {
    if (typeof testCase.id !== 'string' || testCase.id === '') continue;
    if (plannedIds.has(testCase.id)) continue;
    plannedIds.add(testCase.id);

    if (statusById.get(testCase.id) !== 'passed') {
      const status = statusById.get(testCase.id);
      skipped.push({
        caseId: testCase.id,
        reason:
          status === undefined
            ? '没有执行结果（未执行或结果缺失）'
            : `执行结论为 ${status}，只生成 passed`,
      });
      continue;
    }

    const module = moduleNameOf(testCase);
    const group = grouped.get(module);
    if (group) group.push(testCase);
    else grouped.set(module, [testCase]);
  }

  const unmatched = [...statusById.keys()]
    .filter((caseId) => statusById.get(caseId) === 'passed' && !plannedIds.has(caseId))
    .sort();

  const cwd = options.cwd ?? process.cwd();
  const specsDir = resolve(cwd, outDir, SPECS_DIRNAME);
  /** @type {SpecFile[]} */
  const files = [];

  // 模块名排序，不受 Map 插入顺序影响；用例保持计划顺序（已按优先级排好）。
  for (const module of [...grouped.keys()].sort()) {
    const moduleCases = grouped.get(module);

    // 先逐条试渲染：一条用例有无法映射的动作时只跳过它自己，不拖垮同模块的其余用例。
    /** @type {import('../types.mjs').TestCase[]} */
    const renderable = [];
    for (const testCase of moduleCases) {
      try {
        renderSpecCase(testCase);
        renderable.push(testCase);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        skipped.push({ caseId: testCase.id, reason: `生成失败：${message}` });
      }
    }
    if (renderable.length === 0) continue;

    const content = renderSpecFile({ module, baseUrl, cases: renderable });

    if (files.length === 0) mkdirSync(specsDir, { recursive: true });
    const fileName = `${module}.spec.mjs`;
    writeFileSync(join(specsDir, fileName), content, 'utf8');
    files.push({
      module,
      file: `${SPECS_DIRNAME}/${fileName}`,
      caseIds: renderable.map((testCase) => testCase.id),
    });
  }

  return {
    dir: specsDir,
    files,
    cases: files.reduce((sum, file) => sum + file.caseIds.length, 0),
    skipped,
    unmatched,
  };
}
