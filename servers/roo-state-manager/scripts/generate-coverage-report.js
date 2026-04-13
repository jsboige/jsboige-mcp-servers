#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coverageDir = join(__dirname, '../coverage/.tmp');
const reportFile = join(__dirname, 'coverage/coverage-report.md');

// Read all coverage files
const fs = await import('fs');
const coverageFiles = fs.readdirSync(coverageDir).filter(file => file.startsWith('coverage-') && file.endsWith('.json'));

let totalFunctions = 0;
let coveredFunctions = 0;
let totalRanges = 0;
let coveredRanges = 0;
let fileCoverage = {};

for (const file of coverageFiles) {
    const coverage = JSON.parse(fs.readFileSync(join(coverageDir, file), 'utf8'));
    const url = coverage.url || '';

    if (!fileCoverage[url]) {
        fileCoverage[url] = { totalLines: 0, coveredLines: 0, functions: [] };
    }

    // Process each function
    if (coverage.functions) {
        coverage.functions.forEach(func => {
            const funcName = func.functionName || 'anonymous';
            const funcRanges = func.ranges || [];

            fileCoverage[url].functions.push({
                name: funcName,
                ranges: funcRanges
            });

            funcRanges.forEach(range => {
                const length = range.endOffset - range.startOffset;
                totalRanges += length;
                totalFunctions++;

                if (range.count > 0) {
                    coveredRanges += length;
                    coveredFunctions++;
                }
            });
        });
    }
}

// Calculate overall coverage
const overallPercentage = totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 100) : 0;
const linePercentage = totalRanges > 0 ? Math.round((coveredRanges / totalRanges) * 100) : 0;

// Generate markdown report
const report = `# Coverage Report

Generated on: ${new Date().toISOString()}
Total Functions: ${totalFunctions}
Covered Functions: ${coveredFunctions}
Overall Coverage: ${overallPercentage}%

## File-by-File Coverage

${Object.entries(fileCoverage).map(([url, data]) => {
    const coveredLines = data.functions.reduce((sum, func) => {
        return sum + func.ranges.reduce((sumRange, range) => {
            const length = range.endOffset - range.startOffset;
            return sumRange + (range.count > 0 ? length : 0);
        }, 0);
    }, 0);

    const totalLines = data.functions.reduce((sum, func) => {
        return sum + func.ranges.reduce((sumRange, range) => {
            return sumRange + (range.endOffset - range.startOffset);
        }, 0);
    }, 0);

    const percentage = totalLines > 0 ? Math.round((coveredLines / totalLines) * 100) : 0;
    const bar = '█'.repeat(Math.round(percentage / 5)) + '░'.repeat(20 - Math.round(percentage / 5));

    return `### ${url}
**Coverage:** ${percentage}% (${coveredLines}/${totalLines} lines)
${bar}`;
}).join('\n')}

## Summary

- **Overall Function Coverage:** ${overallPercentage}% (${coveredFunctions}/${totalFunctions} functions)
- **Overall Line Coverage:** ${linePercentage}% (${coveredRanges}/${totalRanges} lines)
- **Files Processed:** ${Object.keys(fileCoverage).length}
`;

writeFileSync(reportFile, report);
console.log(`Coverage report generated at: ${reportFile}`);