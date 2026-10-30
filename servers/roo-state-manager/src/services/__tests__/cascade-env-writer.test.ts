/**
 * #4427 PR3 — tests de la réécriture du `.env` d'un siège.
 *
 * Ce que ces tests VERROUILLENT : `apply` est une réécriture LIGNE À LIGNE, pas
 * une régénération. Un `.env` de siège contient des secrets, des ports, des
 * commentaires et un ordre voulu ; tout ce qui n'est pas une clé de cascade doit
 * ressortir OCTET POUR OCTET, fins de ligne comprises. Une réécriture qui
 * « normalise » le fichier est un incident de déploiement, pas un détail
 * cosmétique — c'est exactement ce que le parc flotte ne peut pas se permettre.
 *
 * @module services/__tests__/cascade-env-writer
 */

import { describe, test, expect } from 'vitest';
import { applyCascadeWrites } from '../cascade-env-writer.js';
import type { CascadeWrite } from '../cascade-sync.js';

function w(key: string, value: string, before: string | null = null): CascadeWrite {
    return { key, value, before };
}

describe('applyCascadeWrites — préservation', () => {
    test('remplace EN PLACE la clé visée, sans déplacer les autres lignes', () => {
        const text = ['# cascade du siège', 'A=1', 'CLAUDISH_FAILOVER_AUTO = 0', 'B=2', ''].join('\n');
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1', '0')]);

        expect(out.written).toEqual(['CLAUDISH_FAILOVER_AUTO']);
        expect(out.appended).toEqual([]);
        // La ligne a changé, les autres sont intactes ET dans le même ordre.
        expect(out.text.split('\n')).toEqual([
            '# cascade du siège',
            'A=1',
            'CLAUDISH_FAILOVER_AUTO=1',
            'B=2',
            '',
        ]);
        expect(out.preservedLines).toBe(4);
    });

    test('MUTANT — CRLF préservé de bout en bout (un déploiement LF casserait le siège)', () => {
        const text = 'A=1\r\nCLAUDISH_FAILOVER_AUTO=0\r\nB=2\r\n';
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.eol).toBe('\r\n');
        expect(out.text).toBe('A=1\r\nCLAUDISH_FAILOVER_AUTO=1\r\nB=2\r\n');
    });

    test('commentaires, lignes vides et clés du siège survivent littéralement', () => {
        const text = ['# ne pas toucher', '', 'ANTHROPIC_API_KEY = sk-ant-xyz', 'UNRELATED =  keep me  ', ''].join('\n');
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_SONNET', 'kc@k3')]);
        expect(out.text.startsWith('# ne pas toucher\n\nANTHROPIC_API_KEY = sk-ant-xyz\nUNRELATED =  keep me  \n')).toBe(true);
        expect(out.text).toContain('sk-ant-xyz');
    });

    test('MUTANT — le style de guillemets de la ligne d’origine est repris', () => {
        const text = 'CLAUDISH_FAILOVER_AUTO="0"\n';
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('CLAUDISH_FAILOVER_AUTO="1"\n');

        const single = applyCascadeWrites("CLAUDISH_FAILOVER_AUTO='0'\n", [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(single.text).toBe("CLAUDISH_FAILOVER_AUTO='1'\n");

        const bare = applyCascadeWrites('CLAUDISH_FAILOVER_AUTO=0\n', [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(bare.text).toBe('CLAUDISH_FAILOVER_AUTO=1\n');
    });

    test('un préfixe `export` est conservé', () => {
        const out = applyCascadeWrites('export CLAUDISH_FAILOVER_AUTO=0\n', [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('export CLAUDISH_FAILOVER_AUTO=1\n');
    });

    test('les espaces autour du nom de clé ne sont pas reproduits (ligne canonique)', () => {
        const out = applyCascadeWrites('CLAUDISH_FAILOVER_AUTO   =   0\n', [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('CLAUDISH_FAILOVER_AUTO=1\n');
        expect(out.written).toEqual(['CLAUDISH_FAILOVER_AUTO']);
    });
});

describe('applyCascadeWrites — ajout de clés absentes', () => {
    test('MUTANT — une clé planifiée absente est AJOUTÉE et rapportée (jamais perdue en silence)', () => {
        const text = '# siège\nA=1\n';
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.appended).toEqual(['CLAUDISH_FAILOVER_AUTO']);
        expect(out.written).toEqual([]);
        // L'ajout se fait AVANT le segment final vide : pas de ligne fantôme.
        expect(out.text).toBe('# siège\nA=1\nCLAUDISH_FAILOVER_AUTO=1\n');
    });

    test('ajout sur un fichier sans saut de ligne final : la dernière ligne reste entière', () => {
        const out = applyCascadeWrites('A=1', [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('A=1\nCLAUDISH_FAILOVER_AUTO=1');
    });

    test('plusieurs ajouts gardent l’ordre du plan', () => {
        const out = applyCascadeWrites('A=1\n', [w('CLAUDISH_FAILOVER_SONNET', 'kc@k3'), w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('A=1\nCLAUDISH_FAILOVER_SONNET=kc@k3\nCLAUDISH_FAILOVER_AUTO=1\n');
    });
});

describe('applyCascadeWrites — cas limites', () => {
    test('aucune écriture = texte identique (idempotence parfaite)', () => {
        const text = 'A=1\r\nB=2\r\n';
        const out = applyCascadeWrites(text, []);
        expect(out.text).toBe(text);
        expect(out.written).toEqual([]);
        expect(out.appended).toEqual([]);
    });

    test('une seule écriture par clé : la seconde occurrence d’une clé dupliquée reste intacte', () => {
        // Comportement explicite : le plan porte UNE valeur par clé, on n'écrit
        // qu'une ligne. Le doublon est une anomalie du siège, pas à « réparer »
        // en silence par l'instrument.
        const text = 'CLAUDISH_FAILOVER_AUTO=0\nCLAUDISH_FAILOVER_AUTO=0\n';
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('CLAUDISH_FAILOVER_AUTO=1\nCLAUDISH_FAILOVER_AUTO=0\n');
        expect(out.written).toEqual(['CLAUDISH_FAILOVER_AUTO']);
    });

    test('une ligne sans `=` ou un commentaire déguisé n’est jamais confondu avec une clé', () => {
        const text = ['# CLAUDISH_FAILOVER_AUTO=9', 'NOEQUALS', 'CLAUDISH_FAILOVER_AUTO=0', ''].join('\n');
        const out = applyCascadeWrites(text, [w('CLAUDISH_FAILOVER_AUTO', '1')]);
        expect(out.text).toBe('# CLAUDISH_FAILOVER_AUTO=9\nNOEQUALS\nCLAUDISH_FAILOVER_AUTO=1\n');
        expect(out.written).toEqual(['CLAUDISH_FAILOVER_AUTO']);
    });

    test('une valeur contenant `=` est intégralement écrite', () => {
        const out = applyCascadeWrites('CLAUDISH_FAILOVER_SONNET=x\n', [w('CLAUDISH_FAILOVER_SONNET', 'a@b>c@d=e')]);
        expect(out.text).toBe('CLAUDISH_FAILOVER_SONNET=a@b>c@d=e\n');
    });
});
