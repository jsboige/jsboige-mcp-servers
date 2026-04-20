import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const ENV_FILE_PATH = process.env.ENV_FILE_PATH || './.env';
const REFERENCE_FILE_PATH = process.env.REFERENCE_FILE_PATH || './.env.reference';

export const analyzeEnvSchema = z.object({
  fixMode: z.enum(['read-only', 'validate-only', 'suggest-fixes']).default('read-only'),
  verbose: z.boolean().default(false),
});

export type AnalyzeEnvInput = z.infer<typeof analyzeEnvSchema>;

export const analyzeEnvOutputSchema = z.object({
  envExists: z.boolean(),
  referenceExists: z.boolean(),
  envFileSize: z.number().nullable(),
  referenceFileSize: z.number().nullable(),
  missingRequiredKeys: z.array(z.string()),
  emptyValues: z.array(z.string()),
  extraKeys: z.array(z.string()),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  suggestions: z.array(z.string()),
  isValid: z.boolean(),
  fixApplied: z.boolean().default(false),
});

export type AnalyzeEnvOutput = z.infer<typeof analyzeEnvOutputSchema>;

export async function analyzeEnv(input: AnalyzeEnvInput): Promise<AnalyzeEnvOutput> {
  const result: AnalyzeEnvOutput = {
    envExists: false,
    referenceExists: false,
    envFileSize: null,
    referenceFileSize: null,
    missingRequiredKeys: [],
    emptyValues: [],
    extraKeys: [],
    warnings: [],
    errors: [],
    suggestions: [],
    isValid: false,
    fixApplied: false,
  };

  try {
    // Vérifier l'existence des fichiers
    try {
      await fs.access(ENV_FILE_PATH);
      result.envExists = true;
      const envStats = await fs.stat(ENV_FILE_PATH);
      result.envFileSize = envStats.size;
    } catch {
      result.errors.push(`Le fichier .env n'existe pas à: ${ENV_FILE_PATH}`);
      return result;
    }

    try {
      await fs.access(REFERENCE_FILE_PATH);
      result.referenceExists = true;
      const refStats = await fs.stat(REFERENCE_FILE_PATH);
      result.referenceFileSize = refStats.size;
    } catch {
      result.errors.push(`Le fichier de référence .env.reference n'existe pas à: ${REFERENCE_FILE_PATH}`);
      return result;
    }

    // Lire les fichiers
    const envContent = await fs.readFile(ENV_FILE_PATH, 'utf8');
    const referenceContent = await fs.readFile(REFERENCE_FILE_PATH, 'utf8');

    // Parser les fichiers
    const envVars = parseEnvFile(envContent);
    const referenceVars = parseEnvFile(referenceContent);

    // Clés requises selon .env.reference
    const requiredKeys = [
      'QDRANT_URL',
      'QDRANT_API_KEY',
      'QDRANT_COLLECTION_NAME',
      'EMBEDDING_API_KEY',
      'EMBEDDING_API_BASE_URL',
      'EMBEDDING_MODEL',
      'EMBEDDING_DIMENSIONS',
      'OPENAI_API_KEY',
      'OPENAI_CHAT_MODEL_ID',
      'ROOSYNC_SHARED_PATH',
      'ROOSYNC_MACHINE_ID',
    ];

    // Vérifier les clés manquantes
    for (const key of requiredKeys) {
      if (!envVars[key]) {
        result.missingRequiredKeys.push(key);
        result.errors.push(`Clé requise manquante: ${key}`);
      }
    }

    // Vérifier les valeurs vides
    for (const [key, value] of Object.entries(envVars)) {
      if (!value || value.trim() === '') {
        result.emptyValues.push(key);
        result.errors.push(`Valeur vide pour la clé: ${key}`);
      }
    }

    // Vérifier les clés supplémentaires
    for (const key of Object.keys(envVars)) {
      if (!referenceVars[key] && !key.startsWith('#')) {
        result.extraKeys.push(key);
        result.warnings.push(`Clé non documentée dans .env.reference: ${key}`);
      }
    }

    // Vérifications spécifiques
    if (envVars.QDRANT_URL && !envVars.QDRANT_URL.startsWith('https://')) {
      result.warnings.push('QDRANT_URL doit utiliser HTTPS pour la production');
    }

    if (envVars.EMBEDDING_MODEL && !['qwen3-4b-awq-embedding', 'text-embedding-3-small'].includes(envVars.EMBEDDING_MODEL)) {
      result.warnings.push(`Modèle d'embedding non reconnu: ${envVars.EMBEDDING_MODEL}`);
    }

    // Générer des suggestions
    if (result.missingRequiredKeys.length > 0) {
      result.suggestions.push(`Copiez les clés manquantes depuis .env.reference`);
    }

    if (result.emptyValues.length > 0) {
      result.suggestions.push(`Remplissez les valeurs vides avec les vraies clés API`);
    }

    // Valider la configuration
    result.isValid = result.errors.length === 0 && result.missingRequiredKeys.length === 0;

    if (input.verbose) {
      console.log('=== Analyse .env détaillée ===');
      console.log(`Fichier .env: ${result.envExists ? 'Existe' : 'Manquant'}`);
      console.log(`Fichier .env.reference: ${result.referenceExists ? 'Existe' : 'Manquant'}`);
      console.log(`Taille .env: ${result.envFileSize} octets`);
      console.log(`Taille .env.reference: ${result.referenceFileSize} octets`);
      console.log(`Clés requises manquantes: ${result.missingRequiredKeys.length}`);
      console.log(`Vides: ${result.emptyValues.length}`);
      console.log(`Supplémentaires: ${result.extraKeys.length}`);
      console.log(`Valide: ${result.isValid}`);
    }

    return result;

  } catch (error) {
    result.errors.push(`Erreur lors de l'analyse: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return result;
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Ignorer les lignes vides et les commentaires
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parser la ligne VAR=value
    const match = trimmed.match(/^([^=]+)=(.+)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();

      // Enlever les guillemets si présents
      vars[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return vars;
}