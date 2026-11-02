/**
 * #4149 — injection fermée dans refresh-dashboard : preuve COMPORTEMENTALE.
 *
 * Ce fichier exécute un VRAI PowerShell (PowerShellExecutor réel, spawn sans
 * shell) et prouve la propriété demandée par la review :
 *   « apostrophe dans la valeur = littéral, pas d'exécution »
 *
 * Trois jambes :
 *   1. POSITIVE  — la payload à apostrophe revient byte-identique sur stdout
 *                  (le script .ps1 reçoit un littéral, pas du code parsé) ;
 *   2. NÉGATIVE  — un marqueur de fichier que la payload *essaierait* de créer
 *                  n'existe pas (aucune exécution) ;
 *   3. CONTRÔLE  — la même payload rejouée via l'ANCIENNE construction
 *                  (`pwsh -c "& '…' -Baseline '<payload>' …"`, exec + shell)
 *                  CRÉE le marqueur : le témoin sait détecter l'injection,
 *                  la jambe 2 n'est pas une vacuité.
 *
 * CI : ubuntu-22.04 porte pwsh ; si aucun binaire PowerShell n'est résoluble,
 * le fichier se skip (garde de plateforme, précédent « CI-excluded: platform
 * (PowerShell) »). Le script cible du dépôt PARENT n'est pas requis : ce fichier
 * utilise son propre script-écho temporaire (la dépendance parent est couverte
 * en intégration mockée).
 *
 * @module tools/roosync/__tests__/refresh-dashboard.injection.test
 * @version 1.0.0 (#4149)
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Le setup global (jest.setup.js, Fix #634) mock PowerShellExecutor pour TOUTE la
// suite — ce fichier veut le VRAI (spawn réel) : importActual, jamais le mock.
const { PowerShellExecutor } = await vi.importActual<
  typeof import('../../../services/PowerShellExecutor.js')
>('../../../services/PowerShellExecutor.js');

/** Résout un binaire PowerShell exécutable, ou null si aucun. */
function resolvePowerShellBinary(): string | null {
  for (const bin of ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']) {
    try {
      const r = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 10_000 });
      if (r.status === 0) return bin;
    } catch {
      // binaire absent du PATH — candidat suivant
    }
  }
  return null;
}

const BIN = resolvePowerShellBinary();

describe('#4149 refresh-dashboard : argv sans shell (spawn réel)', () => {
  let workDir: string;
  let scriptPath: string;
  let markerPath: string;
  /** Payload d'injection : littéral pour argv, CODE si une couche pwsh la parse.
   *  Mécanisme : l'apostrophe ferme la chaîne du paramètre, `;` ouvre l'exécution,
   *  et `#` commente le reste interpolé (`' -OutputDir '…`) pour garder le -c
   *  PARSEABLE — sans lui, le parseur global de pwsh rejette la commande entière
   *  avant toute exécution (mesuré : marqueur ABSENT, erreur «Unexpected token»). */
  let payload: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'rdash-4149-'));
    scriptPath = join(workDir, 'echo-args.ps1');
    markerPath = join(workDir, 'pwned-4149.marker');
    payload = `x'; New-Item -ItemType File -Path '${markerPath}' > $null; #`;

    // Script-écho : rend les paramètres BRUTS sur stdout, rien d'autre.
    writeFileSync(
      scriptPath,
      [
        'param([string]$Baseline = "", [string]$OutputDir = "")',
        'Write-Output ("BASELINE=[" + $Baseline + "]")',
        'Write-Output ("OUTPUTDIR=[" + $OutputDir + "]")',
        'exit 0'
      ].join('\n'),
      'utf8'
    );
  });

  afterAll(() => {
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test.skipIf(BIN === null)('jambe 1+2 : la payload à apostrophe est un littéral et ne s\'exécute pas', async () => {
    const executor = new PowerShellExecutor({ roosyncBasePath: workDir, powershellPath: BIN! });
    const result = await executor.executeScript(
      scriptPath,
      ['-Baseline', payload, '-OutputDir', join(workDir, 'out')],
      { cwd: workDir, timeout: 15_000 }
    );

    // Jambe positive : la valeur revient byte-identique, délimitée par les []
    // du script-écho — aucune couche n'a interprété l'apostrophe.
    expect(result.success).toBe(true);
    expect(result.stdout).toContain(`BASELINE=[${payload}]`);

    // Jambe négative : le marqueur que la payload créerait SI elle était parsée
    expect(existsSync(markerPath)).toBe(false);
  });

  test.skipIf(BIN === null)("contrôle : l'ANCIENNE forme (interpolation -c) exécute la même payload — le témoin détecte l'injection", () => {
    // Réplique de la construction d'avant #4149 (refresh-dashboard.ts l.107) :
    // valeurs interpolées entre apostrophes dans un -c. La couche cmd d'exec
    // historique n'est pas reproduite (portabilité Linux CI) — l'injection vit
    // dans le PARSING pwsh du -c, pas dans la couche cmd.
    const inner = `& '${scriptPath}' -Baseline '${payload}' -OutputDir '${join(workDir, 'out')}'`;
    // Exit non nul toléré : la queue déparenthésée `''` peut faire râler pwsh
    // APRÈS que New-Item a joué — ce qui compte est le marqueur, pas l'exit.
    spawnSync(BIN!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-c', inner], { timeout: 15_000 });

    // La preuve que le témoin n'est pas aveugle : l'ancienne forme CRÉE le marqueur.
    expect(existsSync(markerPath)).toBe(true);
  });
});
