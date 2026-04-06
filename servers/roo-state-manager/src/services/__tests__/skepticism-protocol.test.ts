/**
 * Tests for skepticism-protocol.md validation
 * Issue #567 Section 5 - Updated for v3.0.0 condensed format
 *
 * These tests verify:
 * 1. The skepticism-protocol.md file exists and has valid format
 * 2. Core skepticism principles are documented
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Path to skepticism-protocol.md files
const CLAUDE_RULES_PATH = path.resolve(__dirname, '../../../../../../../.claude/rules/skepticism-protocol.md')
const ROO_RULES_PATH = path.resolve(__dirname, '../../../../../../../.roo/rules/21-skepticism-protocol.md')

describe('Skepticism Protocol - File Validation', () => {
  it('skepticism-protocol.md exists in .claude/rules/', () => {
    expect(fs.existsSync(CLAUDE_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md exists in .roo/rules/', () => {
    expect(fs.existsSync(ROO_RULES_PATH)).toBe(true)
  })

  it('skepticism-protocol.md has valid markdown structure (v3.0 condensed)', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    // Check for required sections in v3.0 condensed format
    expect(content).toContain('# Protocole de Scepticisme Raisonnable')
    expect(content).toContain('## Principe')
    expect(content).toContain('## Declencheurs')
    expect(content).toContain('## Verification')
    expect(content).toContain('## Regles Anti-Propagation')
  })

  it('skepticism-protocol.md contains version metadata', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('**Version:**')
  })

  it('skepticism-protocol.md documents GPU trigger', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('GPU insuffisante')
  })

  it('skepticism-protocol.md documents verification levels', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Rapide')
    expect(content).toContain('Active')
    expect(content).toContain('Croisee')
  })
})

describe('Skepticism Protocol - Guards Coverage', () => {
  it('verifies claim qualification labels are defined', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('VERIFIE')
    expect(content).toContain('RAPPORTE PAR')
    expect(content).toContain('SUPPOSE')
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

  it('verifies anti-propagation rules for coordinator and executor', () => {
    const content = fs.readFileSync(CLAUDE_RULES_PATH, 'utf-8')

    expect(content).toContain('Coordinateur')
    expect(content).toContain('Executeur')
    expect(content).toContain('JAMAIS')
  })
})
