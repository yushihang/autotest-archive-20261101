/**
 * @file src/plan（用例规划）的单元测试。
 *
 * 规划层是纯函数：只吃 Inventory，不碰浏览器、不读写文件系统（样例 fixture 读一次）。
 * 这里钉住三件事：
 *   1. TestCase 契约形状（非空步骤、goto 在首位、非空 expect、id 唯一）；
 *   2. 确定性（同一输入两次结果深相等）与 maxCases 截断报告；
 *   3. 曾经出过问题的规则：select 不能静默 0 条、delete-last 的步骤与断言必须自洽。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { planCases, planCasesReport } from '../src/plan/index.mjs';
import { PRIORITIES, STEP_ACTIONS } from '../src/types.mjs';

const SAMPLE_INVENTORY = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/inventory.sample.json', import.meta.url)),
    'utf8',
  ),
);

/**
 * 一份最小可用的 Inventory。
 * @param {Record<string, unknown>[]} elements
 * @returns {Record<string, unknown>}
 */
function inventoryOf(elements) {
  return {
    baseUrl: 'http://127.0.0.1:4173',
    generatedAt: '2026-01-01T00:00:00.000Z',
    routes: [{ path: '/', status: 200, title: '测试页' }],
    elements,
  };
}

/**
 * 补全契约必填字段的元素。
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function elementOf(overrides) {
  return {
    selector: '#target',
    role: 'other',
    name: '目标',
    kind: 'other',
    page: '/',
    ...overrides,
  };
}

test('同一份 Inventory 规划两次，结果深相等', () => {
  expect(planCasesReport(SAMPLE_INVENTORY)).toEqual(planCasesReport(SAMPLE_INVENTORY));
  expect(planCases(SAMPLE_INVENTORY)).toEqual(planCases(SAMPLE_INVENTORY));
});

test('每条用例都满足 TestCase 契约', () => {
  const { cases } = planCasesReport(SAMPLE_INVENTORY, { maxCases: 1000 });
  expect(cases.length).toBeGreaterThan(0);

  const seenIds = [];
  for (const testCase of cases) {
    expect(testCase.id).toMatch(/^P[0-2]-/);
    expect(seenIds).not.toContain(testCase.id);
    seenIds.push(testCase.id);

    expect(PRIORITIES).toContain(testCase.priority);
    expect(typeof testCase.title).toBe('string');
    expect(testCase.title.trim().length).toBeGreaterThan(0);

    // steps 不可为空，且第一条永远是 goto；page 必须以 '/' 开头。
    expect(testCase.steps.length).toBeGreaterThan(0);
    expect(testCase.steps[0].action).toBe('goto');
    expect(typeof testCase.steps[0].page).toBe('string');
    expect(testCase.steps[0].page.startsWith('/')).toBe(true);

    for (const step of testCase.steps.slice(1)) {
      expect(STEP_ACTIONS).toContain(step.action);
      if (step.action !== 'waitFor') {
        expect(typeof step.target).toBe('string');
        expect(step.target.length).toBeGreaterThan(0);
      }
    }

    // expect 不允许为空，也不允许空字符串。
    expect(testCase.expect.length).toBeGreaterThan(0);
    for (const line of testCase.expect) {
      expect(typeof line).toBe('string');
      expect(line.trim().length).toBeGreaterThan(0);
    }

    expect(typeof testCase.sourceElement).toBe('string');
    expect(testCase.sourceElement.length).toBeGreaterThan(0);
  }
});

test('maxCases 截断后，保留的与 dropped 合起来正好是 total', () => {
  const full = planCasesReport(SAMPLE_INVENTORY, { maxCases: 1000 });
  const capped = planCasesReport(SAMPLE_INVENTORY, { maxCases: 3 });

  expect(capped.cases).toHaveLength(3);
  expect(capped.total).toBe(full.total);
  expect(capped.dropped).toHaveLength(capped.total - capped.cases.length);

  const keptIds = capped.cases.map((testCase) => testCase.id);
  const reportedIds = [...keptIds, ...capped.dropped].sort();
  const fullIds = full.cases.map((testCase) => testCase.id).sort();
  expect(reportedIds).toEqual(fullIds);
});

test('unstable 的 P2 用例被跳过', () => {
  const link = elementOf({ selector: '#docs', role: 'link', name: '文档', kind: 'link' });

  const stable = planCasesReport(inventoryOf([link]), { maxCases: 10 });
  expect(stable.cases.map((testCase) => testCase.priority)).toEqual(['P2']);

  const unstable = planCasesReport(inventoryOf([{ ...link, unstable: true }]), { maxCases: 10 });
  // P2 已经是最低优先级，降级后无可降 → 整条跳过，而不是留下 P2。
  expect(unstable.cases).toHaveLength(0);
  expect(unstable.total).toBe(0);
});

test('select 元素总有用例：有 options 选第一项，没有 options 退化为展开下拉框', () => {
  const select = elementOf({
    selector: '#status',
    role: 'combobox',
    name: '状态',
    kind: 'select',
  });

  const withOptions = planCasesReport(
    inventoryOf([{ ...select, options: ['open', 'closed'] }]),
    { maxCases: 10 },
  );
  expect(withOptions.cases).toHaveLength(1);
  expect(withOptions.cases[0].steps.map((step) => step.action)).toEqual(['goto', 'select']);
  expect(withOptions.cases[0].steps[1]).toMatchObject({
    action: 'select',
    target: '#status',
    value: 'open',
  });

  // options 是契约里的可选字段；缺失时也必须产出可执行用例，不能静默丢弃整类元素。
  const withoutOptions = planCasesReport(inventoryOf([select]), { maxCases: 10 });
  expect(withoutOptions.cases).toHaveLength(1);
  expect(withoutOptions.cases[0].steps.map((step) => step.action)).toEqual(['goto', 'click']);
  expect(withoutOptions.cases[0].steps[1].target).toBe('#status');
});

test('delete-last 只在页面上只剩一个删除按钮时生成，且步骤不预置新增', () => {
  const elements = [
    elementOf({ selector: '#note-input', role: 'textbox', name: '备忘', kind: 'input' }),
    elementOf({ selector: '#note-add', role: 'button', name: '添加', kind: 'button' }),
    elementOf({ selector: '#note-1-delete', role: 'button', name: '删除备忘', kind: 'button' }),
  ];

  const single = planCasesReport(inventoryOf(elements), { maxCases: 100 });
  const deleteLast = single.cases.find((testCase) => testCase.id.endsWith('delete-last'));
  expect(deleteLast).toBeTruthy();
  expect(deleteLast.steps.map((step) => step.action)).toEqual(['goto', 'click']);
  expect(deleteLast.steps[1].target).toBe('#note-1-delete');

  // 有多个删除按钮时判断不了「最后一项」，不生成空态用例，避免断言不可满足。
  const multiple = planCasesReport(
    inventoryOf([
      ...elements,
      elementOf({ selector: '#note-2-delete', role: 'button', name: '删除另一条', kind: 'button' }),
    ]),
    { maxCases: 100 },
  );
  expect(multiple.cases.some((testCase) => testCase.id.endsWith('delete-last'))).toBe(false);
});

test('输入框没有提交 / 添加按钮时，不生成「已提交」类边界用例', () => {
  // 一个孤零零的搜索框：常见 UI 形状，页面上没有任何提交按钮。
  const searchOnly = inventoryOf([
    elementOf({ selector: '#q', role: 'searchbox', name: '搜索', kind: 'input' }),
  ]);

  const { cases } = planCasesReport(searchOnly, { maxCases: 100 });
  // 只剩「输入合法内容」。空输入 / 纯空格 / 超长三条的步骤只能以 fill 收尾，
  // 而执行阶段是按步骤判定 passed 的，留下它们就会产出「提交过且通过」的假阳性。
  expect(cases.map((testCase) => testCase.steps.map((step) => step.action))).toEqual([
    ['goto', 'fill'],
  ]);
  expect(cases[0].steps[1]).toMatchObject({ action: 'fill', target: '#q' });
});

test('有提交按钮时，空输入 / 纯空格 / 超长用例都以点击按钮收尾', () => {
  const withSubmit = inventoryOf([
    elementOf({ selector: '#q', role: 'searchbox', name: '搜索', kind: 'input' }),
    elementOf({ selector: '#go', role: 'button', name: '提交', kind: 'button' }),
  ]);

  const boundary = planCasesReport(withSubmit, { maxCases: 100 }).cases.filter((testCase) =>
    /-(empty|whitespace|long)$/.test(testCase.id),
  );

  expect(boundary).toHaveLength(3);
  for (const testCase of boundary) {
    expect(testCase.steps.map((step) => step.action)).toEqual(['goto', 'fill', 'click']);
    expect(testCase.steps[2]).toMatchObject({ action: 'click', target: '#go' });
  }
});

test('列表页没有添加按钮时，不把「清空」当成提交触发器', () => {
  const listWithClear = inventoryOf([
    elementOf({ selector: '#todo-input', role: 'textbox', name: '待办内容', kind: 'input' }),
    elementOf({ selector: '#clear', role: 'button', name: '清空', kind: 'button' }),
  ]);

  const { cases } = planCasesReport(listWithClear, { maxCases: 100 });
  // 清空属于删除语义：把它当触发器，「留空后点它」会真的清掉列表，
  // 与「空输入被拒绝」的断言正好相反，所以这几条边界用例必须整条不生成。
  expect(cases.some((testCase) => /-(empty|whitespace|long)$/.test(testCase.id))).toBe(false);

  const inputCase = cases.find((testCase) => testCase.sourceElement === '#todo-input');
  expect(inputCase).toBeTruthy();
  expect(inputCase.steps.map((step) => step.action)).toEqual(['goto', 'fill']);
});
