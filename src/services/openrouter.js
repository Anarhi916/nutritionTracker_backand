// Низкоуровневый клиент OpenRouter: forward запроса с серверным Bearer-ключом,
// allowlist моделей, retry на 429/5xx. Единственная точка исходящих AI-вызовов.
// См. ARCHITECTURE.md — все эндпоинты-оркестраторы дергают ТОЛЬКО этот модуль.

import { config } from '../config.js';

const MAX_RETRIES = 2; // как в клиенте callOpenRouterWithRetry
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
 * Один вызов OpenRouter. Тело — как слал клиент: {model, messages, temperature, max_tokens}.
 * @param {object} opts
 * @param {Array} opts.messages — массив {role, content} (content: строка или массив частей).
 * @param {string} opts.model — модель (должна быть в allowlist).
 * @param {number} [opts.temperature=0.0]
 * @param {number} [opts.maxTokens=4096]
 * @returns {Promise<string>} содержимое choices[0].message.content.
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
 * Вызов с retry и перебором моделей из пула (как клиентский callOpenRouterWithRetry).
 * Retry на 429/5xx с бэкоффом; на каждой попытке берём следующую модель пула.
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {string[]} opts.models — пул моделей (config.models.text/photo/norms).
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
