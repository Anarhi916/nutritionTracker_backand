// Low-level OpenRouter client: forwards the request with the server-side Bearer key,
// model allowlist, retry on 429/5xx. The single point of outgoing AI calls.
// See ARCHITECTURE.md — all orchestrator endpoints call ONLY this module.

import { config } from '../config.js';

const MAX_RETRIES = 2; // same as in the client callOpenRouterWithRetry
const RETRY_BASE_MS = 1000;

class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A single OpenRouter call. Body — as the client sent it: {model, messages, temperature, max_tokens}.
 * @param {object} opts
 * @param {Array} opts.messages — array of {role, content} (content: string or array of parts).
 * @param {string} opts.model — model (must be in the allowlist).
 * @param {number} [opts.temperature=0.0]
 * @param {number} [opts.maxTokens=4096]
 * @returns {Promise<string>} the contents of choices[0].message.content.
 */
export async function callOpenRouter({ messages, model, temperature = 0.0, maxTokens = 4096 }) {
  if (!config.models.allowed.includes(model)) {
    throw new OpenRouterError(`Модель не в allowlist: ${model}`, 400);
  }
  if (!config.openRouter.apiKey) {
    throw new OpenRouterError('OPENROUTER_API_KEY не задан на сервере', 500);
  }

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  const res = await fetch(config.openRouter.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openRouter.apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OpenRouterError(
      `OpenRouter вернул ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    );
  }

  const json = await res.json();
  if (json.error) {
    throw new OpenRouterError(
      `OpenRouter error: ${json.error.message ?? JSON.stringify(json.error)}`,
      502,
    );
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new OpenRouterError('OpenRouter: пустой content в ответе', 502);
  }
  return content;
}

/**
 * Call with retry and cycling through models in the pool (like the client callOpenRouterWithRetry).
 * Retry on 429/5xx with backoff; on each attempt we take the next model in the pool.
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {string[]} opts.models — model pool (config.models.text/photo/norms).
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>}
 */
export async function callOpenRouterWithRetry({ messages, models, temperature, maxTokens }) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new OpenRouterError('Пустой пул моделей', 500);
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const model = models[Math.min(attempt, models.length - 1)];
    try {
      return await callOpenRouter({ messages, model, temperature, maxTokens });
    } catch (err) {
      lastErr = err;
      const status = err.status ?? 0;
      const retryable = status === 429 || (status >= 500 && status < 600) || status === 0;
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

export { OpenRouterError };
