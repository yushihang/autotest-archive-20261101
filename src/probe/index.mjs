/**
 * @file 页面探测：连上目标应用，枚举路由与可交互元素，产出 inventory.json。
 *
 * 探测是整个流水线的第一步，产物 Inventory 是规划器的唯一输入（见 src/types.mjs）：
 * 规划器不重新访问页面，只读 inventory。所以这一层要「够全 + 够确定」：
 *
 * - 够全：选择器不稳定的元素也收，只是标 unstable，交给规划阶段降权；
 * - 够确定：同一份配置重跑，选择器和顺序一致，不依赖随机或时间。
 *
 * 只读边界：这里只做导航和 DOM 读取，不点击、不聚焦、不填表、不触发任何业务动作。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';

import {
  buildSelectorIndex,
  dedupeElements,
  sortByStability,
  toInventoryElement,
} from './selectors.mjs';

/** 产物文件名，固定落在 `<output.dir>/inventory.json`。 */
export const INVENTORY_FILENAME = 'inventory.json';

/** 单页导航 + 采集的超时上限（毫秒）。issue #114 定的 10s。 */
export const DEFAULT_PAGE_TIMEOUT_MS = 10_000;

/** 配置里没有 limits.maxWallMs 时的兜底总预算，与示例配置一致。 */
export const DEFAULT_MAX_WALL_MS = 300_000;

/** 没有配置 target.routes 时默认只探首页。 */
const DEFAULT_ROUTES = Object.freeze(['/']);

/**
 * 探测失败。url 一定是出错的那个地址，便于直接 curl 复现。
 */
export class ProbeError extends Error {
  /**
   * @param {string} message
   * @param {{ url?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProbeError';
    if (options.url !== undefined) {
      /** @type {string} */
      this.url = options.url;
    }
  }
}

/**
 * 探测目标应用，写出 inventory.json 并返回这份 Inventory。
 *
 * @param {import('../config.mjs').AutotestConfig} config 已由 loadConfig 规范化过的配置
 * @param {{
 *   browser?: import('playwright').Browser,
 *   pageTimeoutMs?: number,
 *   cwd?: string,
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 * }} [options]
 *   - browser：复用外部浏览器（此时不负责关闭），方便上层一次任务只起一次浏览器
 *   - pageTimeoutMs：覆盖默认的单页 10s 超时，实际取它与剩余总预算的更小值
 *   - cwd：output.dir 的解析基准，默认当前工作目录
 *   - logger：进度与跳过项的输出口
 * @returns {Promise<import('../types.mjs').Inventory>}
 * @throws {ProbeError} baseUrl 连不上、某个路由打不开、或总预算耗尽时抛出，错误信息带 URL
 */
export async function probe(config, options = {}) {
  const target = readTarget(config);
  const maxWallMs = readMaxWallMs(config);
  const pageTimeoutMs = readPageTimeoutMs(options.pageTimeoutMs);
  const logger = options.logger ?? {};

  const startedAt = Date.now();
  const deadline = startedAt + maxWallMs;

  const ownsBrowser = !options.browser;
  const browser = options.browser ?? (await launchBrowser());

  /** @type {import('playwright').BrowserContext | undefined} */
  let context;

  try {
    try {
      context = await browser.newContext();
    } catch (cause) {
      throw new ProbeError('无法创建浏览器上下文', { cause });
    }

    await assertReachable(context, target.baseUrl, budgetFor(deadline, pageTimeoutMs));

    const page = await context.newPage();
    page.setDefaultTimeout(pageTimeoutMs);

    /** @type {import('../types.mjs').InventoryRoute[]} */
    const routes = [];
    /** @type {import('../types.mjs').InventoryElement[]} */
    const elements = [];

    for (const routePath of target.routes) {
      const url = toUrl(target.baseUrl, routePath);
      const timeout = budgetFor(deadline, pageTimeoutMs);

      logger.info?.(`探测 ${url}`);

      const response = await gotoOrThrow(page, url, timeout, 'load');
      const title = await readTitle(page);

      const facts = await collectFactsFromPage(page, target.origin);

      // 同源限制只作用于链接：外链不是我们要测的目标，也不该跟着跑出去。
      if (facts.skippedExternalLinks > 0) {
        logger.warn?.(
          `${routePath} 跳过 ${facts.skippedExternalLinks} 个外链（与 ${target.origin} 不同源）`,
        );
      }

      const index = buildSelectorIndex(facts.elements);
      const pageElements = facts.elements.map((item) => toInventoryElement(item, routePath, index));

      // 逐个 push 而不是展开：元素多的时候 spread 会撞上参数个数上限。
      for (const element of sortByStability(dedupeElements(pageElements))) {
        elements.push(element);
      }

      /** @type {import('../types.mjs').InventoryRoute} */
      const route = { path: routePath };
      if (response) route.status = response.status();
      if (title !== '') route.title = title;
      routes.push(route);
    }

    /** @type {import('../types.mjs').Inventory} */
    const inventory = {
      baseUrl: target.baseUrl,
      generatedAt: new Date().toISOString(),
      routes,
      elements,
    };

    // output 在配置里是可选的；这里再做一次兜底，避免模块被单独调用时崩在 undefined 上。
    const outputDir = config?.output?.dir ?? 'autotest-output';
    const filePath = resolve(options.cwd ?? process.cwd(), outputDir, INVENTORY_FILENAME);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    logger.info?.(`已写出 ${filePath}（${routes.length} 个路由 / ${elements.length} 个元素）`);

    return inventory;
  } finally {
    if (context) await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

/**
 * 在页面上下文里执行：把可交互元素的事实读出来。
 *
 * 这个函数会被 Playwright 序列化后丢进浏览器，所以不能引用模块作用域里的任何变量，
 * 所有辅助函数都定义在函数体内部。
 *
 * @param {{ baseOrigin: string }} args
 * @returns {{ elements: import('./selectors.mjs').ElementFacts[], skippedExternalLinks: number }}
 */
function collectFacts(args) {
  const { baseOrigin } = args;

  // a[href]：没有 href 的 <a> 不是链接，点不动也跳不走。
  const COLLECT_SELECTOR = 'a[href], button, input, select, textarea, [role]';
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy'];

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function collapse(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * @param {Element} element
   * @returns {{ testId: string, testIdAttr: string }}
   */
  function readTestId(element) {
    for (const attr of TEST_ID_ATTRS) {
      const value = collapse(element.getAttribute(attr));
      if (value !== '') return { testId: value, testIdAttr: attr };
    }
    return { testId: '', testIdAttr: '' };
  }

  /**
   * 显式 role 优先，否则按标签和 input type 推导。推导不出来的返回 'other'。
   * @param {Element} element
   * @returns {string}
   */
  function roleOf(element) {
    const explicit = collapse(element.getAttribute('role'));
    if (explicit !== '') return explicit.split(' ')[0].toLowerCase();

    const tag = element.tagName.toLowerCase();

    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'other';
    if (tag === 'button') return 'button';
    if (tag === 'select') {
      const multiple = /** @type {HTMLSelectElement} */ (element).multiple;
      return multiple ? 'listbox' : 'combobox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (/** @type {HTMLInputElement} */ (element).type || 'text').toLowerCase();
      switch (type) {
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'number':
          return 'spinbutton';
        case 'search':
          return 'searchbox';
        case 'submit':
        case 'button':
        case 'reset':
        case 'image':
          return 'button';
        default:
          return 'textbox';
      }
    }

    return 'other';
  }

  /**
   * 元素种类，决定规划阶段能对它下什么动作。
   * @param {Element} element
   * @param {string} role
   * @returns {string}
   */
  function kindOf(element, role) {
    const tag = element.tagName.toLowerCase();

    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'select' || role === 'listbox') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'form' || role === 'form') return 'form';
    if (tag === 'input') {
      const type = (/** @type {HTMLInputElement} */ (element).type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'input';
    }
    if (role === 'checkbox') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') {
      return 'input';
    }

    return 'other';
  }

  /**
   * 可访问名的近似计算：aria-label → aria-labelledby → <label for> → 包裹的 <label>
   * → placeholder → 按钮的 value → 可见文案 → title。
   * @param {Element} element
   * @returns {string}
   */
  function accessibleNameOf(element) {
    const ariaLabel = collapse(element.getAttribute('aria-label'));
    if (ariaLabel !== '') return ariaLabel;

    const labelledBy = collapse(element.getAttribute('aria-labelledby'));
    if (labelledBy !== '') {
      const text = labelledBy
        .split(' ')
        .map((refId) => collapse(document.getElementById(refId)?.textContent))
        .join(' ');
      if (collapse(text) !== '') return collapse(text);
    }

    const ownId = collapse(element.getAttribute('id'));
    if (ownId !== '') {
      const explicitLabel = Array.from(document.querySelectorAll('label[for]')).find(
        (label) => label.getAttribute('for') === ownId,
      );
      const text = collapse(explicitLabel?.textContent);
      if (text !== '') return text;
    }

    const wrappingLabel = element.closest('label');
    if (wrappingLabel) {
      const text = collapse(wrappingLabel.textContent);
      if (text !== '') return text;
    }

    const placeholder = collapse(element.getAttribute('placeholder'));
    if (placeholder !== '') return placeholder;

    if (element.tagName.toLowerCase() === 'input') {
      const input = /** @type {HTMLInputElement} */ (element);
      const type = (input.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = collapse(input.value);
        if (value !== '') return value;
      }
    }

    const text = collapse(element.textContent);
    if (text !== '') return text;

    return collapse(element.getAttribute('title'));
  }

  /**
   * 可见性：display / visibility / opacity 为 0 或尺寸为 0 的元素点不到，收进来只会污染 inventory。
   * 注意 .sr-only 这类「视觉隐藏但保留在无障碍树里」的元素尺寸是 1px，仍然算可见。
   * @param {Element} element
   * @returns {boolean}
   */
  function isVisible(element) {
    if (element.closest('[hidden]')) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * 兜底选择器：从 <html> 一路 nth-of-type 下来。
   * @param {Element} element
   * @returns {string}
   */
  function domPathOf(element) {
    /** @type {string[]} */
    const parts = [];
    let node = element;

    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;

      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      const index = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      node = parent;
    }

    return ['html', ...parts].join(' > ');
  }

  /**
   * 同源判定：用页面解析后的绝对地址比 origin，相对路径按 document.baseURI 解析。
   * @param {Element} element
   * @returns {boolean}
   */
  function isSameOriginLink(element) {
    let url;
    try {
      url = new URL(element.getAttribute('href') ?? '', document.baseURI);
    } catch {
      return false;
    }
    // javascript: / mailto: / tel: 的 origin 是 'null'，一律当作非探测目标。
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === baseOrigin;
  }

  /** @type {import('./selectors.mjs').ElementFacts[]} */
  const elements = [];
  /** @type {Set<Element>} */
  const seen = new Set();
  let skippedExternalLinks = 0;

  const candidates = /** @type {Element[]} */ (
    Array.from(document.querySelectorAll(COLLECT_SELECTOR))
  );

  for (const element of candidates) {
    if (seen.has(element)) continue;
    seen.add(element);

    const tag = element.tagName.toLowerCase();
    const type =
      tag === 'input'
        ? (/** @type {HTMLInputElement} */ (element).type || 'text').toLowerCase()
        : '';
    if (type === 'hidden') continue;

    if (tag === 'a' && element.hasAttribute('href') && !isSameOriginLink(element)) {
      skippedExternalLinks += 1;
      continue;
    }

    if (!isVisible(element)) continue;

    const role = roleOf(element);
    const { testId, testIdAttr } = readTestId(element);

    elements.push({
      tag,
      testId,
      testIdAttr,
      id: collapse(element.getAttribute('id')),
      attrName: collapse(element.getAttribute('name')),
      role,
      name: accessibleNameOf(element),
      kind: kindOf(element, role),
      path: domPathOf(element),
    });
  }

  return { elements, skippedExternalLinks };
}

/**
 * 只读地确认 baseUrl 连得上。任何 HTTP 状态码都算连上（404 的首页也是活着的服务），
 * 只有网络层失败才报错 —— 这正是「不许静默返回空 inventory」要挡住的情况。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} baseUrl
 * @param {number} timeout
 * @returns {Promise<void>}
 */
async function assertReachable(context, baseUrl, timeout) {
  try {
    await context.request.get(`${baseUrl}/`, { timeout, failOnStatusCode: false });
  } catch (cause) {
    throw new ProbeError(`连不上 ${baseUrl}：目标应用没有响应，先确认它是否在运行`, {
      url: baseUrl,
      cause,
    });
  }
}

/**
 * 起一个 Chromium。用 headless：探测发生在服务器 / CI 上，没有显示器。
 * 超时用 Playwright 的默认值，单页超时在每次导航时单独传。
 *
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (cause) {
    throw new ProbeError(
      '启动 Chromium 失败：确认已安装浏览器（npx playwright install chromium）',
      { cause },
    );
  }
}

/**
 * 导航到目标地址。失败一律转成带 URL 的 ProbeError，不吞异常。
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {number} timeout
 * @param {'load' | 'domcontentloaded'} waitUntil
 * @returns {Promise<import('playwright').Response | null>}
 */
async function gotoOrThrow(page, url, timeout, waitUntil) {
  try {
    const response = await page.goto(url, { timeout, waitUntil });
    // 网络空闲只用来等 SPA 渲染完，等不到也不算错：DOM 已经拿到了。
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    return response;
  } catch (cause) {
    throw new ProbeError(`探测 ${url} 失败：页面打不开或加载超时`, { url, cause });
  }
}

/**
 * 读标题。取不到不算失败（有些页面在导航过程中没有 title）。
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readTitle(page) {
  try {
    return (await page.title()).trim();
  } catch {
    return '';
  }
}

/**
 * 在页面里跑采集脚本。
 * @param {import('playwright').Page} page
 * @param {string} baseOrigin
 * @returns {Promise<{ elements: import('./selectors.mjs').ElementFacts[], skippedExternalLinks: number }>}
 */
async function collectFactsFromPage(page, baseOrigin) {
  return page.evaluate(collectFacts, { baseOrigin });
}

/**
 * 从配置里取 target，缺字段直接报错而不是拿默认值兜底。
 * @param {import('../config.mjs').AutotestConfig} config
 * @returns {{ baseUrl: string, origin: string, routes: string[] }}
 */
function readTarget(config) {
  const target = config?.target;
  if (!target || typeof target !== 'object') {
    throw new ProbeError('配置缺少 target：探测需要 target.baseUrl 和 target.routes');
  }

  const rawBaseUrl = typeof target.baseUrl === 'string' ? target.baseUrl.trim() : '';
  if (rawBaseUrl === '') {
    throw new ProbeError('配置缺少 target.baseUrl：没有目标地址就无从探测');
  }

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch (cause) {
    throw new ProbeError(`target.baseUrl 不是合法 URL：${rawBaseUrl}`, {
      url: rawBaseUrl,
      cause,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProbeError(`target.baseUrl 只支持 http / https，当前是 ${parsed.protocol}`, {
      url: rawBaseUrl,
    });
  }

  // 统一去掉结尾斜杠：拼路由时只在一处加，避免出现 '//login'。
  const baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') || parsed.origin;

  const rawRoutes = Array.isArray(target.routes) ? target.routes : [];
  const routePaths = rawRoutes.length > 0 ? rawRoutes : [...DEFAULT_ROUTES];

  /** @type {string[]} */
  const routes = [];
  for (const route of routePaths) {
    if (typeof route !== 'string' || !route.startsWith('/')) {
      throw new ProbeError(`target.routes 里的路由必须以 '/' 开头，当前是 ${JSON.stringify(route)}`, {
        url: baseUrl,
      });
    }
    if (!routes.includes(route)) routes.push(route);
  }

  return { baseUrl, origin: parsed.origin, routes };
}

/**
 * @param {import('../config.mjs').AutotestConfig} config
 * @returns {number}
 */
function readMaxWallMs(config) {
  const value = config?.limits?.maxWallMs;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_WALL_MS;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readPageTimeoutMs(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_PAGE_TIMEOUT_MS;
}

/**
 * 本轮还剩多少预算，同时不超过单页上限。预算用完就抛错，不静默截断。
 *
 * @param {number} deadline
 * @param {number} pageTimeoutMs
 * @returns {number}
 */
function budgetFor(deadline, pageTimeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ProbeError('探测总时长已超过 limits.maxWallMs，停止并报告，不继续无限重试');
  }
  return Math.min(pageTimeoutMs, remaining);
}

/**
 * baseUrl 与路由拼接：baseUrl 已去掉结尾斜杠，路由一定以 '/' 开头。
 *
 * @param {string} baseUrl
 * @param {string} routePath
 * @returns {string}
 */
function toUrl(baseUrl, routePath) {
  return routePath === '/' ? `${baseUrl}/` : `${baseUrl}${routePath}`;
}
