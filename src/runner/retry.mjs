/**
 * @file 重试与 flaky 归因：一次失败不算失败，一次通过也不算通过。
 *
 * 同一个用例重复跑若干次，结论只有三种：
 *   - 每次都通过            → passed
 *   - 没有一次通过           → failed（如果每次都是执行环境异常，则是 error）
 *   - 通过和失败都出现过      → flaky
 *
 * flaky 必须单独成类，绝不能并进 failed 或 passed：它说明的是「这条用例不稳定」，
 * 而不是「功能坏了」或「功能好了」。把偶发失败算成功能失败会让报告失去可信度，
 * 把偶发失败悄悄算成通过则更糟。
 *
 * 每次尝试之间的状态重置由调用方负责（执行器为每次尝试新建 BrowserContext），
 * 这里只负责次数、汇总和「预算到了就停」的闸门，不碰浏览器。
 */

import { ATTEMPT_STATUSES } from '../types.mjs';

/** 一条用例默认最多跑几次。3 次足以看出「偶发」，又不至于为了一条用例烧掉整轮预算。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * @typedef {import('../types.mjs').Attempt & {
 *   evidence?: import('../types.mjs').Evidence,
 *   aborted?: boolean,
 * }} InternalAttempt
 */

/**
 * 把次数配置规范成 >= 1 的整数；非法值回落到默认值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCount(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/**
 * 计算一条用例实际要跑几次。
 *
 * `repeat` 是配置里「想跑几次」（runner.repeat）；`maxAttempts` 是执行器自己的硬上限，
 * 默认 3。两者取小：配置写了 10 次也不能让一条不稳定用例把整轮预算吃掉。
 *
 * @param {{ repeat?: number, maxAttempts?: number }} [options]
 * @returns {number}
 */
export function resolveAttempts(options = {}) {
  const cap = normalizeCount(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const repeat = options.repeat;

  // repeat 没给或非法时按上限跑，而不是偷偷只跑一次：只跑一次就无法判 flaky。
  if (typeof repeat !== 'number' || !Number.isFinite(repeat) || repeat < 1) return cap;

  return Math.min(Math.floor(repeat), cap);
}

/**
 * 多次尝试的结论汇总。空数组返回 null——还没跑过，不能给结论。
 *
 * @param {Array<{ status?: string }>} attempts
 * @returns {import('../types.mjs').RunStatus | null}
 */
export function summarizeAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;

  const passed = attempts.filter((attempt) => attempt?.status === 'passed').length;

  if (passed === attempts.length) return 'passed';
  if (passed > 0) return 'flaky';

  // 全是执行环境异常（浏览器起不来、context 崩了）和「功能失败」不是一回事。
  if (attempts.every((attempt) => attempt?.status === 'error')) return 'error';

  return 'failed';
}

/**
 * 把执行器给的一次尝试补成契约里的 Attempt。
 * 只有 status / durationMs / error 是契约字段，evidence 与 aborted 是内部字段，
 * 最后写进 RunResult 时会剥掉。
 *
 * @param {number} index
 * @param {Partial<InternalAttempt> & { evidence?: import('../types.mjs').Evidence }} raw
 * @returns {InternalAttempt}
 */
function normalizeAttempt(index, raw) {
  const status = ATTEMPT_STATUSES.includes(raw?.status) ? raw.status : 'error';
  const durationMs =
    typeof raw?.durationMs === 'number' && Number.isFinite(raw.durationMs)
      ? Math.max(0, Math.round(raw.durationMs))
      : 0;

  /** @type {InternalAttempt} */
  const attempt = {
    index,
    status,
    durationMs,
    startedAt: typeof raw?.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
  };

  /** @type {string | undefined} */
  let error;
  if (typeof raw?.error === 'string') error = raw.error;
  else if (raw?.error) error = String(raw.error);
  else if (status === 'error') error = '未知执行错误';
  if (error !== undefined) attempt.error = error;

  if (raw?.evidence) attempt.evidence = raw.evidence;
  attempt.aborted = raw?.aborted === true;

  return attempt;
}

/**
 * 同一条用例跑 `resolveAttempts()` 次，并给出汇总结论。
 *
 * `attemptFn(index, attempts)` 负责真正跑一次，必须返回 `{ status, durationMs, error?, evidence? }`；
 * 第二个参数会带上已经跑完的 attempts，便于执行器把「上次失败」写进证据。
 *
 * `beforeAttempt(index, attempts)` 在每次尝试之前调用，返回 false 表示预算已经不允许再跑，
 * 此时已经完成的尝试原样保留，`aborted` 为 true。执行器第一次尝试之前也要过这道闸门。
 *
 * @param {import('../types.mjs').TestCase} testCase
 * @param {(index: number, attempts: InternalAttempt[]) => Promise<Partial<InternalAttempt>>} attemptFn
 * @param {{
 *   repeat?: number,
 *   maxAttempts?: number,
 *   beforeAttempt?: (index: number, attempts: InternalAttempt[]) => boolean,
 * }} [options]
 * @returns {Promise<{ status: import('../types.mjs').RunStatus | null, attempts: InternalAttempt[], aborted: boolean }>}
 */
export async function runWithRetry(testCase, attemptFn, options = {}) {
  if (typeof attemptFn !== 'function') {
    throw new TypeError('runWithRetry 需要 attemptFn(testCase 的某一次执行)');
  }

  const total = resolveAttempts(options);
  /** @type {InternalAttempt[]} */
  const attempts = [];

  for (let index = 0; index < total; index += 1) {
    if (typeof options.beforeAttempt === 'function') {
      const allowed = options.beforeAttempt(index, attempts);
      if (allowed === false) {
        return {
          status: summarizeAttempts(attempts),
          attempts,
          aborted: true,
        };
      }
    }

    const raw = await attemptFn(index, attempts);
    const attempt = normalizeAttempt(index, raw);
    attempts.push(attempt);

    // 执行到一半撞上预算：这条用例不能再重试，已经拿到的尝试保留。
    if (attempt.aborted === true) {
      return {
        status: summarizeAttempts(attempts),
        attempts,
        aborted: true,
      };
    }
  }

  return {
    status: summarizeAttempts(attempts),
    attempts,
    aborted: false,
  };
}

/**
 * 只保留契约里的 Attempt 字段，去掉内部用的 evidence / aborted。
 * @param {InternalAttempt[]} attempts
 * @returns {import('../types.mjs').Attempt[]}
 */
export function toContractAttempts(attempts) {
  return attempts.map((attempt) => {
    /** @type {import('../types.mjs').Attempt} */
    const result = {
      index: attempt.index,
      status: attempt.status,
      durationMs: attempt.durationMs,
    };
    if (attempt.startedAt !== undefined) result.startedAt = attempt.startedAt;
    if (attempt.error !== undefined) result.error = attempt.error;
    return result;
  });
}
