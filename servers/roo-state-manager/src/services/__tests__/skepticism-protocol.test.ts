/**
 * Tests for skepticism-protocol.md validation
 * Issue #567 Section 5 - Assigned to myia-po-2024
 *
 * These tests verify:
 * 1. The skepticism-protocol.md file exists and has valid format
 * 2. The anti-patterns documented are covered by guards
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Path to skepticism-protocol.md files
const CLAUDE_RULES_PATH = path.resolve(__dirname, '../../../../../../../.claude/rules/skepticism-protocol.md')
const ROO_RULES_PATH = path.resolve(__dirname, '../../../../../../../.roo/rules/20-skepticism-protocol.md')

describe('Skepticism Protocol - File Validation', () => {
  it('skepticism-protocol.md exists in .claude/rules/', () => {
    expect(fs.existsSync(CLAUDE_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md exists in .roo/rules/', () => {
    expect(fs.existsSync(ROO_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md has valid markdown structure', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    // Check for required sections
    expect(content).toContain('# Protocole de Scepticisme Raisonnable')
    expect(content).toContain('## Principe')
    expect(content).toContain('## Declencheurs de Scepticisme')
    expect(content).toContain('## Protocole de Verification')
    expect(content).toContain('## Regles Anti-Propagation')
    expect(content).toContain('## Anti-Patterns Documentes')
  })

  it('skepticism-protocol.md contains version metadata', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('**Version:**')
    expect(content).toContain('**Cree:**')
  })

  it('skepticism-protocol.md documents GPU anti-pattern', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('GPU insuffisante')
    expect(content).toContain('GPU Fleet')
  })

  it('skepticism-protocol.md documents machine silence anti-pattern', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('machine "silencieuse"')
    expect(content).toContain('Verifier inbox complet')
  })

  it('skepticism-protocol.md documents duplicate work anti-pattern', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Dupliquer le travail')
    expect(content).toContain('Claim protocol')
  })
})

describe('Skepticism Protocol - Guards Coverage', () => {
  it('verifies verification levels are defined (Niveau 1-3)', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Niveau 1')
    expect(content).toContain('Niveau 2')
    expect(content).toContain('Niveau 3')
  })

  it('verifies claim qualification labels are defined', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('VERIFIE')
    expect(content).toContain('RAPPORTE PAR')
    expect(content).toContain('SUPPOSE')
  })

  it('verifies reference sources are documented', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('GPU Fleet')
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
  it('documents integration with /coordinate command', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('/coordinate')
    expect(content).toContain('Verifier les rapports AVANT de dispatcher')
  })

  it('documents integration with /executor command', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('/executor')
    expect(content).toContain('Verifier les premisses des instructions recues')
  })

  it('documents integration with roosync-hub agent', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('roosync-hub')
    expect(content).toContain('Croiser rapports avec git/GitHub')
  })
})
