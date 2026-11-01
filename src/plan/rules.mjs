/**
 * @file 规划规则表：把「元素 kind + 页面语义」翻译成候选行为与边界条件。
 *
 * 这里是规划阶段唯一需要读懂业务常识的地方：
 *   - 页面语义（登录 / 列表 / 过滤器）决定优先级，而不是元素 kind 单独决定；
 *   - 基础行为（点链接、填输入框、提交表单）与边界条件（空输入、纯空格、超长、
 *     重复添加、删除最后一项、勾选后过滤）分开描述；
 *   - 每条规则必须给出至少一条人可读的 expect，否则 index.mjs 会直接丢弃该候选。
 *
 * 新增或调整规则只改这个文件，不要动 index.mjs。规则是纯数据 + 纯函数，
 * 不读文件、不发请求、不使用随机数或当前时间。
 */

import { PRIORITIES } from '../types.mjs';

/** @type {readonly string[]} 优先级从高到低。 */
export const PRIORITY_ORDER = PRIORITIES;

/** @type {Readonly<Record<string, number>>} 排序用：P0 最小。 */
export const PRIORITY_RANK = Object.freeze(
  Object.fromEntries(PRIORITIES.map((priority, index) => [priority, index])),
);

/** 超长输入的阈值：题目约定 > 200 字符算超长。 */
export const MAX_INPUT_LENGTH = 200;

/** 超长输入用例实际填入的值，固定 201 个 'A'，保证可复现。 */
export const LONG_INPUT_VALUE = 'A'.repeat(MAX_INPUT_LENGTH + 1);

/**
 * @typedef {'login' | 'list' | 'filters' | 'generic'} PageSemantic
 */

/**
 * 规则函数拿到的上下文。
 * @typedef {object} PlanContext
 * @property {import('../types.mjs').InventoryElement} element 当前元素
 * @property {PageSemantic} semantic 当前元素所属页面的语义
 * @property {import('../types.mjs').InventoryElement[]} siblings 同一页面上的全部元素
 * @property {import('../types.mjs').InventoryRoute | undefined} route 元素所在路由
 * @property {number} index 元素在 Inventory.elements 里的下标
 */

/**
 * 一条规则。priority / title / steps / expect 都是 (ctx) => ... 的纯函数；
 * when 省略表示对所有元素生效，但通常由 kind 表或边界规则自身限制。
 *
 * @typedef {object} PlanRule
 * @property {string} id 稳定的行为 id，用于拼 TestCase.id
 * @property {string | ((ctx: PlanContext) => string)} [dedupeAction]
 *   去重键里的 action；省略时取步骤里的第一个非 goto 动作
 * @property {(ctx: PlanContext) => boolean} [when]
 * @property {(ctx: PlanContext) => import('../types.mjs').Priority} priority
 * @property {(ctx: PlanContext) => string} title
 * @property {(ctx: PlanContext) => import('../types.mjs').TestStep[]} steps
 * @property {(ctx: PlanContext) => string[]} expect
 */

/** 登录页面的关键词。 */
const LOGIN_TOKENS = Object.freeze([
  'login',
  'signin',
  'sign-in',
  'sign in',
  'log in',
  'auth',
  'email',
  'e-mail',
  'password',
  'passwd',
  '密码',
  '邮箱',
  '登录',
  '登入',
  '凭据',
]);

/** 过滤器的关键词。 */
const FILTER_TOKENS = Object.freeze([
  'filter',
  'filters',
  '筛选',
  '过滤',
  '全部',
  '未完成',
  '已完成',
  'all',
  'active',
  'completed',
]);

/** 列表 / 待办的关键词。 */
const LIST_TOKENS = Object.freeze([
  'todo',
  'task',
  'item',
  'list',
  '待办',
  '任务',
  '列表',
  '添加',
  '新增',
  '删除',
  '移除',
  '完成',
  '勾选',
  '标记',
]);

/** input 标签上这些 type 不是文本输入，不生成 fill 用例。 */
const NON_TEXT_INPUT_TYPE =
  /\[type\s*=\s*["']?(checkbox|radio|submit|button|reset|file|range|color|hidden|image)\b/i;

/**
 * 元素自身的可匹配文本：名称、选择器、role。全部转小写，保证匹配与大小写无关。
 * @param {import('../types.mjs').InventoryElement | undefined} element
 * @returns {string}
 */
function tokensOf(element) {
  return `${element?.name ?? ''} ${element?.selector ?? ''} ${element?.role ?? ''}`.toLowerCase();
}

/**
 * 关键词匹配。英文 token 按单词边界匹配，避免 'all' 命中 'install'、
 * 'auth' 命中 'author'；中文 token 两侧本身就是非字母数字，等同于包含匹配。
 * @param {string} haystack
 * @param {readonly string[]} needles
 * @returns {boolean}
 */
function hasAny(haystack, needles) {
  return needles.some((needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
  });
}

/**
 * 元素的可读名称。名称取不到时退回选择器，保证标题不会为空。
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {string}
 */
export function labelOf(element) {
  const name = String(element?.name ?? '').trim();
  if (name) return name;
  const selector = String(element?.selector ?? '').trim();
  return selector || '元素';
}

/**
 * 判断元素属于哪种页面语义。页面路径优先，其次看元素自身的文案 / 选择器。
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {PageSemantic}
 */
export function detectSemantic(element) {
  const page = String(element?.page ?? '').toLowerCase();

  if (/(^|\/)(login|signin|sign-in|auth)(\/|$)/.test(page)) return 'login';
  if (/(^|\/)(todos?|tasks?|items?|list)(\/|$)/.test(page)) return 'list';
  if (/filter/.test(page)) return 'filters';

  const own = tokensOf(element);
  if (hasAny(own, LOGIN_TOKENS)) return 'login';
  if (hasAny(own, FILTER_TOKENS)) return 'filters';
  if (hasAny(own, LIST_TOKENS)) return 'list';
  return 'generic';
}

/**
 * 把元素变成稳定、可读的 id 片段。
 * 优先用英文名称；中文名称或空名称则从选择器里提取 id / data-testid / name 等。
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {string}
 */
export function slugOf(element) {
  const name = String(element?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (name) return name;

  const selector = String(element?.selector ?? '');
  /** @type {RegExp[]} */
  const patterns = [
    /#([a-z0-9_-]+)/i,
    /\[data-testid\s*=\s*["']?([a-z0-9_-]+)/i,
    /\[data-test\s*=\s*["']?([a-z0-9_-]+)/i,
    /\[data-filter\s*=\s*["']?([a-z0-9_-]+)/i,
    /\[name\s*=\s*["']?([a-z0-9_-]+)/i,
    /\[aria-label\s*=\s*["']?([a-z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(selector);
    if (match) return match[1].toLowerCase();
  }

  return String(element?.kind ?? 'element').toLowerCase();
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isTextEntry(element) {
  if (!element) return false;
  if (element.kind !== 'input' && element.kind !== 'textarea') return false;
  if (NON_TEXT_INPUT_TYPE.test(String(element.selector ?? ''))) return false;
  if (/checkbox|radio|button|slider|switch/i.test(String(element.role ?? ''))) return false;
  return true;
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isToggle(element) {
  if (!element) return false;
  if (element.kind === 'checkbox' || element.kind === 'radio') return true;
  return /\[type\s*=\s*["']?(checkbox|radio)\b/i.test(String(element.selector ?? ''));
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isPasswordField(element) {
  return hasAny(tokensOf(element), ['password', 'passwd', '密码']);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isEmailField(element) {
  return hasAny(tokensOf(element), ['email', 'e-mail', '邮箱']);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isSubmit(element) {
  if (element?.kind !== 'button') return false;
  return hasAny(tokensOf(element), [
    'submit',
    'login',
    'sign in',
    'sign-in',
    'log in',
    '登录',
    '登入',
    '提交',
    '保存',
    '确认',
    '确定',
    'send',
  ]);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isAdd(element) {
  if (element?.kind !== 'button') return false;
  return hasAny(tokensOf(element), ['add', 'create', 'insert', '添加', '新增', '创建']);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isDelete(element) {
  if (element?.kind !== 'button') return false;
  return hasAny(tokensOf(element), [
    'delete',
    'remove',
    'trash',
    'clear',
    '删除',
    '移除',
    '清空',
  ]);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @param {PageSemantic} [semantic]
 * @returns {boolean}
 */
export function isFilterButton(element, semantic) {
  if (element?.kind !== 'button') return false;
  if (semantic === 'filters') return true;
  return hasAny(tokensOf(element), FILTER_TOKENS);
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {boolean}
 */
export function isCompletedFilter(element) {
  return hasAny(tokensOf(element), ['completed', '已完成', 'done']);
}

/**
 * 生成一个固定的、不涉及真实数据的输入值。
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {string}
 */
export function sampleValue(element) {
  const tokens = tokensOf(element);
  if (hasAny(tokens, ['password', 'passwd', '密码'])) return 'Passw0rd!test';
  if (hasAny(tokens, ['email', 'e-mail', '邮箱'])) return 'tester@example.com';
  if (hasAny(tokens, ['search', '搜索', '查询'])) return '测试搜索';
  if (hasAny(tokens, ['todo', 'task', '待办', '任务', '列表'])) return '测试待办';
  if (hasAny(tokens, ['user', 'name', '姓名', '用户名'])) return 'tester';
  return '测试输入';
}

/**
 * 同一页面的全部元素。siblings 缺失时至少包含元素自身，规则仍然可运行。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement[]}
 */
function pageElements(ctx) {
  return Array.isArray(ctx.siblings) && ctx.siblings.length > 0
    ? ctx.siblings
    : [ctx.element];
}

/**
 * 同页面、排除自己的元素。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement[]}
 */
function otherSiblings(ctx) {
  const self = ctx.element?.selector;
  return pageElements(ctx).filter((element) => element.selector !== self);
}

/**
 * @param {PlanContext} ctx
 * @param {(element: import('../types.mjs').InventoryElement) => boolean} predicate
 * @returns {boolean}
 */
function isFirstMatching(ctx, predicate) {
  const first = pageElements(ctx).find(predicate);
  return Boolean(first && first.selector === ctx.element.selector);
}

/**
 * 登录表单里的文本字段。找不到邮箱 / 密码时退回页面前两个文本字段，
 * 这样通用的「用户名 + 密码」表单也能生成主路径用例。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement[]}
 */
export function loginFields(ctx) {
  const fields = pageElements(ctx).filter(isTextEntry);
  const loginish = fields.filter((element) => isEmailField(element) || isPasswordField(element));
  return loginish.length > 0 ? loginish : fields.slice(0, 2);
}

/**
 * 当前元素若是登录字段，返回同一表单里「其它」登录字段，用于在边界用例里
 * 只把被测字段留空 / 填空格，其它字段保持有效。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement[]}
 */
function otherLoginFields(ctx) {
  if (ctx.semantic !== 'login' && !isEmailField(ctx.element) && !isPasswordField(ctx.element)) {
    return [];
  }
  return loginFields(ctx).filter((element) => element.selector !== ctx.element.selector);
}

/**
 * 列表新增流程里的输入框：排除邮箱 / 密码，避免在登录页误配。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement | null}
 */
export function findAddInput(ctx) {
  return (
    otherSiblings(ctx).find(
      (element) =>
        isTextEntry(element) && !isEmailField(element) && !isPasswordField(element),
    ) ?? null
  );
}

/**
 * 当前输入框是否存在「输入 + 添加按钮」的流程。
 * @param {PlanContext} ctx
 * @returns {boolean}
 */
function hasAddFlow(ctx) {
  if (!isTextEntry(ctx.element)) return false;
  if (isEmailField(ctx.element) || isPasswordField(ctx.element)) return false;
  return otherSiblings(ctx).some(isAdd);
}

/**
 * 边界用例里的触发按钮：登录字段找提交按钮，列表字段找添加按钮。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement | null}
 */
export function findTriggerFor(ctx) {
  const buttons = otherSiblings(ctx).filter((element) => element.kind === 'button');
  const submit = buttons.find(isSubmit) ?? null;
  const add = buttons.find(isAdd) ?? null;

  if (ctx.semantic === 'login' || isEmailField(ctx.element) || isPasswordField(ctx.element)) {
    return submit;
  }
  if (ctx.semantic === 'list') {
    return (
      add ??
      buttons.find(
        (element) => !isFilterButton(element, ctx.semantic) && !isSubmit(element),
      ) ??
      null
    );
  }
  return submit ?? add;
}

/**
 * 勾选后过滤边界用到的过滤器：优先「已完成」，否则页面上第一个过滤器。
 * @param {PlanContext} ctx
 * @returns {import('../types.mjs').InventoryElement | null}
 */
function findFilterForCheck(ctx) {
  const filters = pageElements(ctx).filter((element) =>
    isFilterButton(element, ctx.semantic),
  );
  return filters.find(isCompletedFilter) ?? filters[0] ?? null;
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @param {string} value
 * @returns {import('../types.mjs').TestStep}
 */
function fillStep(element, value) {
  return { action: 'fill', target: element.selector, value };
}

/**
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {import('../types.mjs').TestStep}
 */
function clickStep(element) {
  return { action: 'click', target: element.selector };
}

/**
 * 主路径提交：填完登录字段再点提交按钮。
 * @param {PlanContext} ctx
 * @param {import('../types.mjs').InventoryElement} submitter
 * @returns {import('../types.mjs').TestStep[]}
 */
function submitFlowSteps(ctx, submitter) {
  const fills = loginFields(ctx).map((element) => fillStep(element, sampleValue(element)));
  return [...fills, clickStep(submitter)];
}

/**
 * 边界输入的步骤：其它字段填有效值，被测字段填边界值，再触发提交 / 添加。
 * @param {PlanContext} ctx
 * @param {string} value
 * @returns {import('../types.mjs').TestStep[]}
 */
function boundaryFillSteps(ctx, value) {
  const steps = otherLoginFields(ctx).map((element) =>
    fillStep(element, sampleValue(element)),
  );
  steps.push(fillStep(ctx.element, value));
  const trigger = findTriggerFor(ctx);
  if (trigger) steps.push(clickStep(trigger));
  return steps;
}

/** @type {PlanRule} */
const LINK_RULE = Object.freeze({
  id: 'follow',
  dedupeAction: 'click',
  priority: (ctx) => (ctx.semantic === 'login' ? 'P1' : 'P2'),
  title: (ctx) => `点击链接「${labelOf(ctx.element)}」并等待页面加载`,
  steps: (ctx) => [
    clickStep(ctx.element),
    { action: 'waitFor', waitState: 'networkidle' },
  ],
  expect: (ctx) => [
    `链接「${labelOf(ctx.element)}」可点击并完成跳转`,
    '跳转后的页面能正常加载，不出现 4xx / 5xx 或空白页',
  ],
});

/** @type {PlanRule} */
const BUTTON_RULE = Object.freeze({
  id: 'activate',
  dedupeAction: 'click',
  priority: (ctx) => {
    if (isSubmit(ctx.element)) return 'P0';
    if (isAdd(ctx.element) || isDelete(ctx.element)) return 'P1';
    if (isFilterButton(ctx.element, ctx.semantic)) return 'P2';
    return 'P2';
  },
  title: (ctx) => {
    const name = labelOf(ctx.element);
    if (isSubmit(ctx.element)) return `提交主路径：点击「${name}」`;
    if (isAdd(ctx.element)) return `新增一项：输入内容后点击「${name}」`;
    if (isDelete(ctx.element)) return `删除列表项：点击「${name}」`;
    if (isFilterButton(ctx.element, ctx.semantic)) return `切换过滤器：点击「${name}」`;
    return `点击按钮「${name}」`;
  },
  steps: (ctx) => {
    const element = ctx.element;
    if (isSubmit(element)) return submitFlowSteps(ctx, element);
    if (isAdd(element)) {
      const input = findAddInput(ctx);
      return [
        ...(input ? [fillStep(input, sampleValue(input))] : []),
        clickStep(element),
      ];
    }
    return [clickStep(element)];
  },
  expect: (ctx) => {
    const name = labelOf(ctx.element);
    if (isSubmit(ctx.element)) {
      return [
        `填写有效输入后点击「${name}」，主流程完成并进入下一状态`,
        '提交过程中页面没有未捕获错误，失败时给出可读提示',
      ];
    }
    if (isAdd(ctx.element)) {
      return [
        `点击「${name}」后列表新增一项，可见项数量加一`,
        '新增项内容与输入一致，列表没有重复渲染',
      ];
    }
    if (isDelete(ctx.element)) {
      return [
        `点击「${name}」后对应列表项被移除`,
        '其余列表项保持不变，页面没有报错',
      ];
    }
    if (isFilterButton(ctx.element, ctx.semantic)) {
      return [
        `点击「${name}」后列表只显示符合该过滤条件的项`,
        '过滤器的选中态与列表内容一致',
      ];
    }
    return [
      `点击「${name}」后有可观察的响应（跳转、弹层或状态变化）`,
      '页面不出现报错或空白',
    ];
  },
});

/** @type {PlanRule} */
const INPUT_RULE = Object.freeze({
  id: 'fill',
  dedupeAction: 'fill',
  when: (ctx) => isTextEntry(ctx.element),
  priority: (ctx) => {
    if (isEmailField(ctx.element) || isPasswordField(ctx.element)) return 'P0';
    return ctx.semantic === 'list' ? 'P1' : 'P2';
  },
  title: (ctx) => `输入合法内容：「${labelOf(ctx.element)}」`,
  steps: (ctx) => [fillStep(ctx.element, sampleValue(ctx.element))],
  expect: (ctx) => {
    if (isEmailField(ctx.element) || isPasswordField(ctx.element)) {
      return [
        `「${labelOf(ctx.element)}」可以输入并保留非空值`,
        '输入内容被完整接收，没有丢失字符',
      ];
    }
    if (ctx.semantic === 'list') {
      return [
        `在「${labelOf(ctx.element)}」输入内容后，输入框保留该文本`,
        '输入不触发页面报错或意外提交',
      ];
    }
    return [
      `「${labelOf(ctx.element)}」可以输入合法值`,
      '输入后控件状态正常，页面没有报错',
    ];
  },
});

/** @type {PlanRule} */
const TEXTAREA_RULE = Object.freeze({
  ...INPUT_RULE,
  priority: (ctx) => (ctx.semantic === 'list' ? 'P1' : 'P2'),
  title: (ctx) => `输入多行内容：「${labelOf(ctx.element)}」`,
  steps: (ctx) => [fillStep(ctx.element, `${sampleValue(ctx.element)}\n第二行`)],
  expect: (ctx) => [
    `「${labelOf(ctx.element)}」可以输入多行文本`,
    '换行与内容被完整保留，页面没有报错',
  ],
});

/**
 * select 元素的候选值，来自契约里的 options（option 的 value）。
 * 缺失或为空时返回空数组，规则改用「展开下拉框」的基础用例，
 * 保证 ELEMENT_KINDS 里声明为可规划的 select 不会静默产出 0 条用例。
 * @param {import('../types.mjs').InventoryElement} element
 * @returns {string[]}
 */
export function selectValues(element) {
  const options = element?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === 'string') return option;
      const value = /** @type {{ value?: unknown }} */ (option ?? {})?.value;
      return typeof value === 'string' ? value : '';
    })
    .filter((value) => value.length > 0);
}

/** @type {PlanRule} */
const SELECT_RULE = Object.freeze({
  id: 'select',
  dedupeAction: 'select',
  priority: (ctx) => (ctx.semantic === 'list' ? 'P1' : 'P2'),
  title: (ctx) => {
    const values = selectValues(ctx.element);
    return values.length > 0
      ? `选择选项：「${labelOf(ctx.element)}」选中第一项「${values[0]}」`
      : `展开下拉框：「${labelOf(ctx.element)}」`;
  },
  steps: (ctx) => {
    const values = selectValues(ctx.element);
    if (values.length === 0) return [clickStep(ctx.element)];
    return [{
      action: 'select',
      target: ctx.element.selector,
      value: values[0],
    }];
  },
  expect: (ctx) => {
    if (selectValues(ctx.element).length === 0) {
      return [
        `「${labelOf(ctx.element)}」可以展开并显示候选选项`,
        '展开后当前选中值保持不变，页面没有报错',
      ];
    }
    return [
      `「${labelOf(ctx.element)}」可以选择选项并保留选中值`,
      '选择后页面状态同步更新，没有报错',
    ];
  },
});

/** @type {PlanRule} */
const CHECKBOX_RULE = Object.freeze({
  id: 'toggle',
  dedupeAction: 'check',
  priority: (ctx) => (ctx.semantic === 'list' ? 'P1' : 'P2'),
  title: (ctx) => `切换勾选状态：「${labelOf(ctx.element)}」`,
  steps: (ctx) => [{ action: 'check', target: ctx.element.selector }],
  expect: (ctx) => [
    `勾选「${labelOf(ctx.element)}」后控件显示为已选中`,
    '与勾选关联的列表项 / 表单状态同步更新',
  ],
});

/** @type {PlanRule} */
const FORM_RULE = Object.freeze({
  id: 'submit',
  dedupeAction: 'submit',
  // 页面上已经有提交按钮时，按钮规则会覆盖同一条主路径，避免重复。
  when: (ctx) => !otherSiblings(ctx).some(isSubmit),
  priority: (ctx) => (ctx.semantic === 'login' ? 'P0' : 'P1'),
  title: (ctx) => `提交表单：「${labelOf(ctx.element)}」`,
  steps: (ctx) => {
    const fields = loginFields(ctx);
    if (fields.length === 0) return [];
    const fills = fields.map((element) => fillStep(element, sampleValue(element)));
    return [
      ...fills,
      {
        action: 'press',
        target: fields[fields.length - 1].selector,
        value: 'Enter',
      },
    ];
  },
  expect: (ctx) => [
    `填写有效输入后在「${labelOf(ctx.element)}」按回车可以提交`,
    '提交结果可观察（成功提示或跳转），页面没有未捕获错误',
  ],
});

/**
 * 元素 kind → 候选行为。新增 kind 的行为只在这里加一条。
 * @type {Readonly<Record<string, readonly PlanRule[]>>}
 */
export const KIND_RULES = Object.freeze({
  link: Object.freeze([LINK_RULE]),
  button: Object.freeze([BUTTON_RULE]),
  input: Object.freeze([INPUT_RULE]),
  textarea: Object.freeze([TEXTAREA_RULE]),
  select: Object.freeze([SELECT_RULE]),
  checkbox: Object.freeze([CHECKBOX_RULE]),
  radio: Object.freeze([CHECKBOX_RULE]),
  form: Object.freeze([FORM_RULE]),
  other: Object.freeze([]),
});

/**
 * 空输入：主路径字段留空必须被拒绝。
 * @type {PlanRule}
 */
const EMPTY_INPUT_RULE = Object.freeze({
  id: 'empty',
  dedupeAction: 'fill:empty',
  when: (ctx) => isTextEntry(ctx.element),
  priority: (ctx) => (ctx.semantic === 'login' ? 'P0' : 'P2'),
  title: (ctx) => `空输入：不填写「${labelOf(ctx.element)}」直接提交`,
  steps: (ctx) => boundaryFillSteps(ctx, ''),
  expect: (ctx) => {
    if (ctx.semantic === 'login' || isEmailField(ctx.element) || isPasswordField(ctx.element)) {
      return [
        `「${labelOf(ctx.element)}」留空提交时被拒绝，并显示可读的提示`,
        '提交后仍停留在表单页，没有进入已登录状态',
      ];
    }
    return [
      `「${labelOf(ctx.element)}」为空时不会新增 / 提交任何数据`,
      '列表或表单状态保持不变，页面没有报错',
    ];
  },
});

/**
 * 纯空格：trim 之后应等同于空输入。
 * @type {PlanRule}
 */
const WHITESPACE_INPUT_RULE = Object.freeze({
  id: 'whitespace',
  dedupeAction: 'fill:whitespace',
  when: (ctx) => isTextEntry(ctx.element),
  priority: (ctx) => (ctx.semantic === 'login' ? 'P1' : 'P2'),
  title: (ctx) => `纯空格输入：「${labelOf(ctx.element)}」只填空格后提交`,
  steps: (ctx) => boundaryFillSteps(ctx, '   '),
  expect: (ctx) => {
    if (ctx.semantic === 'login' || isEmailField(ctx.element) || isPasswordField(ctx.element)) {
      return [
        `「${labelOf(ctx.element)}」只填空格时按空值处理并给出提示`,
        '空白输入没有被当作有效值提交',
      ];
    }
    return [
      '只输入空格不会新增 / 提交内容（应先 trim）',
      '列表内容保持不变，页面没有报错',
    ];
  },
});

/**
 * 超长输入：> 200 字符不应导致崩溃。
 * @type {PlanRule}
 */
const LONG_INPUT_RULE = Object.freeze({
  id: 'long',
  dedupeAction: 'fill:long',
  when: (ctx) => isTextEntry(ctx.element),
  priority: () => 'P2',
  title: (ctx) => `超长输入：向「${labelOf(ctx.element)}」填入 201 个字符`,
  steps: (ctx) => boundaryFillSteps(ctx, LONG_INPUT_VALUE),
  expect: () => [
    '超长输入（201 字符）不会导致页面崩溃或白屏',
    '控件按 maxlength 截断或原样保留，提交结果与产品限制一致',
  ],
});

/**
 * 重复添加：同一内容连续提交两次。
 * @type {PlanRule}
 */
const DUPLICATE_ADD_RULE = Object.freeze({
  id: 'duplicate',
  dedupeAction: 'fill:duplicate',
  when: (ctx) =>
    hasAddFlow(ctx) &&
    isFirstMatching(
      ctx,
      (element) =>
        isTextEntry(element) && !isEmailField(element) && !isPasswordField(element),
    ),
  priority: () => 'P2',
  title: () => '重复添加：连续两次提交同一内容',
  steps: (ctx) => {
    const add = otherSiblings(ctx).find(isAdd);
    const value = sampleValue(ctx.element);
    return [
      fillStep(ctx.element, value),
      clickStep(add),
      fillStep(ctx.element, value),
      clickStep(add),
    ];
  },
  expect: () => [
    '同一内容连续提交两次，页面不报错',
    '列表最多出现两条同名项，或按产品规则去重，数量与去重策略一致',
  ],
});

/**
 * 删除最后一项：页面上只剩一个可删除项时，删除后必须进入空态。
 *
 * 只有「唯一的删除按钮」才等价于「最后一项」：有多个删除按钮时，静态 Inventory
 * 无法判断哪一个是最后一项，先新增再删除既有项只会让空态断言永远不成立。
 * @type {PlanRule}
 */
const DELETE_LAST_RULE = Object.freeze({
  id: 'delete-last',
  dedupeAction: 'click:last',
  when: (ctx) =>
    isDelete(ctx.element) &&
    isFirstMatching(ctx, isDelete) &&
    pageElements(ctx).filter(isDelete).length === 1,
  priority: () => 'P1',
  title: (ctx) => `删除最后一项：删除「${labelOf(ctx.element)}」后检查空态`,
  steps: (ctx) => [clickStep(ctx.element)],
  expect: () => [
    '删除最后一项后列表为空并显示空态',
    '页面没有报错，输入框仍可继续添加新项',
  ],
});

/**
 * 勾选后再过滤：勾选状态与过滤器结果必须一致。
 * @type {PlanRule}
 */
const CHECK_THEN_FILTER_RULE = Object.freeze({
  id: 'check-filter',
  dedupeAction: 'check:then-filter',
  when: (ctx) =>
    isToggle(ctx.element) &&
    isFirstMatching(ctx, isToggle) &&
    findFilterForCheck(ctx) !== null,
  priority: () => 'P1',
  title: (ctx) => {
    const filter = findFilterForCheck(ctx);
    return `勾选后过滤：勾选「${labelOf(ctx.element)}」并切换到「${labelOf(filter)}」`;
  },
  steps: (ctx) => [
    { action: 'check', target: ctx.element.selector },
    clickStep(findFilterForCheck(ctx)),
  ],
  expect: (ctx) => {
    const filter = findFilterForCheck(ctx);
    return [
      `勾选后切换到「${labelOf(filter)}」，该项仍按勾选状态显示`,
      '过滤器选中态与勾选结果一致，不出现重复或丢失',
    ];
  },
});

/**
 * 过滤器空态：过滤后没有结果时展示空态而不是报错。
 * 每个页面只对第一个过滤器生成一条，基础点击用例已经覆盖每个过滤器。
 * @type {PlanRule}
 */
const FILTER_EMPTY_RULE = Object.freeze({
  id: 'filter-empty',
  dedupeAction: 'click:empty-state',
  when: (ctx) =>
    isFilterButton(ctx.element, ctx.semantic) &&
    isFirstMatching(ctx, (element) => isFilterButton(element, ctx.semantic)),
  priority: () => 'P2',
  title: (ctx) => `空态检查：点击过滤器「${labelOf(ctx.element)}」`,
  steps: (ctx) => [clickStep(ctx.element)],
  expect: () => [
    '无数据或过滤后为空时，列表展示空态而不是报错或空白',
    '过滤器选中态与当前可见项一致',
  ],
});

/**
 * 边界规则。它们与 kind 规则叠加执行，由 when 自行限制适用元素。
 * @type {readonly PlanRule[]}
 */
export const BOUNDARY_RULES = Object.freeze([
  EMPTY_INPUT_RULE,
  WHITESPACE_INPUT_RULE,
  LONG_INPUT_RULE,
  DUPLICATE_ADD_RULE,
  DELETE_LAST_RULE,
  CHECK_THEN_FILTER_RULE,
  FILTER_EMPTY_RULE,
]);

/**
 * 选择器不稳定时降一级；已经是 P2 就返回 null，表示跳过。
 * @param {import('../types.mjs').Priority} priority
 * @returns {import('../types.mjs').Priority | null}
 */
export function downgradePriority(priority) {
  const index = PRIORITY_ORDER.indexOf(priority);
  if (index < 0) return null;
  return PRIORITY_ORDER[index + 1] ?? null;
}
