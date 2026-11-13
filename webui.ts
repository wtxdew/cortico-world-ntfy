/**
 * 设置窗里的面板「话题与连接」：连接状态、话题列表（片段、话题名、重新生成、复制、复制 curl、去向、发一条测试、删除）、
 * 添加话题、自订服务器的访问 token（只在不是官方服务器时显示）、最近的通知。
 * 数据都经 ctx.invoke 找后端（index.ts 的 NtfyWorld.invoke）。
 */

import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import type { PanelState } from './index.ts';
import { text } from './text.ts';

const ROUTES = ['pet', 'maibot', 'off'] as const;

const panel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = text(ctx.language);
    let current: PanelState | null = null;
    /** 话题列表只在内容变了时重画（每 5 秒读一次状态，重画会打断正在点的下拉框和复制提示） */
    let topicsKey = '';

    // 连接
    const conn = ui.sheet({ title: t.statusLabel });
    const pill = ui.pill(t.status.idle!, 'off');
    const serverLine = ui.h('p', 'mono', '');
    const limits = ui.h('p', '', t.limits);
    const tokenInput = ui.input({});
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'off';
    const tokenSave = ui.button(t.tokenSave, { size: 'sm' });
    const tokenClear = ui.button(t.tokenClear, { size: 'sm' });
    const tokenRow = ui.rowbar();
    tokenRow.append(ui.field(t.customToken, tokenInput), tokenSave, tokenClear);
    const tokenHint = ui.h('p', '', t.customTokenHint);
    const tokenBox = ui.h('div');
    tokenBox.append(tokenRow, tokenHint);
    conn.body.append(pill, serverLine, limits, tokenBox);

    // 话题
    const topics = ui.sheet({ title: t.topics });
    const list = ui.h('div');
    const labelInput = ui.input({});
    labelInput.placeholder = t.labelHolder;
    const add = ui.button(t.add, { variant: 'primary', size: 'sm' });
    const addRow = ui.rowbar();
    addRow.append(ui.field(t.label, labelInput), add);
    topics.body.append(ui.h('p', '', t.topicsHint), list, addRow, ui.h('p', '', t.routeHint));

    // 最近的通知
    const recent = ui.sheet({ title: t.recent });
    const recentList = ui.h('div');
    recent.body.append(recentList);

    ctx.root.append(conn.el, topics.el, recent.el);

    const call = async (method: string, args: unknown[] = []): Promise<void> => {
      try {
        render(await ctx.invoke<PanelState>(method, args));
      } catch (err) {
        if (!ctx.signal.aborted) ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    };

    function render(s: PanelState): void {
      if (ctx.signal.aborted) return;
      current = s;
      pill.textContent = t.status[s.state] ?? s.state;
      pill.className = `pill ${s.state === 'open' ? 'on' : s.state === 'error' ? 'bad' : 'off'}`;
      pill.title = s.detail ?? '';
      serverLine.textContent = s.server;
      limits.hidden = !s.official;
      tokenBox.hidden = s.official;
      tokenInput.placeholder = s.tokenSet ? t.tokenSet : '';

      const key = JSON.stringify([s.server, s.topics]);
      if (key !== topicsKey) {
      topicsKey = key;
      list.replaceChildren();
      if (s.topics.length === 0) list.append(ui.placeholder(t.empty));
      s.topics.forEach((topic, i) => {
        const row = ui.rowbar();
        row.style.flexWrap = 'wrap';
        row.style.alignItems = 'center';
        const name = ui.h('strong', '', topic.label);
        const code = ui.h('code', 'mono', topic.topic);
        const route = ui.select({});
        for (const r of ROUTES) route.append(new Option(t.routes[r], r, false, r === topic.route));
        route.title = t.routeLabel;
        route.addEventListener('change', () => void call('route', [i, route.value]), { signal: ctx.signal });
        const curl = `curl -d "${t.curlBody}" ${s.server}/${topic.topic}`;
        const regen = ui.button(t.generate, { size: 'sm', onClick: () => void call('regenerate', [i]) });
        const test = ui.button(t.test, { size: 'sm', onClick: async () => { await call('test', [i]); if (!ctx.signal.aborted) ui.toast(t.sent, 'ok'); } });
        const remove = ui.button(t.remove, { size: 'sm', onClick: async () => {
          if (await ui.confirm({ title: t.confirmRemove(topic.topic), danger: true })) void call('remove', [i]);
        } });
        row.append(name, code, ui.copyButton(topic.topic, { label: t.copy }), ui.copyButton(curl, { label: t.copyCurl }), route, regen, test, remove);
        list.append(row);
      });
      }

      recentList.replaceChildren();
      if (s.recent.length === 0) recentList.append(ui.placeholder(t.recentEmpty));
      for (const n of s.recent) {
        const line = ui.h('p', '');
        const when = new Date(n.time * 1000).toLocaleString();
        line.append(ui.h('small', '', `${when} · ${n.label}${n.offline ? ` · ${t.offline}` : ''}`), ui.h('br'), `${n.title ? `${n.title}：` : ''}${n.message}`);
        recentList.append(line);
      }
    }

    add.addEventListener('click', () => { void call('add', [labelInput.value]); labelInput.value = ''; }, { signal: ctx.signal });
    tokenSave.addEventListener('click', () => { void call('token', [tokenInput.value]); tokenInput.value = ''; }, { signal: ctx.signal });
    tokenClear.addEventListener('click', () => void call('token', ['']), { signal: ctx.signal });

    void call('state');
    // 连接状态和最近的通知会变：每 5 秒读一次
    ctx.interval(() => { if (current) void call('state'); }, 5000);
  },
};

export default { panels: { main: panel } } satisfies WebUiClientBundle;
