// Daily norms calculation — a port of calculateAndSaveNorms from iOS (no DB: the server does not store
// norms, they are individual and returned to the client). Model — normsModels.
import { config } from '../config.js';
import { callOpenRouterWithRetry } from './openrouter.js';
import { buildNormsPrompt, parseJSONMap, nutrientDataFromMap, sanitizeNormUnits } from './prompts.js';

/**
 * Computes the daily norms of 34 nutrients via AI.
 * @param {object} p — { gender:'male'|'female', age, weight(kg), height(cm), goals }
 * @returns {Promise<object>} nutrient norms (34 fields), with sanitizeNormUnits.
 */
export async function calculateNorms({ gender, age, weight, height, goals }) {
  const prompt = buildNormsPrompt(gender, age, weight, height, goals ?? '');
  const text = await callOpenRouterWithRetry({
    messages: [{ role: 'user', content: prompt }],
    models: config.models.norms,
  });
  const map = parseJSONMap(text);
  return sanitizeNormUnits(nutrientDataFromMap(map));
}
