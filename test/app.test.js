const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApp(overrides = {}) {
  const elements = new Map();
  const document = {
    addEventListener() {},
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
  };

  for (const [id, value] of Object.entries(overrides)) {
    elements.set(id, { value, checked: false });
  }

  const context = {
    console,
    document,
    fetch: async () => ({ json: async () => ({}) }),
    setInterval() {},
    clearInterval() {},
    window: {},
    bootstrap: { Modal: function Modal() {} },
  };
  context.bootstrap.Modal.getInstance = () => ({ hide() {} });

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'app.js' });

  return context;
}

test('ALIAS content is normalized to a single FQDN target', () => {
  const app = loadApp({ 'r-alias-target': 'target.example.net' });

  assert.equal(
    JSON.stringify(app.buildRecordContent('ALIAS')),
    JSON.stringify([{ content: 'target.example.net.' }]),
  );
});

test('ALIAS content rejects multiple targets for PowerDNS 5.1', () => {
  const app = loadApp({ 'r-alias-target': 'one.example.net.\ntwo.example.net.' });

  assert.throws(
    () => app.buildRecordContent('ALIAS'),
    /ALIAS supports exactly one target/,
  );
});
