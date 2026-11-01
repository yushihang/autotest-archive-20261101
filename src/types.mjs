/**
 * @file 跨模块共享的数据契约。
 *
 * 这里只有类型，没有实现。各模块之间不直接调用对方的内部函数，只交换 JSON：
 *
 *   探测（probe）   → Inventory
 *   规划（plan）    → TestCase[]
 *   执行（run）     → RunResult
 *
 * 契约就是模块之间的接口：任何一方改字段，三方必须同时改。字段只增不改，
 * 需要换语义时新开一个字段，不要复用旧字段。
 */

/**
 * 元素种类。
 * @typedef {'link' | 'button' | 'input' | 'select' | 'textarea' | 'checkbox' | 'radio' | 'form' | 'other'} ElementKind
 */

/**
 * 页面上的一个可交互元素。
 *
 * @typedef {object} InventoryElement
 * @property {string} selector 能唯一定位该元素的 CSS 选择器（执行阶段直接用）
 * @property {string} role 元素的 ARIA role，取不到时用 'other'
 * @property {string} name 可访问名：可见文案 / label / aria-label，用于生成用例标题
 * @property {ElementKind} kind 元素种类，决定能对它做哪些动作
 * @property {string} page 该元素所在的路由（以 '/' 开头，取自 target.routes）
 * @property {boolean} [unstable] 选择器不稳定（如带自增 id / 随机 hash）时为 true，规划阶段应降权或跳过
 */

/**
 * 探测到的一个路由。
 *
 * @typedef {object} InventoryRoute
 * @property {string} path 路由（以 '/' 开头）
 * @property {number} [status] 探测时的 HTTP 状态码
 * @property {string} [title] 页面标题
 */

/**
 * 探测阶段的产物：这个 Web 应用里有什么。
 *
 * @typedef {object} Inventory
 * @property {string} baseUrl 站点根地址，规范化后不带结尾 '/'
 * @property {string} generatedAt 生成时间，ISO 8601 字符串
 * @property {InventoryRoute[]} routes 探测过的路由
 * @property {InventoryElement[]} elements 收集到的可交互元素
 */

/**
 * 用例步骤的动作类型。
 * @typedef {'goto' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'waitFor'} StepAction
 */

/**
 * 一个用例步骤。步骤只描述「做什么」，断言一律写在 TestCase.expect 里。
 *
 * 'waitFor' 步骤用 waitState 说明「等什么」，省略时按 'visible'；不写这一项，执行端只能靠猜。
 *
 * @typedef {object} TestStep
 * @property {StepAction} action 动作类型
 * @property {string} [target] 目标元素的选择器；'goto' 时省略
 * @property {string} [value] 填入的值 / 按键名：'fill'、'press'、'select' 使用；
 *   waitState 为 'url' 时是被等待的地址片段或正则源码
 * @property {string} [page] 'goto' 时的目标路由（以 '/' 开头）
 * @property {WaitState} [waitState] 'waitFor' 时等什么，省略时按 'visible'
 * @property {number} [timeoutMs] 单步超时，省略时用 limits.maxWallMs 的剩余预算
 */

/**
 * 'waitFor' 步骤等待的条件。
 * - visible：target 对应的元素可见
 * - hidden：target 对应的元素不可见或已从 DOM 移除
 * - url：页面地址匹配 value
 * - networkidle：网络空闲
 *
 * @typedef {'visible' | 'hidden' | 'url' | 'networkidle'} WaitState
 */

/**
 * 用例优先级。P0 必跑，P2 预算不足时优先丢弃。
 * @typedef {'P0' | 'P1' | 'P2'} Priority
 */

/**
 * 一条测试用例。
 *
 * @typedef {object} TestCase
 * @property {string} id 稳定 id（同一契约下重跑不变，形如 'P0-login-submit'）
 * @property {string} title 人能读懂的标题：对这个元素做了什么、期望什么
 * @property {Priority} priority 优先级
 * @property {TestStep[]} steps 按顺序执行的步骤，不可为空
 * @property {string[]} expect 期望结果，逐条人可读；不能为空，不允许空断言。
 *   这是写给人 review 的说明，不是机读断言：RunResult.status 由执行阶段根据每一步的
 *   执行结果（元素状态、地址、网络请求）判定，不从这段文字反推，所以「跑两次结论一致」
 *   不依赖模型读自然语言。
 * @property {string} sourceElement 这条用例来自哪个元素，填 Inventory.elements[].selector
 */

/**
 * 一次执行的结论。'flaky' 表示重跑中出现过通过也出现过失败。
 * @typedef {'passed' | 'failed' | 'flaky' | 'error'} RunStatus
 */

/**
 * 单次尝试的结论。'flaky' 是多次尝试汇总出来的，不属于任何一次尝试。
 * @typedef {'passed' | 'failed' | 'error'} AttemptStatus
 */

/**
 * 一次尝试。runner.repeat > 1 时会有多条，index 从 0 开始。
 *
 * @typedef {object} Attempt
 * @property {number} index 第几次尝试，从 0 开始
 * @property {AttemptStatus} status 这一次的结果，只能是 'passed' / 'failed' / 'error'
 * @property {number} durationMs 耗时（毫秒）
 * @property {string} [startedAt] 开始时间，ISO 8601 字符串
 * @property {string} [error] 失败原因；status 为 'error' 时必须有
 */

/**
 * 失败证据。「工具发现的失败不等于业务有 bug」，证据要摆整齐让人自己判断。
 *
 * @typedef {object} Evidence
 * @property {string} input 实际输入（填了什么、点了哪个元素）
 * @property {string} expected 期望结果
 * @property {string} actual 实际结果
 * @property {string[]} minimalRepro 可复现的最小步骤，命令或点击序列
 * @property {string} [screenshot] 截图文件路径，相对 output.dir
 */

/**
 * 执行阶段的产物：一条用例跑完后的结果。
 *
 * @typedef {object} RunResult
 * @property {string} caseId 对应 TestCase.id
 * @property {RunStatus} status 汇总结论
 * @property {Attempt[]} attempts 每次尝试的明细，至少一条
 * @property {Evidence} evidence 失败证据；passed 时也要填，写清测了什么、看到了什么
 */

/** @type {readonly Priority[]} */
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2']);

/** @type {readonly RunStatus[]} */
export const RUN_STATUSES = Object.freeze(['passed', 'failed', 'flaky', 'error']);

/** @type {readonly AttemptStatus[]} */
export const ATTEMPT_STATUSES = Object.freeze(['passed', 'failed', 'error']);

/** @type {readonly ElementKind[]} */
export const ELEMENT_KINDS = Object.freeze([
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

/** @type {readonly StepAction[]} */
export const STEP_ACTIONS = Object.freeze([
  'goto',
  'click',
  'fill',
  'press',
  'select',
  'check',
  'uncheck',
  'waitFor',
]);

/** @type {readonly WaitState[]} */
export const WAIT_STATES = Object.freeze(['visible', 'hidden', 'url', 'networkidle']);
