/**
 * @file 配置的读取与校验。
 *
 * 配置是一份 JSON（示例见仓库根目录 autotest.config.example.json），
 * 由各模块共用：探测需要 target，规划需要 limits，执行需要 runner 和 output。
 * 所有字段在这里一次校验完，下游模块拿到的一定是规范化后的值，不再各自兜底。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** testsDir 的默认值：生成的测试文件落盘目录。 */
export const DEFAULT_TESTS_DIR = 'test/';

/** output.dir 的默认值：产物（报告、截图、inventory）落盘目录。 */
export const DEFAULT_OUTPUT_DIR = 'autotest-output';

/**
 * baseUrl 与路由拼接：baseUrl 已去掉结尾 '/'（见 normalizeBaseUrl），路由以 '/' 开头。
 *
 * 探测与执行必须共用这一处拼接。不能用 `new URL(route, baseUrl)`：它按 origin 解析根相对
 * 路径，会把 baseUrl 的路径前缀整段丢掉（`https://example.com/app` + `/login` 变成
 * `https://example.com/login`），挂在子路径下的应用会被打开到错误页面。
 *
 * @param {string} baseUrl 站点根地址，不带结尾 '/'
 * @param {string} routePath 以 '/' 开头的路由
 * @returns {string}
 */
export function joinUrl(baseUrl, routePath) {
  return routePath === '/' ? `${baseUrl}/` : `${baseUrl}${routePath}`;
}

/**
 * 各层允许出现的字段。多写一个键就报错，避免拼写错误被静默忽略。
 * @type {readonly string[]}
 */
const TOP_LEVEL_KEYS = ['target', 'limits', 'runner', 'output', 'testsDir'];
/** @type {readonly string[]} */
const TARGET_KEYS = ['baseUrl', 'routes'];
/** @type {readonly string[]} */
const LIMITS_KEYS = ['maxCases', 'maxWallMs', 'maxSteps'];
/** @type {readonly string[]} */
const RUNNER_KEYS = ['repeat'];
/** @type {readonly string[]} */
const OUTPUT_KEYS = ['dir'];

/**
 * 配置错误。field 一定是出错字段的点路径，例如 'limits.maxCases'、'target.routes[0]'。
 */
export class ConfigError extends Error {
  /**
   * @param {string} field 出错的字段路径
   * @param {string} reason 人能读懂的原因
   * @param {{ cause?: unknown }} [options]
   */
  constructor(field, reason, options) {
    super(`配置错误${field ? ` [${field}]` : ''}：${reason}`, options);
    this.name = 'ConfigError';
    this.field = field;
  }
}

/**
 * @typedef {object} TargetConfig 被测应用
 * @property {string} baseUrl 站点根地址，不带结尾 '/'
 * @property {string[]} routes 要探测的路由，以 '/' 开头、已去重
 *
 * @typedef {object} LimitsConfig 成本上限（超了必须停并报告，不许无限试错）
 * @property {number} maxCases 单次任务最多生成多少条用例
 * @property {number} maxWallMs 单次任务的总时长上限（毫秒）
 * @property {number} maxSteps 单条用例最多多少步
 *
 * @typedef {object} RunnerConfig 执行器
 * @property {number} repeat 每条用例跑几次用于判 flaky（>= 1）
 *
 * @typedef {object} OutputConfig 产物
 * @property {string} dir 报告 / 截图 / inventory 的落盘目录，仓库内相对路径，不带结尾 '/'
 *
 * @typedef {object} AutotestConfig 规范化后的配置
 * @property {TargetConfig} target
 * @property {LimitsConfig} limits
 * @property {RunnerConfig} runner
 * @property {OutputConfig} output
 * @property {string} testsDir 生成的测试文件落盘目录，仓库内相对路径，以 '/' 结尾
 */

/**
 * 读取配置文件并返回规范化后的配置。
 *
 * @param {string} path 配置文件路径，相对路径按当前工作目录解析
 * @returns {AutotestConfig}
 * @throws {ConfigError} 文件读不到、不是合法 JSON、或字段缺失 / 类型不对时抛出，错误信息带字段名
 */
export function loadConfig(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ConfigError('config', '必须提供配置文件路径，例如 autotest.config.json');
  }

  const filePath = resolve(path.trim());

  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    const code = /** @type {{ code?: string }} */ (cause).code ?? '未知错误';
    throw new ConfigError('config', `读不到配置文件 ${filePath}（${code}）`, { cause });
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError('config', `${filePath} 不是合法 JSON（${/** @type {Error} */ (cause).message}）`, {
      cause,
    });
  }

  return normalizeConfig(parsed);
}

/**
 * 校验并规范化一份已经解析好的配置对象。
 * 单独导出是为了让测试和自己造配置的调用方不必写临时文件。
 *
 * @param {unknown} input
 * @returns {AutotestConfig}
 * @throws {ConfigError} 字段缺失、类型不对、取值越界或出现未知字段时抛出
 */
export function normalizeConfig(input) {
  if (!isPlainObject(input)) {
    throw new ConfigError('config', `根节点必须是 JSON 对象，当前是 ${describe(input)}`);
  }

  // 未知字段一律报错：拼错的可选字段（testsdir / outp）会被静默忽略并回落到默认值，
  // 而 testsDir 和 output.dir 决定文件写到哪里，跑偏了比直接报错难查得多。
  rejectUnknownKeys(input, '', TOP_LEVEL_KEYS);
  rejectUnknownKeys(requireObject(input, 'target'), 'target', TARGET_KEYS);
  rejectUnknownKeys(requireObject(input, 'limits'), 'limits', LIMITS_KEYS);
  rejectUnknownKeys(requireObject(input, 'runner'), 'runner', RUNNER_KEYS);

  const baseUrl = normalizeBaseUrl('target.baseUrl', readString(input, 'target.baseUrl'));
  const routes = normalizeRoutes(readStringArray(input, 'target.routes'));

  const maxCases = readInt(input, 'limits.maxCases', 1);
  const maxWallMs = readInt(input, 'limits.maxWallMs', 1);
  const maxSteps = readInt(input, 'limits.maxSteps', 1);
  const repeat = readInt(input, 'runner.repeat', 1);

  // output 整体可以不写，此时 output.dir 走默认值；写了就必须是对象。
  const outputNode = getIn(input, 'output');
  if (outputNode !== undefined) {
    if (!isPlainObject(outputNode)) {
      throw new ConfigError('output', `必须是对象，当前是 ${describe(outputNode)}`);
    }
    rejectUnknownKeys(outputNode, 'output', OUTPUT_KEYS);
  }
  const outputDir = normalizeDir(
    'output.dir',
    readString(input, 'output.dir', DEFAULT_OUTPUT_DIR),
    { keepTrailingSlash: false },
  );

  const testsDir = normalizeDir(
    'testsDir',
    readString(input, 'testsDir', DEFAULT_TESTS_DIR),
    { keepTrailingSlash: true },
  );

  return {
    target: { baseUrl, routes },
    limits: { maxCases, maxWallMs, maxSteps },
    runner: { repeat },
    output: { dir: outputDir },
    testsDir,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 给人看的类型描述，用在错误信息里。
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `字符串 "${value}"`;
  return `${typeof value} ${String(value)}`;
}

/**
 * 按 'a.b' 取嵌套字段，中间缺一层就返回 undefined。
 * @param {unknown} root
 * @param {string} field
 * @returns {unknown}
 */
function getIn(root, field) {
  return field.split('.').reduce(
    (current, key) => (isPlainObject(current) ? current[key] : undefined),
    /** @type {unknown} */ (root),
  );
}

/**
 * 拒绝白名单之外的字段。field 为空串时表示根节点。
 * @param {Record<string, any>} node
 * @param {string} field 当前对象的字段路径，根节点传 ''
 * @param {readonly string[]} allowed 允许出现的字段
 * @returns {void}
 */
function rejectUnknownKeys(node, field, allowed) {
  for (const key of Object.keys(node)) {
    if (allowed.includes(key)) continue;
    const path = field === '' ? key : `${field}.${key}`;
    const scope = field === '' ? '' : `${field} 下`;
    throw new ConfigError(path, `未知字段（${scope}只支持 ${allowed.join(' / ')}）`);
  }
}

/**
 * @param {Record<string, any>} root
 * @param {string} field
 * @returns {Record<string, any>}
 */
function requireObject(root, field) {
  const value = getIn(root, field);
  if (value === undefined) {
    throw new ConfigError(field, '缺少必填字段（应为对象）');
  }
  if (!isPlainObject(value)) {
    throw new ConfigError(field, `必须是对象，当前是 ${describe(value)}`);
  }
  return value;
}

/**
 * @param {Record<string, any>} root
 * @param {string} field
 * @param {string} [fallback] 缺字段时使用的默认值
 * @returns {string}
 */
function readString(root, field, fallback) {
  const value = getIn(root, field);
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(field, '缺少必填字段');
  }
  if (typeof value !== 'string') {
    throw new ConfigError(field, `必须是字符串，当前是 ${describe(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ConfigError(field, '不能是空字符串');
  }
  return trimmed;
}

/**
 * @param {Record<string, any>} root
 * @param {string} field
 * @param {number} min 允许的最小值（含）
 * @returns {number}
 */
function readInt(root, field, min) {
  const value = getIn(root, field);
  if (value === undefined) {
    throw new ConfigError(field, '缺少必填字段');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(field, `必须是数字，当前是 ${describe(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new ConfigError(field, `必须是整数，当前是 ${value}`);
  }
  if (value < min) {
    throw new ConfigError(field, `必须 >= ${min}，当前是 ${value}`);
  }
  return value;
}

/**
 * @param {Record<string, any>} root
 * @param {string} field
 * @returns {string[]}
 */
function readStringArray(root, field) {
  const value = getIn(root, field);
  if (value === undefined) {
    throw new ConfigError(field, '缺少必填字段');
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(field, `必须是数组，当前是 ${describe(value)}`);
  }
  if (value.length === 0) {
    throw new ConfigError(field, '不能是空数组，至少写一条路由');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new ConfigError(`${field}[${index}]`, `必须是字符串，当前是 ${describe(item)}`);
    }
    return item;
  });
}

/**
 * @param {string} field
 * @param {string} raw
 * @returns {string}
 */
function normalizeBaseUrl(field, raw) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new ConfigError(field, `不是合法 URL：${raw}`, { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(field, `只支持 http / https，当前是 ${url.protocol}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(field, '不能带查询串或 hash，具体路由写在 target.routes 里');
  }
  // URL 会把根路径补成 '/'，统一去掉结尾斜杠，拼接路由时只在一处加。
  return url.toString().replace(/\/+$/, '');
}

/**
 * 校验并去重路由，保留原顺序。
 * @param {string[]} routes
 * @returns {string[]}
 */
function normalizeRoutes(routes) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const normalized = [];

  routes.forEach((route, index) => {
    const field = `target.routes[${index}]`;
    const trimmed = route.trim();
    if (trimmed === '') {
      throw new ConfigError(field, '不能是空字符串');
    }
    if (!trimmed.startsWith('/')) {
      throw new ConfigError(field, `必须以 '/' 开头，当前是 "${trimmed}"`);
    }
    if (trimmed.includes('#')) {
      throw new ConfigError(field, `不能带 hash 片段，当前是 "${trimmed}"`);
    }
    const withoutTrailingSlash = trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '');
    if (seen.has(withoutTrailingSlash)) return;
    seen.add(withoutTrailingSlash);
    normalized.push(withoutTrailingSlash);
  });

  return normalized;
}

/**
 * 目录规范化：去掉开头的 './'，结尾斜杠按 keepTrailingSlash 统一。
 *
 * 只接受仓库内的相对路径。生成的测试文件会落到这个目录里，而这个工具的边界是
 * 「只加测试文件、不碰别处」，所以 '/etc/foo' 和 '../x' 这类会写到仓库外的路径必须拒绝，
 * 不能把这条边界交给配置拼写。
 *
 * @param {string} field
 * @param {string} raw
 * @param {{ keepTrailingSlash: boolean }} options
 * @returns {string}
 */
function normalizeDir(field, raw, options) {
  const cleaned = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned === '.') {
    throw new ConfigError(field, `不能是根目录或当前目录，当前是 "${raw}"`);
  }
  // 绝对路径：Unix 的 '/'、Windows 的 '\' 和 'C:' 盘符都算。
  if (/^[/\\]/.test(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new ConfigError(field, `必须是仓库内的相对路径，不能用绝对路径，当前是 "${raw}"`);
  }
  if (cleaned.split(/[/\\]+/).includes('..')) {
    throw new ConfigError(field, `不能包含 '..' 段（会写到仓库外），当前是 "${raw}"`);
  }
  return options.keepTrailingSlash ? `${cleaned}/` : cleaned;
}
