import { describe, expect, it } from 'vitest';
import { cleanLabel, makeTopic, regenerate, topicsFrom } from '../topics.ts';

describe('topics', () => {
  it('makes label_code topics that ntfy accepts', () => {
    const t = makeTopic('build');
    expect(t.topic).toMatch(/^build_[a-z0-9]{16}$/);
    expect(t).toMatchObject({ label: 'build', route: 'pet' });
    expect(makeTopic('build').topic).not.toBe(t.topic);
    expect(makeTopic('构建 结果!').topic).toMatch(/^topic_[a-z0-9]{16}$/);
  });

  it('cleans labels and keeps the label when regenerating', () => {
    expect(cleanLabel('  my build ')).toBe('my-build');
    expect(cleanLabel('中文')).toBe('topic');
    expect(cleanLabel('x'.repeat(50))).toHaveLength(30);
    const t = makeTopic('ci');
    const r = regenerate(t);
    expect(r.label).toBe('ci');
    expect(r.topic).not.toBe(t.topic);
  });

  it('reads topics from config and drops bad ones', () => {
    expect(topicsFrom([{ label: 'a', topic: 'a_1', route: 'off' }, { topic: 'bad topic' }, { topic: 'b_2', route: 'loud' }, null])).toEqual([
      { label: 'a', topic: 'a_1', route: 'off' },
      { label: 'b_2', topic: 'b_2', route: 'pet' },
    ]);
    expect(topicsFrom('x')).toEqual([]);
  });
});
