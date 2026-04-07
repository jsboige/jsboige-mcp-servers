/**
 * Tests for skepticism-protocol.md validation
 * Issue #567 Section 5 - Updated for v3.0.0 condensed format
 *
 * These tests verify:
 * 1. The skepticism-protocol.md file exists and has valid format
 * 2. Key content elements are present in the condensed v3.0.0 format
 *
 * NOTE: These tests read files from the PARENT roo-extensions repo,
 * so they are excluded from CI (vitest.config.ci.ts).
 * The fs module is globally mocked in jest.setup.js, so we must
 * unmock it to read real files.
 */

import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'

// Unmock fs to read real files from the parent repo
vi.unmock('fs');
vi.unmock('fs/promises');

// Import fs AFTER unmocking
import * as fs from 'fs'

// Path to skepticism-protocol.md - resolve from the roo-state-manager root
// up to the roo-extensions repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const CLAUDE_RULES_PATH = path.resolve(REPO_ROOT, '.claude/rules/skepticism-protocol.md');
const ROO_RULES_PATH = path.resolve(REPO_ROOT, '.roo/rules/21-skepticism-protocol.md');

describe('Skepticism Protocol - File Validation', () => {
  it('skepticism-protocol.md exists in .claude/rules/', () => {
    expect(fs.existsSync(CLAUDE_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md exists in .roo/rules/', () => {
    expect(fs.existsSync(ROO_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md has valid markdown structure (v3.0 condensed)', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    // Check for required sections (v3.0.0 condensed format)
    expect(content).toContain('# Protocole de Scepticisme Raisonnable')
    expect(content).toContain('## Principe')
    expect(content).toContain('## Qualification Obligatoire')
    expect(content).toContain('## Declencheurs')
    expect(content).toContain('## Verification')
    expect(content).toContain('## Regles Anti-Propagation')
  })

  it('skepticism-protocol.md contains version metadata', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('**Version:**')
    expect(content).toContain('**MAJ:**')
  })

  it('skepticism-protocol.md documents GPU anti-pattern trigger', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('GPU insuffisante')
  })

  it('skepticism-protocol.md documents qualification labels', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('VERIFIE')
    expect(content).toContain('RAPPORTE PAR')
    expect(content).toContain('SUPPOSE')
  })

  it('skepticism-protocol.md documents verification levels', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Rapide')
    expect(content).toContain('Active')
    expect(content).toContain('Croisee')
  })
})

describe('Skepticism Protocol - Guards Coverage', () => {
  it('verifies verification levels are defined', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    // v3.0.0 uses "Rapide", "Active", "Croisee" instead of "Niveau 1-3"
    expect(content).toContain('Rapide')
    expect(content).toContain('Active')
    expect(content).toContain('Croisee')
  })

  it('verifies reference sources are documented', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('CLAUDE.md')
    expect(content).toContain('MEMORY.md')
  })

  it('verifies critical fact about LLM API architecture is documented', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    // This is a critical guard against "GPU insuffisante" panic
    expect(content).toContain('ai-01 via API')
    expect(content).toContain('vLLM ou z.ai')
    expect(content).toContain('pas localement sur les executeurs')
  })
})

describe('Skepticism Protocol - Integration Points', () => {
  it('documents anti-propagation rules for coordinateur', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Coordinateur')
    expect(content).toContain('JAMAIS')
  })

  it('documents anti-propagation rules for executeur', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Executeur')
    expect(content).toContain('impossible')
  })

  it('documents the smell test triggers', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Declencheurs')
    expect(content).toContain('PAUSE et VERIFIE')
  })
})
