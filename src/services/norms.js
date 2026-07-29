// Расчёт суточных норм — порт calculateAndSaveNorms из iOS (без БД: сервер не хранит
// нормы, они индивидуальны и возвращаются клиенту). Модель — normsModels.
import { config } from '../config.js';
import { callOpenRouterWithRetry } from './openrouter.js';
import { buildNormsPrompt, parseJSONMap, nutrientDataFromMap, sanitizeNormUnits } from './prompts.js';

/**
 * Считает суточные нормы 34 нутриентов через AI.
 * @param {object} p — { gender:'male'|'female', age, weight(kg), height(cm), goals }
 * @returns {Promise<object>} нутриенты-нормы (34 поля), с sanitizeNormUnits.
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
