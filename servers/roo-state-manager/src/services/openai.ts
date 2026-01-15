import OpenAI from 'openai';
import { StateManagerError } from '../types/errors.js';

let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      // Ne plante pas, mais lance une erreur claire si la clé est nécessaire et absente.
      // Les outils qui n'utilisent pas OpenAI continueront de fonctionner.
      throw new StateManagerError(
        'OpenAI API key is not configured. Please set the OPENAI_API_KEY environment variable.',
        'OPENAI_API_KEY_MISSING',
        'OpenAIClient',
        { envVar: 'OPENAI_API_KEY' }
      );
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openai;
}

export default getOpenAIClient;