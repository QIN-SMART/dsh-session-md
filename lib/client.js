// dsh-session-md client bundle — a "导出为 Markdown" menu in the Session Header.
//
// Data path: each menu choice hands a document-relative Host route to the
// browser download manager (`api/session.export-md?sessionId=…&mode=…`),
// exactly like the official Session-log export hands over `api/session.export`.
// The files land in the browser's normal download location; the Host route sets
// `Content-Disposition: attachment`, which supplies the file names.
//
// Loaded through the DSH client module loader; `require` ids are the client
// modules declared in package.json → `dsh.client.inject`.

window.__ModuleLoader__.load({
  id: 'dsh-session-md',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Document-relative Host route (leading slash removed on purpose). */
    const ROUTE = 'api/session.export-md';
    /** Locale namespace owned by this menu. */
    const NS = 'session-md-export';
    /** Menu entries, in display order; `modes` lists the downloads each triggers. */
    const MENU = [
      { id: 'full', labelKey: 'mode.full', modes: ['full'] },
      { id: 'handoff', labelKey: 'mode.handoff', modes: ['handoff'] },
      { id: 'readable', labelKey: 'mode.readable', modes: ['readable'] },
      { id: 'audit', labelKey: 'mode.audit', modes: ['audit'] },
      { id: 'both', labelKey: 'mode.both', modes: ['full', 'readable'] },
      { id: 'html-full', labelKey: 'mode.htmlFull', modes: ['full'], format: 'html' },
      { id: 'html-readable', labelKey: 'mode.htmlReadable', modes: ['readable'], format: 'html' },
    ];
    const zh = {
      'button.label': '导出为 Markdown',
      'button.done': '已开始下载',
      'button.failed': '导出失败',
      'mode.full': '全部（给 agent 接手/复现）',
      'mode.handoff': '交接版（保留工具调用，去掉思维链）',
      'mode.readable': '简洁（人读，工具只留名字）',
      'mode.audit': '审计版（不截断 + 系统提示词 + 注入上下文）',
      'mode.both': '两份都要（全部 + 简洁）',
      'mode.htmlFull': 'HTML·全部（自包含，可打印成 PDF）',
      'mode.htmlReadable': 'HTML·简洁（人读）',
    };
    const en = {
      'button.label': 'Export as Markdown',
      'button.done': 'Download started',
      'button.failed': 'Export failed',
      'mode.full': 'Full (agent handoff / reproduction)',
      'mode.handoff': 'Handoff (tool calls kept, reasoning dropped)',
      'mode.readable': 'Readable (human, tool names only)',
      'mode.audit': 'Audit (untruncated + system prompt + injected context)',
      'mode.both': 'Both (full + readable)',
      'mode.htmlFull': 'HTML · full (self-contained, prints to PDF)',
      'mode.htmlReadable': 'HTML · readable',
    };

    /** Hand one Host download route to the browser download manager. */
    function startDownload(sessionId, mode, format) {
      const suffix = format === 'html' ? '&format=html' : '';
      const url = `${ROUTE}?sessionId=${encodeURIComponent(String(sessionId))}&mode=${encodeURIComponent(mode)}${suffix}`;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      (document.body ?? document.documentElement).appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    /**
     * Session Header action: a menu of export presets.
     * Props come from the slot: `sessionId` identifies the Session, `t`
     * translates this namespace.
     */
    function ExportMarkdownMenu(props) {
      const { sessionId, t } = props;
      const translate = typeof t === 'function' ? t : (key) => zh[key] ?? key;
      const [open, setOpen] = react.useState(false);
      const [state, setState] = react.useState('idle');

      const onSelect = react.useCallback((id) => {
        setOpen(false);
        const entry = MENU.filter((candidate) => candidate.id === id)[0];
        if (entry === undefined || sessionId === undefined || sessionId === null) return;
        try {
          for (const mode of entry.modes) startDownload(sessionId, mode, entry.format);
          setState('done');
        } catch {
          setState('failed');
        }
      }, [sessionId, setState, setOpen]);

      const label = state === 'failed' ? translate('button.failed') : translate('button.label');

      return react.createElement(
        primitives.Menu,
        {
          open,
          align: 'end',
          dense: true,
          onClose: () => setOpen(false),
          items: MENU.map((entry) => ({ id: entry.id, label: translate(entry.labelKey) })),
          onSelect,
          anchor: react.createElement(
            primitives.Button,
            {
              size: 'sm',
              'aria-label': label,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              title: state === 'done' ? translate('button.done') : label,
              onClick: () => setOpen((value) => !value),
            },
            react.createElement(primitives.IconDownloadOutlineRegular, {}),
          ),
        },
      );
    }

    /** Mount the menu into the Session Header utilities area. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-md-export: dictionaries');
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'session-md-export',
        locale: NS,
      }, ExportMarkdownMenu));
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
