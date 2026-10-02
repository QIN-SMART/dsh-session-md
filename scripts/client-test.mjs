#!/usr/bin/env node
/**
 * Client-bundle test: load `lib/client.js` the way the browser module loader
 * does, with a fake `window.__ModuleLoader__`, a fake `document`, and minimal
 * React / primitives doubles — then drive the button.
 *
 * This runs no browser: it asserts the bundle registers itself under the right
 * id, mounts into the Session Header utilities slot, translates through the
 * locale service, and hands the correct document-relative Host route to the
 * browser download manager (including the modified-click clean variant).
 *
 *   node scripts/client-test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}\n     ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}

/** Minimal element double that records clicks. */
function createElement(tag) {
  return {
    tag,
    href: undefined,
    rel: undefined,
    style: {},
    attributes: {},
    clicked: 0,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    remove() {},
    click() {
      this.clicked += 1;
    },
  };
}

const created = [];
const documentDouble = {
  createElement(tag) {
    const element = createElement(tag);
    created.push(element);
    return element;
  },
  body: { appendChild() {} },
  documentElement: { appendChild() {} },
};

/** React double: hooks are called straight through in this synchronous test. */
const reactDouble = {
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
};

let loaded;
const windowDouble = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};

const requireDouble = (id) => {
  if (id === 'react') return reactDouble;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Button: 'Button',
      Menu: 'Menu',
      IconDownloadOutlineRegular: 'IconDownloadOutlineRegular',
    };
  }
  throw new Error(`unexpected require("${id}")`);
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const evaluate = new Function('window', 'document', 'fetch', source);
evaluate(windowDouble, documentDouble, () => {
  throw new Error('the client bundle must not fetch directly');
});

test('the bundle registers itself under the plugin id', () => {
  assert.ok(loaded, 'window.__ModuleLoader__.load was never called');
  assert.equal(loaded.id, 'dsh-session-md');
  assert.equal(typeof loaded.factory, 'function');
});

const client = loaded.factory(requireDouble);

test('the client half declares the Cordis contract', () => {
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(client.inject, ['slots', 'locale']);
});

test('apply registers locale dictionaries and a Session Header slot', () => {
  const dictionaries = [];
  const registered = [];
  const effects = [];
  const ctx = {
    effect: (body, label) => {
      effects.push(label);
      return typeof body === 'function' ? body() : undefined;
    },
    locale: { register: (ns, dicts) => dictionaries.push([ns, dicts]) },
    slots: {
      inject(name, fn) {
        assert.equal(name, 'conversation.session.header.utilities');
        fn();
      },
      register(contribution, Component) {
        registered.push({ contribution, Component });
      },
    },
  };
  client.apply(ctx);
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0][0], 'session-md-export');
  assert.equal(dictionaries[0][1].zh['button.label'], '导出为 Markdown');
  assert.equal(dictionaries[0][1].en['button.label'], 'Export as Markdown');
  assert.equal(dictionaries[0][1].zh['mode.readable'], '简洁（人读，工具只留名字）');
  assert.ok(dictionaries[0][1].zh['mode.htmlFull'].includes('HTML'));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].contribution.name, 'conversation.session.header.utilities');
  assert.equal(registered[0].contribution.locale, 'session-md-export');
  assert.equal(typeof registered[0].Component, 'function');
});

test('the menu offers every preset and downloads the Host route for one', () => {
  const Component = (() => {
    let captured;
    client.apply({
      effect: (body) => (typeof body === 'function' ? body() : undefined),
      locale: { register: () => {} },
      slots: {
        inject: (_name, fn) => fn(),
        register: (_contribution, component) => {
          captured = component;
        },
      },
    });
    return captured;
  })();

  const element = Component({ sessionId: 'session-abc', t: (key) => `t:${key}` });
  assert.equal(element.type, 'Menu');
  assert.deepEqual(element.props.items.map((item) => item.id),
    ['full', 'handoff', 'readable', 'audit', 'both', 'html-full', 'html-readable']);
  assert.equal(element.props.items[0].label, 't:mode.full');
  assert.equal(element.props.anchor.type, 'Button');
  assert.equal(element.props.anchor.props['aria-label'], 't:button.label');
  assert.equal(element.props.anchor.children[0].type, 'IconDownloadOutlineRegular');

  element.props.onSelect('readable');
  const anchor = created.at(-1);
  assert.equal(anchor.tag, 'a');
  assert.equal(anchor.href, 'api/session.export-md?sessionId=session-abc&mode=readable');
  assert.equal(anchor.clicked, 1);

  element.props.onSelect('audit');
  assert.equal(created.at(-1).href, 'api/session.export-md?sessionId=session-abc&mode=audit');

  element.props.onSelect('html-full');
  assert.equal(created.at(-1).href, 'api/session.export-md?sessionId=session-abc&mode=full&format=html');
  element.props.onSelect('html-readable');
  assert.equal(created.at(-1).href, 'api/session.export-md?sessionId=session-abc&mode=readable&format=html');
});

test('the "both" preset triggers exactly two downloads', () => {
  let Component;
  client.apply({
    effect: (body) => (typeof body === 'function' ? body() : undefined),
    locale: { register: () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_contribution, component) => {
        Component = component;
      },
    },
  });
  const element = Component({ sessionId: 's1' });
  const before = created.length;
  element.props.onSelect('both');
  const made = created.slice(before);
  assert.deepEqual(made.map((anchor) => anchor.href), [
    'api/session.export-md?sessionId=s1&mode=full',
    'api/session.export-md?sessionId=s1&mode=readable',
  ]);
  assert.ok(made.every((anchor) => anchor.clicked === 1));
});

test('a missing locale function falls back to the built-in dictionary', () => {
  let Component;
  client.apply({
    effect: (body) => (typeof body === 'function' ? body() : undefined),
    locale: { register: () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_contribution, component) => {
        Component = component;
      },
    },
  });
  const element = Component({ sessionId: 'session-xyz' });
  assert.equal(element.props.anchor.props['aria-label'], '导出为 Markdown');
  assert.equal(element.type, 'Menu');
});

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}`);
