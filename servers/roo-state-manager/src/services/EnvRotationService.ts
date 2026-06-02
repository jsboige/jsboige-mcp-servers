/**
 * EnvRotationService — Rotation déclarative de secrets fleet-wide
 * Issue #2410 — VibeSync Epic #2406 Phase 2
 *
 * Chiffrement AES-256-GCM pour publish/apply de fichiers .env via GDrive RooSync.
 * Clé de chiffrement via ROOSYNC_ENV_KEY (env var obligatoire).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createLogger, Logger } from '../utils/logger.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits — NIST SP 800-38D §5.2.1.1 recommended (fast path, no GHASH derivation needed)
const TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;

export interface EnvPublishOptions {
  service: string;
  envPath: string;
  sharedStatePath: string;
  version: string;
  description?: string;
  machineId: string;
  dryRun?: boolean;
}

export interface EnvPublishResult {
  status: 'success' | 'warning' | 'error';
  message: string;
  encryptedPath: string;
  service: string;
  version: string;
  size: number;
}

export interface EnvApplyOptions {
  service: string;
  targetEnvPath: string;
  sharedStatePath: string;
  backup?: boolean;
  dryRun?: boolean;
}

export interface EnvApplyResult {
  status: 'success' | 'warning' | 'error';
  message: string;
  service: string;
  backupPath?: string;
  keysWritten: number;
}

export class EnvRotationService {
  private logger: Logger;

  constructor() {
    this.logger = createLogger('EnvRotationService');
  }

  /**
   * Récupère la clé de chiffrement depuis ROOSYNC_ENV_KEY.
   * Refuse si absente (sécurité critique).
   */
  private getEncryptionKey(salt: Buffer): Buffer {
    const envKey = process.env.ROOSYNC_ENV_KEY;
    if (!envKey) {
      throw new Error(
        'ROOSYNC_ENV_KEY environment variable is required for env rotation. ' +
        'Set it to a strong passphrase (min 32 chars) before using env: targets.'
      );
    }
    if (envKey.length < 32) {
      throw new Error(
        `ROOSYNC_ENV_KEY too short (${envKey.length} chars). Minimum 32 characters required.`
      );
    }
    // Derive 256-bit key from passphrase using scrypt (OWASP 2024 params)
    // maxmem = N * r * p * 128 + N * r * 256 (approx) — allocate generously
    return scryptSync(envKey, salt, KEY_LENGTH, { N: 32768, r: 8, p: 2, maxmem: 128 * 32768 * 8 * 2 });
  }

  /**
   * Chiffre un buffer avec AES-256-GCM
   */
  encrypt(plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer; salt: Buffer } {
    const salt = randomBytes(SALT_LENGTH);
    const key = this.getEncryptionKey(salt);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { ciphertext, iv, tag, salt };
  }

  /**
   * Déchiffre un buffer avec AES-256-GCM
   */
  decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer, salt: Buffer): Buffer {
    const key = this.getEncryptionKey(salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Sérialise les données chiffrées au format wire (binary)
   * Format: [salt(32)][iv(12)][tag(16)][ciphertext(remaining)]
   */
  serializeEncrypted(encrypted: { ciphertext: Buffer; iv: Buffer; tag: Buffer; salt: Buffer }): Buffer {
    return Buffer.concat([encrypted.salt, encrypted.iv, encrypted.tag, encrypted.ciphertext]);
  }

  /**
   * Désérialise le format wire
   */
  deserializeEncrypted(wire: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer; salt: Buffer } {
    if (wire.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error('Invalid encrypted data: too short');
    }
    const salt = wire.subarray(0, SALT_LENGTH);
    const iv = wire.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = wire.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const ciphertext = wire.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    return { salt, iv, tag, ciphertext };
  }

  /**
   * Publish — chiffre et pousse un .env vers GDrive shared state
   */
  async publish(options: EnvPublishOptions): Promise<EnvPublishResult> {
    const { service, envPath, sharedStatePath, version, description, machineId, dryRun } = options;

    // Read .env file
    if (!existsSync(envPath)) {
      return {
        status: 'error',
        message: `Source .env not found: ${envPath}`,
        encryptedPath: '',
        service,
        version,
        size: 0,
      };
    }

    const envContent = await fs.readFile(envPath, 'utf-8');
    if (envContent.trim().length === 0) {
      return {
        status: 'warning',
        message: `Source .env is empty: ${envPath}`,
        encryptedPath: '',
        service,
        version,
        size: 0,
      };
    }

    // Encrypt
    const plaintext = Buffer.from(envContent, 'utf-8');
    const encrypted = this.encrypt(plaintext);
    const wire = this.serializeEncrypted(encrypted);

    // Build metadata (NOT encrypted — public manifest)
    const metadata = {
      service,
      version,
      description: description || `Env rotation for ${service}`,
      author: machineId,
      timestamp: new Date().toISOString(),
      size: plaintext.length,
      algorithm: ALGORITHM,
    };

    if (dryRun) {
      this.logger.info('[DRY RUN] Would publish env', { service, version, size: plaintext.length });
      return {
        status: 'success',
        message: `[DRY RUN] Would publish ${service} v${version} (${plaintext.length} bytes)`,
        encryptedPath: '',
        service,
        version,
        size: plaintext.length,
      };
    }

    // Write to shared state
    const envDir = join(sharedStatePath, 'env', service);
    mkdirSync(envDir, { recursive: true });

    const encryptedPath = join(envDir, `${version}.enc`);
    await fs.writeFile(encryptedPath, wire, { mode: 0o600 });
    // #2410: mode:0o600 is Unix-only. On Windows, file permissions are ACL-based.
    // For production hardening, apply ACL restrictions via icacls or PowerShell.
    if (process.platform === 'win32') {
      this.logger.warn(`Windows: mode:0o600 ignored for ${encryptedPath}. Apply ACL manually for production.`);
    }

    const metadataPath = join(envDir, `${version}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    this.logger.info(`Published env ${service} v${version}`, { size: plaintext.length });

    return {
      status: 'success',
      message: `Published ${service} v${version} (${plaintext.length} bytes encrypted)`,
      encryptedPath,
      service,
      version,
      size: plaintext.length,
    };
  }

  /**
   * Apply — télécharge, déchiffre et écrit un .env local
   */
  async apply(options: EnvApplyOptions): Promise<EnvApplyResult> {
    const { service, targetEnvPath, sharedStatePath, backup = true, dryRun } = options;

    // Find latest version
    const envDir = join(sharedStatePath, 'env', service);
    if (!existsSync(envDir)) {
      return {
        status: 'error',
        message: `No env published for service: ${service}`,
        service,
        keysWritten: 0,
      };
    }

    // Read all version metadata and pick latest
    const files = await fs.readdir(envDir);
    const versions = files.filter(f => f.endsWith('.json'));

    if (versions.length === 0) {
      return {
        status: 'error',
        message: `No versions found for service: ${service}`,
        service,
        keysWritten: 0,
      };
    }

    // Sort by timestamp in metadata
    let latestVersion = '';
    let latestTimestamp = '';
    for (const v of versions) {
      const metaPath = join(envDir, v);
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      if (meta.timestamp > latestTimestamp) {
        latestTimestamp = meta.timestamp;
        latestVersion = v.replace('.json', '');
      }
    }

    // Read encrypted file
    const encPath = join(envDir, `${latestVersion}.enc`);
    if (!existsSync(encPath)) {
      return {
        status: 'error',
        message: `Encrypted file missing for ${service} v${latestVersion}`,
        service,
        keysWritten: 0,
      };
    }

    const wire = await fs.readFile(encPath);
    const { salt, iv, tag, ciphertext } = this.deserializeEncrypted(wire);
    const plaintext = this.decrypt(ciphertext, iv, tag, salt);
    const envContent = plaintext.toString('utf-8');

    // Validate decrypted content looks like a .env file (Hermes concern #3)
    // Reject binary/corrupted content that doesn't contain at least one KEY=VALUE line
    const hasValidLine = envContent.split('\n').some(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim()));
    if (!hasValidLine) {
      return {
        status: 'error',
        message: `Decrypted content does not appear to be a valid .env file (no KEY=VALUE lines found). ` +
          `Possible key mismatch or data corruption for ${service} v${latestVersion}.`,
        service,
        keysWritten: 0,
      };
    }

    // Parse and count keys
    const keys = envContent.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
    const keysWritten = keys.length;

    if (dryRun) {
      this.logger.info('[DRY RUN] Would apply env', { service, version: latestVersion, keys: keysWritten });
      return {
        status: 'success',
        message: `[DRY RUN] Would apply ${service} v${latestVersion} (${keysWritten} keys) to ${targetEnvPath}`,
        service,
        keysWritten,
      };
    }

    // Backup existing .env
    let backupPath: string | undefined;
    if (backup && existsSync(targetEnvPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${targetEnvPath}.bak.${ts}`;
      await fs.copyFile(targetEnvPath, backupPath);
      this.logger.info(`Backup created: ${backupPath}`);
    }

    // Write new .env
    const targetDir = dirname(targetEnvPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    await fs.writeFile(targetEnvPath, envContent, { encoding: 'utf-8', mode: 0o600 });
    // #2410: mode:0o600 is Unix-only. On Windows, file permissions are ACL-based.
    if (process.platform === 'win32') {
      this.logger.warn(`Windows: mode:0o600 ignored for ${targetEnvPath}. Apply ACL manually for production.`);
    }

    this.logger.info(`Applied env ${service} v${latestVersion}`, { keys: keysWritten });

    return {
      status: 'success',
      message: `Applied ${service} v${latestVersion} (${keysWritten} keys) to ${targetEnvPath}`,
      service,
      backupPath,
      keysWritten,
    };
  }
}
