#!/usr/bin/env node

import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const coverageDir = join(process.cwd(), 'coverage/.tmp');
const reportFile = join(process.cwd(), 'coverage/final-report.md');

// Read all coverage files
const coverageFiles = readdirSync(coverageDir).filter(file => file.startsWith('coverage-') && file.endsWith('.json'));

let totalFiles = 0;
let coveredFiles = 0;
let totalFunctions = 0;
let coveredFunctions = 0;

const fileReports = [];

for (const file of coverageFiles) {
    try {
        const coverage = JSON.parse(readFileSync(join(coverageDir, file), 'utf8'));
        const url = coverage.url || 'unknown';

        let fileFunctionCount = 0;
        let fileCoveredCount = 0;

        if (coverage.functions) {
            coverage.functions.forEach(func => {
                fileFunctionCount++;
                if (func.ranges) {
                    func.ranges.forEach(range => {
                        if (range.count > 0) {
                            fileCoveredCount++;
                        }
                    });
                }
            });
        }

        totalFiles++;
        if (fileCoveredCount > 0) {
            coveredFiles++;
        }
        totalFunctions += fileFunctionCount;
        coveredFunctions += fileCoveredCount;

        const percentage = fileFunctionCount > 0 ? Math.round((fileCoveredCount / fileFunctionCount) * 100) : 0;
        const bar = '█'.repeat(Math.min(Math.floor(percentage / 5), 20)) + '░'.repeat(Math.max(0, 20 - Math.min(Math.floor(percentage / 5), 20)));

        fileReports.push(`### ${url}
**Function Coverage:** ${percentage}% (${fileCoveredCount}/${fileFunctionCount} functions)
${bar}`);
    } catch (e) {
        console.error(`Error processing ${file}:`, e.message);
    }
}

// Calculate overall coverage
const fileCoverage = totalFiles > 0 ? Math.round((coveredFiles / totalFiles) * 100) : 0;
const functionCoverage = totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 100) : 0;

// Generate markdown report
const report = `# Coverage Report - Final Summary

Generated on: ${new Date().toISOString()}
**Note:** Generated from existing V8 coverage data files

## Overall Statistics

- **Total Files:** ${totalFiles}
- **Covered Files:** ${coveredFiles}
- **Overall File Coverage:** ${fileCoverage}%

- **Total Functions:** ${totalFunctions}
- **Covered Functions:** ${coveredFunctions}
- **Overall Function Coverage:** ${functionCoverage}%

## File-by-File Results

${fileReports.join('\n\n')}

## Coverage Summary

${fileCoverage > 80 ? '🟢 Excellent' : fileCoverage > 60 ? '🟡 Good' : '🔅 Needs Improvement'} coverage with ${functionCoverage}% of all functions covered.

Coverage data processed from ${coverageFiles.length} V8 coverage files in the coverage/.tmp/ directory.
`;

writeFileSync(reportFile, report);
console.log(`Final coverage report generated at: ${reportFile}`);
console.log(`Overall coverage: ${functionCoverage}% (${coveredFunctions}/${totalFunctions} functions)`);