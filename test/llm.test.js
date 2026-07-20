'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { resolveEndpoint, buildBody, normalizeCategory, PROVIDERS } = require('../lib/llm');

test('resolveEndpoint appends the right path for each provider given a base URL', () => {
  assert.equal(resolveEndpoint('http://localhost:1234', 'lmstudio'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(resolveEndpoint('http://localhost:11434', 'ollama'), 'http://localhost:11434/api/chat');
  assert.equal(resolveEndpoint('http://localhost:8080', 'openai'), 'http://localhost:8080/v1/chat/completions');
  // trailing slash tolerated
  assert.equal(resolveEndpoint('http://localhost:11434/', 'ollama'), 'http://localhost:11434/api/chat');
});

test('resolveEndpoint leaves a full endpoint URL untouched', () => {
  assert.equal(resolveEndpoint('http://localhost:1234/v1/chat/completions', 'lmstudio'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(resolveEndpoint('http://localhost:1234/api/v1/chat', 'custom'), 'http://localhost:1234/api/v1/chat');
  assert.equal(resolveEndpoint('http://host/api/generate', 'ollama'), 'http://host/api/generate');
});

test('buildBody produces the correct shape per provider', () => {
  const openai = buildBody('lmstudio', 'm', 'SYS', 'USER');
  assert.deepEqual(openai.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  assert.equal(openai.stream, false);

  const ollama = buildBody('ollama', 'm', 'SYS', 'USER');
  assert.equal(ollama.stream, false);
  assert.equal(ollama.messages[1].content, 'USER');
  assert.equal(ollama.options.temperature, 0);

  const custom = buildBody('custom', 'm', 'SYS', 'USER');
  assert.equal(custom.system_prompt, 'SYS');
  assert.equal(custom.input, 'USER');
});

test('all advertised providers have a default URL', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.defaultUrl, `${id} has a default URL`);
    assert.ok(['openai', 'ollama', 'custom'].includes(p.style));
  }
});

test('normalizeCategory slugifies free-form model output', () => {
  assert.equal(normalizeCategory('Web Pages'), 'web_pages');
  assert.equal(normalizeCategory('MODELS'), 'models');
  assert.equal(normalizeCategory('  ??  '), '');
});
