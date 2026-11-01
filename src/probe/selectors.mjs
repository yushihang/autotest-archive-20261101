/**
 * @file 选择器生成与稳定性判定（纯函数）。
 *
 * 这里不碰 DOM、不碰 Playwright：输入是从页面里取回的元素事实（Plain Object），
 * 输出是选择器和稳定性判断。抽出来的目的是这两件事最容易出错，单独放一处便于推理和单测。
 *
 * 选择器优先级（issue #114）：data-testid → #id → [name=] → role+name。
 * 四种都取不到的（无测试 id、无 id、无 name、无可用 role）退回 DOM 路径选择器，
 * 并标记 unstable —— 不唯一不等于该丢，规划阶段可以降权，但探测阶段不许静默丢元素。
 */

/**
 * 选择器来源，按优先级从高到低。
 * @typedef {'testid' | 'id' | 'name' | 'role' | 'path'} SelectorSource
 */

/**
 * 从页面里取回的一个元素事实，字段与 DOM 一一对应。
 *
 * @typedef {object} ElementFacts
 * @property {string} tag 标签名（小写）
 * @property {string} [testId] 测试 id 的值（data-testid / data-test-id / data-test / data-cy）
 * @property {string} [testIdAttr] 测试 id 来自哪个属性，缺省按 'data-testid' 处理
 * @property {string} [id] 元素的 id 属性
 * @property {string} [attrName] 表单控件的 name 属性（不是可访问名）
 * @property {string} [role] ARIA role，显式 role 属性或按标签推导
 * @property {string} [name] 可访问名（可见文案 / label / aria-label，已折叠空白）
 * @property {string} [kind] 元素种类，页面侧推导，这里只做白名单校验
 * @property {string} [path] DOM 路径选择器，最后兜底用
 */

/**
 * 选择器及其来源。
 * @typedef {object} BuiltSelector
 * @property {string} selector 可直接交给 Playwright locator 的选择器字符串
 * @property {SelectorSource} source 选择器来自哪一层
 */

/**
 * 同页出现次数索引，用来判断选择器唯一性。
 *
 * @typedef {object} SelectorIndex
 * @property {Map<string, number>} testIds 每个测试 id 出现次数
 * @property {Map<string, number>} ids 每个 id 出现次数
 * @property {Map<string, number>} names 每个 name 属性出现次数
 * @property {Map<string, number>} roleNames 每个 role+name 组合出现次数
 * @property {Map<string, number>} selectors 每个生成出来的选择器出现次数
 */

/** 选择器优先级顺序，导出给调用方做展示或排序用。 */
export const SELECTOR_PRIORITY = Object.freeze(['testid', 'id', 'name', 'role', 'path']);

/**
 * 元素种类白名单，与 src/types.mjs 的 ElementKind 对齐。
 * @type {ReadonlySet<string>}
 */
const ELEMENT_KINDS = new Set([
  'link',
  'button',
  'input',
  'select',
  'textarea',
  'checkbox',
  'radio',
  'form',
  'other',
]);

/**
 * 标准 ARIA role。只有在这个集合里的 role 才拿来拼 role+name 选择器：
 * 页面写了 role="foo" 这种非标准值时，role 选择器在 Playwright 里定位不到。
 * @type {ReadonlySet<string>}
 */
const KNOWN_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

/**
 * 看起来像自动生成、会随构建或重渲染变化的 id 特征。
 *
 * 判定偏保守（宁可多标 unstable）：漏标会变成跑两次结果不一致的 flaky 用例，
 * 多标只是让规划阶段少挑它，代价小得多。
 * @type {readonly RegExp[]}
 */
const GENERATED_ID_PATTERNS = Object.freeze([
  /^\d+$/, // 1、2、3：自增 id
  /^:.+:$/, // :r0:、:R2m:：React useId
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{10,}$/i, // 纯 hash
  /[-_:]\d{2,}$/, // input-12、row_42、item:7
  /\d{4,}/, // 含 4 位以上数字：时间戳、递增序号
]);

/**
 * 折叠空白：可访问名和 role+name 的 key 都必须先规范化，否则「登录」和「登录 」会被当成两个元素。
 * @param {unknown} value
 * @returns {string}
 */
export function collapseWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 转义 CSS 属性选择器里的字符串值：`[name="a\"b"]`。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttributeValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ');
}

/**
 * 转义 CSS 标识符（用于 `#id`），按 CSS Syntax 的字符规则实现最小版本。
 * 不依赖浏览器的 CSS.escape，Node 里没有。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeIdentifier(value) {
  /** @type {string[]} */
  const chars = [...String(value ?? '')];
  /** @type {string[]} */
  const out = [];

  chars.forEach((char, index) => {
    const code = /** @type {number} */ (char.codePointAt(0));

    if (code === 0) {
      out.push('\ufffd');
      return;
    }

    const isDigit = code >= 0x30 && code <= 0x39;
    const isAsciiLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isControl = (code >= 0x01 && code <= 0x1f) || code === 0x7f;
    const isNameChar = isDigit || isAsciiLetter || char === '-' || char === '_' || code >= 0x80;

    // 开头是数字，或 '-' 后面跟数字，必须写成十六进制转义，否则不是合法标识符。
    if ((index === 0 && isDigit) || (index === 1 && isDigit && chars[0] === '-')) {
      out.push(`\\${code.toString(16)} `);
      return;
    }

    if (index === 0 && char === '-' && chars.length === 1) {
      out.push('\\-');
      return;
    }

    if (isControl) {
      out.push(`\\${code.toString(16)} `);
      return;
    }

    out.push(isNameChar ? char : `\\${char}`);
  });

  return out.join('');
}

/**
 * 判断一个 id / name 是否明显是自动生成的。
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksGeneratedId(value) {
  const text = collapseWhitespace(value);
  if (text === '') return false;
  return GENERATED_ID_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * role+name 的分组 key。空 name 也参与分组：同页多个无名 button 互相之间就是不唯一的。
 * @param {ElementFacts} facts
 * @returns {string}
 */
export function roleNameKey(facts) {
  const role = collapseWhitespace(facts?.role).toLowerCase();
  const name = collapseWhitespace(facts?.name);
  return `${role}\u0000${name}`;
}

/**
 * 生成选择器。纯函数，不做唯一性判断。
 *
 * @param {ElementFacts} facts
 * @returns {BuiltSelector}
 */
export function buildSelector(facts) {
  const testId = collapseWhitespace(facts?.testId);
  if (testId !== '') {
    const attr = collapseWhitespace(facts?.testIdAttr) || 'data-testid';
    return { selector: `[${attr}="${escapeAttributeValue(testId)}"]`, source: 'testid' };
  }

  const id = collapseWhitespace(facts?.id);
  if (id !== '') {
    return { selector: `#${escapeIdentifier(id)}`, source: 'id' };
  }

  const attrName = collapseWhitespace(facts?.attrName);
  if (attrName !== '') {
    return { selector: `[name="${escapeAttributeValue(attrName)}"]`, source: 'name' };
  }

  const role = collapseWhitespace(facts?.role).toLowerCase();
  const name = collapseWhitespace(facts?.name);
  if (KNOWN_ROLES.has(role)) {
    if (name !== '') {
      // Playwright 的 role 选择器：name 用引号包起来并按字符串转义，i 表示不区分大小写。
      return { selector: `role=${role}[name="${escapeAttributeValue(name)}"i]`, source: 'role' };
    }
    return { selector: `role=${role}`, source: 'role' };
  }

  // 兜底：DOM 路径。退而求其次，但仍然给出一个能用的选择器，不把元素丢掉。
  const fallback = collapseWhitespace(facts?.path) || collapseWhitespace(facts?.tag) || '*';
  return { selector: fallback, source: 'path' };
}

/**
 * 统计同页各种 key 的出现次数，供唯一性判断使用。
 *
 * @param {ElementFacts[]} factsList
 * @returns {SelectorIndex}
 */
export function buildSelectorIndex(factsList) {
  /** @type {SelectorIndex} */
  const index = {
    testIds: new Map(),
    ids: new Map(),
    names: new Map(),
    roleNames: new Map(),
    selectors: new Map(),
  };

  for (const facts of Array.isArray(factsList) ? factsList : []) {
    bump(index.testIds, collapseWhitespace(facts?.testId));
    bump(index.ids, collapseWhitespace(facts?.id));
    bump(index.names, collapseWhitespace(facts?.attrName));
    bump(index.roleNames, roleNameKey(facts));
    bump(index.selectors, buildSelector(facts).selector);
  }

  return index;
}

/**
 * 选择器是否不稳定（会随时间 / 构建 / 重渲染变化，或不能唯一命中）。
 *
 * 规则来自 issue #114：
 * - 生成出来的选择器在同一页里命中多个元素 → 不稳定（无法唯一定位）；
 * - 有 data-testid → 稳定，除非重复；
 * - 有 id → 稳定，除非 id 看起来是自增 / hash；
 * - 有 name → 稳定，除非 `[name=]` 重复；
 * - 只能靠 role+name → 同页 role+name 重名就不稳定；
 * - DOM 路径 → 一定不稳定。
 *
 * 注：有 name 属性的元素用的是 `[name=]`，此时是否稳定由 name 自身唯一性决定，
 * 不再看 role+name —— 否则「同一个 label 文案下的两个不同 name 输入框」会被误判。
 *
 * @param {ElementFacts} facts
 * @param {SelectorSource} source
 * @param {string} selector
 * @param {SelectorIndex} index
 * @returns {boolean}
 */
export function isUnstableSelector(facts, source, selector, index) {
  if ((index?.selectors?.get(selector) ?? 0) > 1) return true;

  switch (source) {
    case 'testid':
      return false;
    case 'id':
      return looksGeneratedId(facts?.id);
    case 'name':
      return false;
    case 'role':
      return (index?.roleNames?.get(roleNameKey(facts)) ?? 0) > 1;
    default:
      return true;
  }
}

/**
 * 把元素事实变成 Inventory.elements 里的一条。
 *
 * @param {ElementFacts} facts
 * @param {string} page 该元素所在的路由
 * @param {SelectorIndex} index
 * @returns {import('../types.mjs').InventoryElement}
 */
export function toInventoryElement(facts, page, index) {
  const { selector, source } = buildSelector(facts);

  /** @type {import('../types.mjs').InventoryElement} */
  const element = {
    selector,
    role: normalizeRole(facts?.role),
    name: collapseWhitespace(facts?.name),
    kind: normalizeKind(facts?.kind),
    page,
  };

  // 契约里 unstable 是可选项：稳定就不写这个字段，别用 false 占位。
  if (isUnstableSelector(facts, source, selector, index)) {
    element.unstable = true;
  }

  return element;
}

/**
 * 按 (page, selector) 去重，保留第一次出现的顺序。
 *
 * @param {import('../types.mjs').InventoryElement[]} elements
 * @returns {import('../types.mjs').InventoryElement[]}
 */
export function dedupeElements(elements) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {import('../types.mjs').InventoryElement[]} */
  const unique = [];

  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element.selector !== 'string') continue;
    const key = `${element.page}\u0000${element.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(element);
  }

  return unique;
}

/**
 * 降权：把不稳定的元素排到同页稳定元素之后，其余保持原顺序。
 * 排序是稳定的，同一页多次探测得到的顺序一致。
 *
 * @param {import('../types.mjs').InventoryElement[]} elements
 * @returns {import('../types.mjs').InventoryElement[]}
 */
export function sortByStability(elements) {
  return (Array.isArray(elements) ? elements : [])
    .map((element, order) => ({ element, order }))
    .sort(
      (a, b) =>
        Number(Boolean(a.element?.unstable)) - Number(Boolean(b.element?.unstable)) ||
        a.order - b.order,
    )
    .map((entry) => entry.element);
}

/**
 * 同页出现次数 +1。空 key 不统计：空字符串不是有意义的唯一性维度。
 * @param {Map<string, number>} map
 * @param {string} key
 */
function bump(map, key) {
  if (key === '') return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRole(value) {
  const role = collapseWhitespace(value).toLowerCase();
  return role === '' ? 'other' : role;
}

/**
 * @param {unknown} value
 * @returns {import('../types.mjs').ElementKind}
 */
function normalizeKind(value) {
  const kind = collapseWhitespace(value).toLowerCase();
  return /** @type {import('../types.mjs').ElementKind} */ (
    ELEMENT_KINDS.has(kind) ? kind : 'other'
  );
}
