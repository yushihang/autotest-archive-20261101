/**
 * @file src/probe/selectors.mjs 的单元测试。
 *
 * 这些函数全是纯函数、零依赖，但它们决定「产出的选择器能不能唯一定位」，
 * 而 inventory 是全部下游的唯一输入：这里判错一次，下游就多一条跑两次结果不一致的 flaky 用例。
 * 所以每个都钉住：转义的边界字符、自动生成 id 的形态、去重与排序的稳定性。
 *
 * 不开浏览器：selectors.mjs 不碰 DOM、不碰 Playwright。
 */

import { expect, test } from '@playwright/test';

import {
  buildSelector,
  buildSelectorIndex,
  dedupeElements,
  escapeAttributeValue,
  escapeIdentifier,
  isUnstableSelector,
  looksGeneratedId,
  roleKey,
  roleNameKey,
  sortByStability,
  toInventoryElement,
} from '../src/probe/selectors.mjs';

test.describe('escapeAttributeValue', () => {
  test('转义双引号与反斜杠', () => {
    expect(escapeAttributeValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAttributeValue('a\\b')).toBe('a\\\\b');
  });

  test('换行和回车写成 CSS 十六进制转义', () => {
    // 裸换行会把 CSS 选择器截断，必须转义。
    expect(escapeAttributeValue('line1\nline2')).toBe('line1\\a line2');
    expect(escapeAttributeValue('\r')).toBe('\\d ');
  });

  test('先转义反斜杠，不会把自己插入的反斜杠再转义一遍', () => {
    // 输入 \\" 里本来就有反斜杠：顺序错了会得到 \\\\\\"（四个反斜杠）。
    expect(escapeAttributeValue('\\"')).toBe('\\\\\\"');
  });

  test('空值与非字符串', () => {
    expect(escapeAttributeValue(null)).toBe('');
    expect(escapeAttributeValue(undefined)).toBe('');
    expect(escapeAttributeValue(42)).toBe('42');
  });
});

test.describe('escapeIdentifier', () => {
  test('普通标识符原样返回', () => {
    expect(escapeIdentifier('login-form')).toBe('login-form');
    expect(escapeIdentifier('input_email')).toBe('input_email');
  });

  test('首字符是数字时写成十六进制转义', () => {
    // CSS 标识符不能以数字开头（除非是 -数字，那也要转义）。
    expect(escapeIdentifier('1abc')).toBe('\\31 abc');
    expect(escapeIdentifier('42')).toBe('\\34 2');
  });

  test('-1abc 的第二个字符是数字，同样要转义', () => {
    expect(escapeIdentifier('-1abc')).toBe('-\\31 abc');
  });

  test('单个 - 是非法标识符', () => {
    expect(escapeIdentifier('-')).toBe('\\-');
  });

  test('非标识符字符逐个加反斜杠', () => {
    expect(escapeIdentifier('a b')).toBe('a\\ b');
    expect(escapeIdentifier('a.b')).toBe('a\\.b');
    expect(escapeIdentifier('a:b')).toBe('a\\:b');
  });

  test('控制字符写成十六进制转义', () => {
    expect(escapeIdentifier('\u0001abc')).toBe('\\1 abc');
    expect(escapeIdentifier('a\u007fb')).toBe('a\\7f b');
  });

  test('NUL 替换成 U+FFFD', () => {
    expect(escapeIdentifier('\u0000')).toBe('\ufffd');
  });

  test('非 ASCII 字符保留原样', () => {
    // id 里写中文是合法的，CSS 标识符允许 U+0080 及以上。
    expect(escapeIdentifier('用户-列表')).toBe('用户-列表');
  });

  test('空值返回空串，不抛错', () => {
    expect(escapeIdentifier('')).toBe('');
    expect(escapeIdentifier(null)).toBe('');
    expect(escapeIdentifier(undefined)).toBe('');
  });
});

test.describe('looksGeneratedId', () => {
  test('自增 id 与 React useId 判定为生成', () => {
    for (const value of ['1', '42', ':r0:', ':R2m:']) {
      expect(looksGeneratedId(value)).toBe(true);
    }
  });

  test('uuid 与纯 hash 判定为生成', () => {
    expect(looksGeneratedId('3f2a8c1e-9b4d-4a2e-8c3f-1b2a3c4d5e6f')).toBe(true);
    expect(looksGeneratedId('a1b2c3d4e5f6')).toBe(true);
  });

  test('带序号后缀判定为生成', () => {
    expect(looksGeneratedId('input-12')).toBe(true);
    expect(looksGeneratedId('row_42')).toBe(true);
    expect(looksGeneratedId('user2024')).toBe(true);
  });

  test('人写的 id 不算生成', () => {
    for (const value of ['login', 'email', 'firstName', 'submit-button', 'form-login', 'item-7']) {
      expect(looksGeneratedId(value)).toBe(false);
    }
  });

  test('先折叠空白再判断，空值不算生成', () => {
    expect(looksGeneratedId('  42  ')).toBe(true);
    expect(looksGeneratedId('   ')).toBe(false);
    expect(looksGeneratedId('')).toBe(false);
    expect(looksGeneratedId(null)).toBe(false);
    expect(looksGeneratedId(undefined)).toBe(false);
  });
});

test.describe('buildSelector', () => {
  test('data-testid 优先级最高', () => {
    expect(buildSelector({ tag: 'button', testId: 'submit' })).toEqual({
      selector: '[data-testid="submit"]',
      source: 'testid',
    });
  });

  test('测试 id 来自哪个属性就用哪个属性', () => {
    expect(buildSelector({ tag: 'button', testId: 'submit', testIdAttr: 'data-cy' })).toEqual({
      selector: '[data-cy="submit"]',
      source: 'testid',
    });
  });

  test('四种来源同时存在时按 testid → id → name → role 取第一个', () => {
    const facts = {
      tag: 'input',
      testId: 'email-input',
      id: 'email',
      attrName: 'email',
      role: 'textbox',
      name: '邮箱',
    };
    expect(buildSelector(facts).source).toBe('testid');
    expect(buildSelector({ ...facts, testId: '' }).source).toBe('id');
    expect(buildSelector({ ...facts, testId: '', id: '' }).source).toBe('name');
    expect(buildSelector({ ...facts, testId: '', id: '', attrName: '' }).source).toBe('role');
  });

  test('空白值不算有值，继续往下一层找', () => {
    expect(buildSelector({ tag: 'input', testId: '  ', id: ' login ', attrName: 'email' })).toEqual({
      selector: '#login',
      source: 'id',
    });
  });

  test('生成的 id 也照样产出选择器，是否稳定交给 isUnstableSelector', () => {
    // 探测阶段不许静默丢元素：先产出，再标 unstable。
    expect(buildSelector({ tag: 'input', id: 'input-12' })).toEqual({
      selector: '#input-12',
      source: 'id',
    });
  });

  test('name 属性产出的选择器会转义引号', () => {
    expect(buildSelector({ tag: 'input', attrName: 'a"b' })).toEqual({
      selector: '[name="a\\"b"]',
      source: 'name',
    });
  });

  test('role+name 选择器带 i 标记（name 不区分大小写）', () => {
    expect(buildSelector({ tag: 'button', role: 'button', name: '登录' })).toEqual({
      selector: 'role=button[name="登录"i]',
      source: 'role',
    });
  });

  test('role 大小写归一后再拼选择器', () => {
    expect(buildSelector({ role: 'BUTTON', name: 'Sign in' })).toEqual({
      selector: 'role=button[name="Sign in"i]',
      source: 'role',
    });
  });

  test('只有 role 没有 name 时去掉 [name=]', () => {
    expect(buildSelector({ tag: 'div', role: 'button' })).toEqual({
      selector: 'role=button',
      source: 'role',
    });
  });

  test('非标准 role 拼不出能定位的选择器，退回 DOM 路径', () => {
    // 页面写了 role="foo"，Playwright 的 role= 定位不到，不能盲目用。
    expect(buildSelector({ tag: 'div', role: 'foo', name: '嗯', path: 'div:nth-child(2)' })).toEqual({
      selector: 'div:nth-child(2)',
      source: 'path',
    });
  });

  test('兜底顺序：path → tag → *', () => {
    expect(buildSelector({ tag: 'span' })).toEqual({ selector: 'span', source: 'path' });
    expect(buildSelector({})).toEqual({ selector: '*', source: 'path' });
  });
});

test.describe('roleNameKey', () => {
  test('role 与 name 都按小写归一（role 选择器用的是 i 标记）', () => {
    // 选择器里 name 是大小写不敏感的，索引 key 也必须一致，否则唯一性判断会漏。
    expect(roleNameKey({ role: 'BUTTON', name: 'Home' })).toBe('button\u0000home');
    expect(roleNameKey({ role: 'button', name: 'home' })).toBe(roleNameKey({ role: 'BUTTON', name: 'Home' }));
  });

  test('折叠空白后再拼 key', () => {
    expect(roleNameKey({ role: ' link ', name: '  Sign   in ' })).toBe('link\u0000sign in');
  });

  test('空 role / 空 name 也能拼出 key，不抛错', () => {
    expect(roleNameKey({})).toBe('\u0000');
    expect(roleNameKey(undefined)).toBe('\u0000');
  });
});

test.describe('roleKey', () => {
  test('只取 role，折叠空白并转小写', () => {
    expect(roleKey({ role: '  BUTTON ', name: '保存' })).toBe('button');
    expect(roleKey({})).toBe('');
    expect(roleKey(undefined)).toBe('');
  });
});

test.describe('buildSelectorIndex', () => {
  test('逐项计数，空属性不占位', () => {
    const index = buildSelectorIndex([
      { tag: 'button', testId: 'save', id: 'save', attrName: 'save', role: 'button', name: '保存' },
      { tag: 'button', role: 'button', name: '取消' },
    ]);

    expect(index.testIds.get('save')).toBe(1);
    expect(index.ids.get('save')).toBe(1);
    expect(index.names.get('save')).toBe(1);
    expect(index.roleNames.get('button\u0000保存')).toBe(1);
    // 裸 role 选择器要按 role 计数：同页两个 button，无名那个的 `role=button` 不唯一。
    expect(index.roles.get('button')).toBe(2);
    // 第二项没有 testId / id / name 属性，不该产生空字符串的计数。
    expect(index.testIds.has('')).toBe(false);
    expect(index.ids.has('')).toBe(false);
    expect(index.names.has('')).toBe(false);
  });

  test('非数组输入返回空索引，不抛错', () => {
    const index = buildSelectorIndex(undefined);
    expect(index.selectors.size).toBe(0);
    expect(index.roleNames.size).toBe(0);
  });
});

test.describe('isUnstableSelector', () => {
  test('同一页里选择器重复命中多个元素 → 不稳定', () => {
    const facts = [
      { tag: 'input', attrName: 'email' },
      { tag: 'input', attrName: 'email' },
    ];
    const index = buildSelectorIndex(facts);
    for (const item of facts) {
      const { selector, source } = buildSelector(item);
      expect(isUnstableSelector(item, source, selector, index)).toBe(true);
    }
  });

  test('唯一的 testid → 稳定；重复的 testid → 不稳定', () => {
    const single = [{ tag: 'button', testId: 'save' }];
    const singleIndex = buildSelectorIndex(single);
    expect(isUnstableSelector(single[0], 'testid', '[data-testid="save"]', singleIndex)).toBe(false);

    const repeated = [...single, ...single];
    const repeatedIndex = buildSelectorIndex(repeated);
    expect(isUnstableSelector(repeated[0], 'testid', '[data-testid="save"]', repeatedIndex)).toBe(true);
  });

  test('id 看起来是自动生成的 → 不稳定；人写的 id → 稳定', () => {
    const generated = { tag: 'input', id: 'input-12' };
    const generatedIndex = buildSelectorIndex([generated]);
    expect(isUnstableSelector(generated, 'id', '#input-12', generatedIndex)).toBe(true);

    const authored = { tag: 'input', id: 'login-form' };
    const authoredIndex = buildSelectorIndex([authored]);
    expect(isUnstableSelector(authored, 'id', '#login-form', authoredIndex)).toBe(false);
  });

  test('有 name 属性时只看 [name=] 是否唯一，不再被 role+name 重名连累', () => {
    // 两个输入框同一个 label 文案（「邮箱」），但 name 属性不同：各自都能唯一定位。
    const facts = [
      { tag: 'input', attrName: 'email', role: 'textbox', name: '邮箱' },
      { tag: 'input', attrName: 'backupEmail', role: 'textbox', name: '邮箱' },
    ];
    const index = buildSelectorIndex(facts);
    for (const item of facts) {
      const { selector, source } = buildSelector(item);
      expect(source).toBe('name');
      expect(isUnstableSelector(item, source, selector, index)).toBe(false);
    }
  });

  test('单选组同名 name：带 id 的那个走 id，另一个仍判不稳定', () => {
    // 回归：曾经只数「最终选中的选择器字符串」，带 id 的元素改走 `#plan-a` 之后
    // `[name="plan"]` 在 selectors 表里只剩 1 次，另一个 radio 被误判成稳定。
    const facts = [
      { tag: 'input', id: 'plan-a', attrName: 'plan', role: 'radio', name: 'A', kind: 'radio' },
      { tag: 'input', attrName: 'plan', role: 'radio', name: 'B', kind: 'radio' },
    ];
    const index = buildSelectorIndex(facts);

    const [withId, withoutId] = facts;
    expect(buildSelector(withId).selector).toBe('#plan-a');
    expect(buildSelector(withoutId).selector).toBe('[name="plan"]');

    expect(isUnstableSelector(withId, 'id', '#plan-a', index)).toBe(false);
    expect(isUnstableSelector(withoutId, 'name', '[name="plan"]', index)).toBe(true);
    expect(toInventoryElement(withoutId, '/', index).unstable).toBe(true);
  });

  test('testid 按属性值计数：跨不同测试属性的同名 test id 也判不稳定', () => {
    // 两个元素最终选择器不同（一个 data-testid、一个 data-cy），selectors 表里各算 1 次，
    // 但测试 id 值相同，语义上分不清谁是谁。按值计数取保守结果：判不稳定。
    const facts = [
      { tag: 'button', testId: 'save', role: 'button', name: '保存' },
      { tag: 'button', testId: 'save', testIdAttr: 'data-cy', role: 'button', name: '保存' },
    ];
    const index = buildSelectorIndex(facts);

    const [plain, dataCy] = facts;
    expect(buildSelector(plain).selector).toBe('[data-testid="save"]');
    expect(buildSelector(dataCy).selector).toBe('[data-cy="save"]');

    expect(isUnstableSelector(plain, 'testid', '[data-testid="save"]', index)).toBe(true);
    expect(isUnstableSelector(dataCy, 'testid', '[data-cy="save"]', index)).toBe(true);
  });

  test('只有 role+name 可用时，同页重名 → 不稳定', () => {
    const facts = [
      { tag: 'a', role: 'link', name: 'Home' },
      { tag: 'a', role: 'link', name: 'Home' },
    ];
    const index = buildSelectorIndex(facts);
    for (const item of facts) {
      const { selector, source } = buildSelector(item);
      expect(isUnstableSelector(item, source, selector, index)).toBe(true);
    }
  });

  test('DOM 路径一定不稳定（没有 index 也一样）', () => {
    expect(isUnstableSelector({ tag: 'div' }, 'path', 'div', undefined)).toBe(true);
  });

  test('缺 index 时不抛错', () => {
    expect(isUnstableSelector({ id: 'login' }, 'id', '#login', undefined)).toBe(false);
    expect(isUnstableSelector({ role: 'button', name: '保存' }, 'role', 'role=button[name="保存"i]')).toBe(false);
    expect(isUnstableSelector({ testId: 'save' }, 'testid', '[data-testid="save"]')).toBe(false);
  });
});

test.describe('toInventoryElement', () => {
  test('稳定元素不带 unstable 字段', () => {
    const facts = { tag: 'a', role: 'link', name: '首页', kind: 'link' };
    const index = buildSelectorIndex([facts]);

    const element = toInventoryElement(facts, '/', index);

    expect(element).toEqual({
      selector: 'role=link[name="首页"i]',
      role: 'link',
      name: '首页',
      kind: 'link',
      page: '/',
    });
    expect(element).not.toHaveProperty('unstable');
  });

  test('只有大小写不同的两个 name 都会被标成 unstable', () => {
    // 选择器是 role=link[name="Home"i]，两个元素都会命中同一个选择器，
    // 所以必须标 unstable，不能让下游拿到一个必挂的 strict mode 用例。
    const facts = [
      { tag: 'a', role: 'link', name: 'Home', kind: 'link' },
      { tag: 'a', role: 'link', name: 'home', kind: 'link' },
    ];
    const index = buildSelectorIndex(facts);

    const elements = facts.map((item) => toInventoryElement(item, '/', index));

    expect(elements[0].selector).not.toBe(elements[1].selector);
    expect(elements[0].unstable).toBe(true);
    expect(elements[1].unstable).toBe(true);
  });

  test('无名元素生成裸 role 选择器时，同页还有别的同类 role → unstable', () => {
    // `role=button` 不带 [name=] 时 Playwright 不按名字过滤，会命中页面上所有 button。
    // 图标按钮（可访问名为空）不能因为「只有它自己没名字」就被判稳定，
    // 否则下游拿到的是一个必然 strict mode 失败的选择器。
    const icon = { tag: 'button', role: 'button', kind: 'button' };
    const facts = [
      icon,
      { tag: 'button', role: 'button', name: '保存', kind: 'button' },
      { tag: 'button', role: 'button', name: '取消', kind: 'button' },
    ];

    const element = toInventoryElement(icon, '/', buildSelectorIndex(facts));

    expect(element.selector).toBe('role=button');
    expect(element.unstable).toBe(true);
  });

  test('同页只有一个该类 role 时，裸 role 选择器仍然稳定', () => {
    const icon = { tag: 'button', role: 'button', kind: 'button' };
    const element = toInventoryElement(icon, '/', buildSelectorIndex([icon]));

    expect(element.selector).toBe('role=button');
    expect(element).not.toHaveProperty('unstable');
  });

  test('未知 kind 与空 role 都归到 other', () => {
    const facts = { tag: 'div', kind: '不认识的种类', path: 'div' };
    const element = toInventoryElement(facts, '/x', buildSelectorIndex([facts]));
    expect(element.kind).toBe('other');
    expect(element.role).toBe('other');
    expect(element.unstable).toBe(true);
  });
});

test.describe('dedupeElements', () => {
  test('按 (page, selector) 去重，保留第一次出现的那条', () => {
    const first = { page: '/', selector: '#a', role: 'link', name: 'A', kind: 'link' };
    const second = { page: '/', selector: '#a', role: 'link', name: 'A', kind: 'link' };
    const other = { page: '/b', selector: '#a', role: 'link', name: 'A', kind: 'link' };

    const unique = dedupeElements([first, second, other]);

    expect(unique).toHaveLength(2);
    expect(unique[0]).toBe(first);
    expect(unique[1]).toBe(other);
  });

  test('跳过空条目与没有字符串 selector 的条目', () => {
    const valid = { page: '/', selector: '#a', role: 'link', name: 'A', kind: 'link' };
    const unique = dedupeElements([null, undefined, { page: '/', selector: 5 }, valid]);
    expect(unique).toEqual([valid]);
  });

  test('非数组输入返回空数组', () => {
    expect(dedupeElements(undefined)).toEqual([]);
    expect(dedupeElements(null)).toEqual([]);
  });
});

test.describe('sortByStability', () => {
  test('不稳定元素排到后面，两边各自保持原顺序', () => {
    const elements = [
      { page: '/', selector: '#u1', unstable: true },
      { page: '/', selector: '#s1' },
      { page: '/', selector: '#u2', unstable: true },
      { page: '/', selector: '#s2' },
    ];

    expect(sortByStability(elements).map((item) => item.selector)).toEqual([
      '#s1',
      '#s2',
      '#u1',
      '#u2',
    ]);
  });

  test('不改动入参数组', () => {
    const elements = [{ page: '/', selector: '#u', unstable: true }, { page: '/', selector: '#s' }];
    const sorted = sortByStability(elements);

    expect(sorted).not.toBe(elements);
    expect(elements.map((item) => item.selector)).toEqual(['#u', '#s']);
  });

  test('非数组输入返回空数组', () => {
    expect(sortByStability(undefined)).toEqual([]);
  });
});
