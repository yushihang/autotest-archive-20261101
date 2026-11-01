/**
 * @file PR diff 护栏：「PR 里只有测试」这条约束的执行点。
 *
 * README 把这条写成产品边界，但边界写在文档里只是口头约定——真正挡住「顺手改了
 * 业务代码」的是这里。所以在 `gh pr create` / `git push` 之前，CLI 把本次改动过的
 * 文件全列出来，交给 assertOnlyTests 判一次：
 *
 *   - 白名单只有 `<testsDir>` 下的文件（默认 `test/`）；
 *   - 新增、修改、删除一视同仁——只看路径，不看 diff 内容；
 *   - 任何业务文件出现在清单里就直接抛错，没有 force / skip / 环境变量开关。
 *
 * 「不允许强制跳过」是刻意的：一旦留了开关，第一个赶时间的人就会打开它，护栏等于没有。
 * 真需要绕过时只能人工改代码，而那就得走 code review。
 */

/** 默认的测试目录。与 src/config.mjs 的 DEFAULT_TESTS_DIR 保持一致（此处不 import，避免循环依赖）。 */
export const DEFAULT_TESTS_DIR = 'test/';

/**
 * 护栏拒绝时的错误。
 *
 * 单独一个类型是为了让调用方（CLI / 创建 PR）能区分「业务文件混进来了」和
 * 「git 命令本身失败」，前者要在 PR 描述和终端里给出完整文件清单。
 */
export class GuardError extends Error {
  /**
   * @param {string} message 人能读懂的原因
   * @param {{ offending?: string[], testsDir?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'GuardError';
    /** @type {string[]} 越界的文件（相对仓库根，`/` 分隔） */
    this.offending = details.offending ?? [];
    /** @type {string} 本次生效的白名单目录（不带结尾 '/'） */
    this.testsDir = details.testsDir ?? '';
  }
}

/**
 * 把路径统一成 git 输出的形状：`/` 分隔、去掉开头的 `./`、折叠重复斜杠。
 *
 * `..` 段在这里直接解析掉（`a/../b` → `b`）；解析后越出仓库根（`../x`）时返回 null，
 * 由调用方当成「不在测试目录里」处理——不能把越界路径悄悄当成仓库内文件。
 *
 * @param {string} value
 * @returns {string | null} 规范化后的相对路径；越出仓库根时为 null
 */
function normalizePath(value) {
  const cleaned = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

  /** @type {string[]} */
  const segments = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join('/');
}

/**
 * 规范化白名单目录：`./test/`、`test`、`test//` 都归一成 `test`。
 *
 * 这里对目录本身也做严格校验。校验松一点（比如允许空串或 `/`）就意味着白名单变成
 * 整个仓库，护栏静默失效——比直接报错难查得多。
 *
 * @param {unknown} testsDir
 * @returns {string} 不带结尾 '/' 的仓库内相对路径
 * @throws {GuardError} 不是仓库内相对路径时抛出
 */
function normalizeTestsDir(testsDir) {
  if (typeof testsDir !== 'string' || testsDir.trim() === '') {
    throw new GuardError('testsDir 必须是非空字符串，例如 "test/"', {
      offending: [],
      testsDir: '',
    });
  }

  const raw = testsDir.trim();
  // 绝对路径（Unix 的 '/'、Windows 的 '\' 与盘符）一律拒绝：白名单只认仓库内路径。
  if (/^[/\\]/.test(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new GuardError(`testsDir 必须是仓库内相对路径，不能用绝对路径：${raw}`, {
      offending: [raw],
      testsDir: '',
    });
  }

  const normalized = normalizePath(raw);
  if (normalized === null || normalized === '') {
    throw new GuardError(`testsDir 不能是仓库根目录或越界路径：${raw}`, {
      offending: [raw],
      testsDir: '',
    });
  }

  return normalized;
}

/**
 * 护栏：改动过的文件必须全部落在 testsDir 下。
 *
 * @param {string[]} changedFiles
 *   相对仓库根的文件路径列表，来源可以是 `git diff --name-only`、`git status --porcelain`
 *   或别处；新增 / 修改 / 删除都在内，函数不关心状态，只关心路径。
 * @param {string} [testsDir] 白名单目录，默认 `test/`；必须是仓库内相对路径
 * @returns {string[]} 通过校验的文件（规范化后的相对路径，保持传入顺序）
 * @throws {GuardError} 有任何文件不在 testsDir 下时抛出，错误里带完整越界清单
 */
export function assertOnlyTests(changedFiles, testsDir = DEFAULT_TESTS_DIR) {
  if (!Array.isArray(changedFiles)) {
    throw new TypeError('assertOnlyTests 需要 changedFiles 数组');
  }

  const dir = normalizeTestsDir(testsDir);
  const prefix = `${dir}/`;

  /** @type {string[]} */
  const allowed = [];
  /** @type {string[]} */
  const offending = [];

  for (const raw of changedFiles) {
    if (typeof raw !== 'string') {
      throw new TypeError(`changedFiles 里的路径必须是字符串，当前是 ${typeof raw}`);
    }
    if (raw.trim() === '') continue;

    const path = normalizePath(raw.trim());
    // 越出仓库根（normalizePath 返回 null）和目录本身都按越界处理：
    // 目录不会被 git 列出来，出现同名文件时也绝不该放行。
    if (path === null || !path.startsWith(prefix)) {
      offending.push(path ?? raw.trim());
      continue;
    }
    allowed.push(path);
  }

  if (offending.length > 0) {
    const list = offending.map((path) => `  - ${path}`).join('\n');
    throw new GuardError(
      [
        `PR 里只能有 ${dir}/ 下的测试文件，但这次改动包含 ${offending.length} 个业务 / 目录外文件：`,
        list,
        '',
        '已中止：不会提交、不会 push。这个护栏没有强制跳过开关，',
        '请把这些改动移出本次任务，或人工确认后另开分支处理。',
      ].join('\n'),
      { offending, testsDir: dir },
    );
  }

  return allowed;
}
