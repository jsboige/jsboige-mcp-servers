/**
 * Anti-Stub Detection Tests (#815)
 *
 * Ces tests détectent les méthodes stub dans le code exporté/exposé.
 * Un stub est du code qui prétend fonctionner mais retourne des données
 * fabricées (null, hardcoded values, throw Not Implemented).
 *
 * OBJECTIF: Empêcher que des stubs soient exposés comme du vrai code.
 * Si ce test échoue, un stub a été introduit — il faut l'implémenter ou le retirer.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../');

/**
 * Scanne récursivement les fichiers TypeScript du répertoire src/
 */
function getAllTsFiles(dir: string): string[] {
	const files: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && !entry.name.startsWith('__') && entry.name !== 'node_modules') {
			files.push(...getAllTsFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
			files.push(fullPath);
		}
	}
	return files;
}

describe('Anti-Stub Detection — Source Code Quality Gate', () => {
	const sourceFiles = getAllTsFiles(SRC_DIR);

	it('should have found source files to scan', () => {
		expect(sourceFiles.length).toBeGreaterThan(50);
	});

	it('should NOT contain "throw new Error(.*Not Implemented)" in exported code', () => {
		const violations: { file: string; line: number; content: string }[] = [];

		for (const file of sourceFiles) {
			const content = fs.readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (/throw\s+new\s+Error\s*\(\s*['"`].*[Nn]ot\s+[Ii]mplemented/i.test(lines[i])) {
					violations.push({
						file: path.relative(SRC_DIR, file),
						line: i + 1,
						content: lines[i].trim()
					});
				}
			}
		}

		if (violations.length > 0) {
			const report = violations.map(v => `  ${v.file}:${v.line} — ${v.content}`).join('\n');
			expect.fail(
				`Found ${violations.length} "Not Implemented" stub(s) in source code:\n${report}\n\n` +
				`Either implement the method or remove it from exports.`
			);
		}
	});

	it('should NOT contain hardcoded confidence scores (stub pattern from #767-786)', () => {
		const violations: { file: string; line: number; content: string }[] = [];
		// Pattern: return { ... confidence: 0.85 ... } or similar hardcoded values
		// Only flag if in a function that's supposed to CALCULATE confidence
		const suspiciousPattern = /(?:confidence|score)\s*[:=]\s*0\.\d+/;

		for (const file of sourceFiles) {
			const content = fs.readFileSync(file, 'utf8');
			// Skip config/test files — only check service/tool files
			if (file.includes('config') || file.includes('Config')) continue;

			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (suspiciousPattern.test(line)) {
					// Allow in constructors (default config), type definitions, and documented constants
					const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
					if (context.includes('default') || context.includes('DEFAULT') ||
						context.includes('interface') || context.includes('type ') ||
						context.includes('const ') || context.includes('Config') ||
						context.includes('// ') || context.includes('threshold')) {
						continue; // Legitimate constant or default
					}
					violations.push({
						file: path.relative(SRC_DIR, file),
						line: i + 1,
						content: line.trim()
					});
				}
			}
		}

		// Allow known legitimate usages (e.g., in EnrichContentClassifier where confidence IS the logic)
		const filteredViolations = violations.filter(v =>
			!v.file.includes('EnrichContentClassifier') &&
			!v.file.includes('ContentClassifier') &&
			!v.file.includes('claude-storage-detector')
		);

		if (filteredViolations.length > 0) {
			const report = filteredViolations.map(v => `  ${v.file}:${v.line} — ${v.content}`).join('\n');
			// This is a WARNING, not a hard fail (some may be legitimate)
			console.warn(
				`⚠️ Found ${filteredViolations.length} potential hardcoded confidence/score value(s):\n${report}\n` +
				`Review each to ensure it's not a stub returning fake data.`
			);
		}
	});

	it('should NOT have exported functions that just return null', () => {
		const violations: { file: string; funcName: string; line: number }[] = [];

		for (const file of sourceFiles) {
			const content = fs.readFileSync(file, 'utf8');
			// Match: exported async function that just returns null
			const exportedNullReturn = /export\s+(?:async\s+)?function\s+(\w+)[^{]*\{[\s\n]*return\s+null\s*;?\s*\}/g;
			let match;
			while ((match = exportedNullReturn.exec(content)) !== null) {
				violations.push({
					file: path.relative(SRC_DIR, file),
					funcName: match[1],
					line: content.substring(0, match.index).split('\n').length
				});
			}
		}

		if (violations.length > 0) {
			const report = violations.map(v => `  ${v.file}:${v.line} — export function ${v.funcName}() returns null`).join('\n');
			expect.fail(
				`Found ${violations.length} exported function(s) that just return null:\n${report}\n\n` +
				`Either implement the function or remove the export.`
			);
		}
	});

	it('should NOT have console.log in production code (baseline check)', () => {
		let totalConsoleLog = 0;
		const BASELINE = 800; // Known baseline from po-2023 patrol (767 found)

		for (const file of sourceFiles) {
			// Skip start.ts and test utilities
			if (file.includes('start.ts') || file.includes('build-skeleton-cache')) continue;
			const content = fs.readFileSync(file, 'utf8');
			const matches = content.match(/console\.log\(/g);
			if (matches) totalConsoleLog += matches.length;
		}

		// Soft check: warn if significantly above baseline
		if (totalConsoleLog > BASELINE) {
			console.warn(
				`⚠️ console.log count (${totalConsoleLog}) exceeds baseline (${BASELINE}). ` +
				`New console.log statements may have been introduced.`
			);
		}
		// The count should not increase significantly
		expect(totalConsoleLog).toBeLessThan(BASELINE * 1.2); // 20% tolerance
	});
});
