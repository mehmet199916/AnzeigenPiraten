import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aiIsConfigured, loadConfig } from '../lib/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, '../../config/dealfinder.config.json');

test('loopback OpenAI-compatible endpoints enable a local model without a cloud key', async () => {
  const config = await loadConfig(configPath, {
    AI_BASE_URL: 'http://127.0.0.1:11434/v1',
    AI_MODEL: 'qwen3:4b',
  });

  assert.equal(config.ai.apiKey, 'ollama');
  assert.equal(config.ai.model, 'qwen3:4b');
  assert.equal(aiIsConfigured(config), true);
});

test('remote AI endpoints still require an API key', async () => {
  const config = await loadConfig(configPath, {
    AI_BASE_URL: 'https://api.example.com/v1',
  });

  assert.equal(config.ai.apiKey, '');
  assert.equal(aiIsConfigured(config), false);
});

test('AI_REASONING_EFFORT overrides the configured reasoning effort', async () => {
  const overridden = await loadConfig(configPath, { AI_REASONING_EFFORT: 'none' });
  assert.equal(overridden.ai.reasoningEffort, 'none');

  const fallback = await loadConfig(configPath, {});
  assert.equal(fallback.ai.reasoningEffort, '');
});
