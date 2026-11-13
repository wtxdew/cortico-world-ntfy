/**
 * 话题：`<片段>_<随机码>`，例如 `build_k3f9x2q8m1zawd7p`。
 * - 片段是你起的名字，面板上当显示名；只留 ntfy 允许的字符（字母、数字、`-`、`_`），最长 30 个。
 * - 随机码 16 位小写字母加数字（约 80 位），别人猜不到；话题名就是密码。
 * - 每个话题有自己的去向（Coopet 的「规则」模式用）：pet 桌宠说、maibot 交给麦麦、off 不处理。
 */

import { randomInt } from 'node:crypto';

export type TopicRoute = 'pet' | 'maibot' | 'off';
export const TOPIC_ROUTES: readonly TopicRoute[] = ['pet', 'maibot', 'off'];

export interface Topic {
  label: string;
  topic: string;
  route: TopicRoute;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const CODE_LENGTH = 16;
export const LABEL_MAX = 30;

export function randomCode(length = CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** 片段：去掉不允许的字符；空了就用 topic */
export function cleanLabel(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '').slice(0, LABEL_MAX);
  return s || 'topic';
}

export function makeTopic(label: string, route: TopicRoute = 'pet'): Topic {
  const l = cleanLabel(label);
  return { label: l, topic: `${l}_${randomCode()}`, route };
}

/** 只换随机码，片段不变 */
export function regenerate(t: Topic): Topic {
  return { ...t, topic: `${t.label}_${randomCode()}` };
}

/** 读配置里的话题列表：不合格的丢掉 */
export function topicsFrom(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const { label, topic, route } = t as Record<string, unknown>;
    if (typeof topic !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) continue;
    out.push({
      label: typeof label === 'string' && label ? label : topic,
      topic,
      route: TOPIC_ROUTES.includes(route as TopicRoute) ? route as TopicRoute : 'pet',
    });
  }
  return out;
}
