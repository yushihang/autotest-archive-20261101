/**
 * @file 测试代码的模板与转义：TestCase → `@playwright/test` spec 源码。
 *
 * 这里只有纯函数：不读时间、不读环境、不遍历无序集合，同一条用例每次渲染出的字节
 * 完全一致。生成器（specs.mjs）负责选用例、分模块、落盘；排版和转义全在这里，
 * 免得「引号转义写在两个地方，一个改了另一个忘」。
 *
 * 断言原则：`expect` 必须能证伪。
 *   - 每条用例先断言打开后的地址；
 *   - 每个动作前断言目标元素可见，动作后断言它能被观察到的结果（值 / 勾选态 / 可见性）；
 *   - 用例末尾断言页面没有未捕获异常——执行器正是用这条信号判定 passing，
 *     生成出来的测试必须守同一条不变量，不能只断言一个标题就算过。
 * 因此这里不会、也不允许生成「空断言」或「只断言页面标题」的用例。
 */

/** 生成 spec 时的默认站点地址。与 autotest.config.example.json 保持一致。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';

/** 单引号字符串里必须转义的字符。 */
const STRING_ESCAPES = Object.freeze({
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\f': '\\f',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

/**
 * 转义单引号字符串的内容（不含两侧引号）。
 * 控制字符统一走 `\xNN`，避免生成的文件里混进真实的换行 / 不可见字符。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeString(value) {
  return String(value ?? '').replace(
    // eslint-disable-next-line no-control-regex
    /[\\'\n\r\t\v\f\u0000-\u001f\u2028\u2029]/g,
    (char) => {
      const mapped = STRING_ESCAPES[char];
      if (mapped) return mapped;
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    },
  );
}

/**
 * 把一个值写成 JS 单引号字符串字面量。
 * @param {unknown} value
 * @returns {string}
 */
export function quote(value) {
  return `'${escapeString(value)}'`;
}

/**
 * 把一段文字转成正则源码：所有元字符都转义，匹配的是字面量本身。
 * 产物交给 `new RegExp(...)`，不拼 `/.../` 字面量，所以 `/` 不必转义。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeRegExpSource(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 生成一个 `new RegExp('...')` 表达式。
 *
 * 不生成 `/.../` 字面量：地址片段里可能带 `/`、`?`、`\`，拼进正则字面量要同时处理
 * 分隔符和已有转义，很容易写出 `/\\/a/` 这种坏代码。构造器只需要一次字符串转义，
 * 正则源码原样交给 RegExp，行为可预期。
 *
 * @param {unknown} source 正则源码
 * @param {string} [flags]
 * @returns {string}
 */
export function regexExpression(source, flags = '') {
  return `new RegExp(${flags ? `${quote(source)}, ${quote(flags)}` : quote(source)})`;
}

/**
 * 极简模板：只替换 `{{name}}`，缺值就抛错。
 * 宁可生成失败，也不要悄悄留下一个 `{{header}}` 在产物里。
 *
 * @param {string} source
 * @param {Record<string, string>} slots
 * @returns {string}
 */
export function renderTemplate(source, slots) {
  return source.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(slots, name)) {
      throw new Error(`模板占位符缺少取值：${name}`);
    }
    return String(slots[name]);
  });
}

/**
 * 注释里的单行文本：换行会截断 `//`，必须压平。
 * @param {unknown} value
 * @returns {string}
 */
function commentText(value) {
  return String(value ?? '')
    // `//` 只能覆盖一行；\r、\n、U+2028/2029 在 JS 里都是换行，全部压平。
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 路由 → 可直接放进 URL 断言的 pattern：匹配路径结尾，允许 query / hash。
 * 路由按字面量转义，`/a.b` 不会把 `.` 变成通配符。
 * @param {string} pagePath
 * @returns {string}
 */
function urlPattern(pagePath) {
  return `${escapeRegExpSource(pagePath)}(?:[?#].*)?$`;
}

/**
 * 把一步翻成注释里的一句话。只用于可读性，不参与执行。
 * @param {import('./types.mjs').TestStep} step
 * @returns {string}
 */
function stepLabel(step) {
  const target = typeof step.target === 'string' ? step.target : '(缺少 target)';
  const value = typeof step.value === 'string' ? step.value : '';

  switch (step.action) {
    case 'goto':
      return `打开 ${step.page ?? '/'}`;
    case 'click':
      return `点击 ${target}`;
    case 'fill':
      return `在 ${target} 填入 ${JSON.stringify(value)}`;
    case 'press':
      return `在 ${target} 按 ${value === '' ? '(缺少按键)' : value}`;
    case 'select':
      return `在 ${target} 选择 ${JSON.stringify(value)}`;
    case 'check':
      return `勾选 ${target}`;
    case 'uncheck':
      return `取消勾选 ${target}`;
    case 'waitFor':
      return `等待 ${target} 进入 ${step.waitState ?? 'visible'} 状态`;
    default:
      return `${String(step.action)} ${target}`.trim();
  }
}

/**
 * 渲染一条 TestCase 对应的一个 `test()` 块。
 *
 * @param {import('./types.mjs').TestCase} testCase
 * @returns {string}
 */
export function renderSpecCase(testCase) {
  if (!testCase || typeof testCase !== 'object') {
    throw new Error('renderSpecCase 需要一条 TestCase');
  }

  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  if (steps.length === 0) {
    throw new Error(`用例 ${testCase.id ?? '(无 id)'} 没有步骤，拒绝生成空测试`);
  }
  if (typeof testCase.title !== 'string' || testCase.title.trim() === '') {
    throw new Error(`用例 ${testCase.id ?? '(无 id)'} 没有标题`);
  }

  /** @type {Map<string, string>} 选择器 → 变量名，首次出现时声明 */
  const locators = new Map();

  /**
   * @param {string} selector
   * @returns {{ name: string, declaration: string | null }}
   */
  function useLocator(selector) {
    const existing = locators.get(selector);
    if (existing) return { name: existing, declaration: null };
    const name = `el${locators.size}`;
    locators.set(selector, name);
    return { name, declaration: `const ${name} = page.locator(${quote(selector)});` };
  }

  /**
   * @param {import('./types.mjs').TestStep} step
   * @returns {string}
   */
  function targetOf(step) {
    if (typeof step.target !== 'string' || step.target.trim() === '') {
      throw new Error(`用例 ${testCase.id} 的 ${step.action} 步骤缺少 target，无法生成断言`);
    }
    return step.target;
  }

  /** @type {string[]} */
  const lines = [
    `test(${quote(testCase.title)}, async ({ page }) => {`,
    `  // 用例：${commentText(testCase.id)}（${commentText(testCase.priority)}）`,
  ];

  const expectations = Array.isArray(testCase.expect)
    ? testCase.expect.map(commentText).filter(Boolean)
    : [];
  if (expectations.length > 0) {
    lines.push(`  // 期望：${expectations.join('；')}`);
  }

  lines.push(
    '  const pageErrors = [];',
    "  page.on('pageerror', (error) => pageErrors.push(error.message));",
    '',
  );

  for (const step of steps) {
    if (!step || typeof step.action !== 'string') {
      throw new Error(`用例 ${testCase.id} 含无效步骤`);
    }

    lines.push(`  // ${commentText(stepLabel(step))}`);

    switch (step.action) {
      case 'goto': {
        const pagePath = typeof step.page === 'string' && step.page !== '' ? step.page : '/';
        lines.push(`  await page.goto(BASE_URL + ${quote(pagePath)});`);
        lines.push(`  await expect(page).toHaveURL(${regexExpression(urlPattern(pagePath))});`);
        break;
      }

      case 'click': {
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.click();`);
        break;
      }

      case 'fill': {
        const value = typeof step.value === 'string' ? step.value : '';
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.fill(${quote(value)});`);
        lines.push(`  await expect(${name}).toHaveValue(${quote(value)});`);
        break;
      }

      case 'press': {
        const key = typeof step.value === 'string' && step.value !== '' ? step.value : 'Enter';
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.press(${quote(key)});`);
        break;
      }

      case 'select': {
        const value = typeof step.value === 'string' ? step.value : '';
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.selectOption(${quote(value)});`);
        // 选完再把选中值读回来：只调用不校验，等于没断言。
        lines.push(`  await expect(${name}).toHaveValue(${quote(value)});`);
        break;
      }

      case 'check': {
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.check();`);
        lines.push(`  await expect(${name}).toBeChecked();`);
        break;
      }

      case 'uncheck': {
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(`  await expect(${name}).toBeVisible();`);
        lines.push(`  await ${name}.uncheck();`);
        lines.push(`  await expect(${name}).not.toBeChecked();`);
        break;
      }

      case 'waitFor': {
        const state = typeof step.waitState === 'string' ? step.waitState : 'visible';
        if (state === 'url') {
          const value = typeof step.value === 'string' && step.value !== '' ? step.value : null;
          if (value === null) {
            throw new Error(`用例 ${testCase.id} 的 waitFor/url 步骤缺少 value`);
          }
          lines.push(`  await expect(page).toHaveURL(${regexExpression(value)});`);
          break;
        }
        if (state === 'networkidle') {
          lines.push("  await page.waitForLoadState('networkidle');");
          // waitForLoadState 本身不产生断言，补一条可证伪的就绪检查。
          lines.push(
            "  await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');",
          );
          break;
        }
        const { name, declaration } = useLocator(targetOf(step));
        if (declaration) lines.push(`  ${declaration}`);
        lines.push(
          state === 'hidden'
            ? `  await expect(${name}).toBeHidden();`
            : `  await expect(${name}).toBeVisible();`,
        );
        break;
      }

      default:
        throw new Error(`用例 ${testCase.id} 含不支持的动作：${String(step.action)}`);
    }

    lines.push('');
  }

  // 与执行器判定 passing 的信号保持一致：页面不能有未捕获异常。
  lines.push('  // 执行器把未捕获异常当成失败，这里守住同一条不变量。');
  lines.push("  expect(pageErrors, '页面不应出现未捕获异常').toEqual([]);");
  lines.push('});');

  return lines.join('\n');
}

const SPEC_FILE_TEMPLATE = `{{header}}

import { expect, test } from '@playwright/test';

// 目标站点根地址（不带结尾 '/'）。pipeline 没传的话用 AUTOTEST_BASE_URL 覆盖。
const BASE_URL = (process.env.AUTOTEST_BASE_URL ?? {{baseUrl}}).replace(/\\/+$/, '');

{{tests}}
`;

/**
 * 渲染一个模块的 spec 文件。文件头写明来源与用例 id，方便 reviewer 回溯到报告。
 *
 * @param {{
 *   module: string,
 *   baseUrl: string,
 *   cases: import('./types.mjs').TestCase[],
 * }} input
 * @returns {string}
 */
export function renderSpecFile({ module, baseUrl, cases }) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('renderSpecFile 至少需要一条用例');
  }

  const ids = cases.map((testCase) => commentText(testCase?.id ?? '(无 id)'));
  const header = [
    '// 本文件由 autotest 自动生成，重新运行会覆盖；请改生成器，不要手改这里。',
    '// 来源：autotest 规划 + 执行结果，只包含执行结论为 passed 的用例。',
    `// 模块：${commentText(module)}`,
    `// 用例：${ids.join(', ')}`,
  ].join('\n');

  const tests = cases.map(renderSpecCase).join('\n\n');

  return renderTemplate(SPEC_FILE_TEMPLATE, {
    header,
    baseUrl: quote(baseUrl),
    tests,
  });
}
