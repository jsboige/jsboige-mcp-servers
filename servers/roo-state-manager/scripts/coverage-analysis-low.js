#!/usr/bin/env node

import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const coverageDir = join(process.cwd(), 'coverage/.tmp');
const reportFile = join(process.cwd(), 'coverage/low-coverage-analysis.md');

// Read all coverage files
const coverageFiles = readdirSync(coverageDir).filter(file => file.startsWith('coverage-') && file.endsWith('.json'));

console.log(`Analyzing ${coverageFiles.length} coverage files for files with <60% coverage`);

const lowCoverageFiles = [];
const highCoverageFiles = [];

// Process coverage files
for (const file of coverageFiles) {
    try {
        const coverageData = readFileSync(join(coverageDir, file), 'utf8');
        const coverage = JSON.parse(coverageData);

        let totalRanges = 0;
        let coveredRanges = 0;
        let fileName = 'unknown';

        if (coverage.result && coverage.result.length > 0) {
            for (const script of coverage.result) {
                fileName = script.url ? script.url.split('/').pop() : 'unknown';

                // Process ranges directly
                if (script.ranges) {
                    for (const range of script.ranges) {
                        totalRanges++;
                        if (range.count > 0) {
                            coveredRanges++;
                        }
                    }
                }

                // Process functions
                if (script.functions) {
                    for (const func of script.functions) {
                        if (func.ranges) {
                            for (const range of func.ranges) {
                                totalRanges++;
                                if (range.count > 0) {
                                    coveredRanges++;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Calculate percentage
        const percentage = totalRanges > 0 ? Math.round((coveredRanges / totalRanges) * 100) : 0;

        if (percentage < 60) {
            lowCoverageFiles.push({
                file: fileName,
                coverage: percentage,
                covered: coveredRanges,
                total: totalRanges
            });
        } else {
            highCoverageFiles.push({
                file: fileName,
                coverage: percentage,
                covered: coveredRanges,
                total: totalRanges
            });
        }

    } catch (e) {
        console.error(`Error processing ${file}:`, e.message);
    }
}

// Sort by coverage percentage (lowest first)
lowCoverageFiles.sort((a, b) => a.coverage - b.coverage);
highCoverageFiles.sort((a, b) => b.coverage - a.coverage);

// Generate markdown report
const report = `# Coverage Analysis - Files with <60% Coverage

Generated on: ${new Date().toISOString()}
**Threshold:** Files with coverage below 60%

## Summary

- **Total Files Analyzed:** ${coverageFiles.length}
- **Files with <60% coverage:** ${lowCoverageFiles.length}
- **Files with ≥60% coverage:** ${highCoverageFiles.length}

## Files Needing Improvement (<60% Coverage)

${lowCoverageFiles.length > 0 ? lowCoverageFiles.map(item =>
    `### ${item.file}
- **Coverage:** ${item.coverage}% (${item.covered}/${item.total} ranges)`
).join('\n\n') : 'No files with <60% coverage found.'}

## Well-Covered Files (≥60% coverage)

${highCoverageFiles.length > 0 ? highCoverageFiles.slice(0, 20).map(item =>
    `### ${item.file}
- **Coverage:** ${item.coverage}% (${item.covered}/${item.total} ranges)`
).join('\n\n') : 'No files with ≥60% coverage found.'}

${highCoverageFiles.length > 20 ? `\n... and ${highCoverageFiles.length - 20} more files with ≥60% coverage` : ''}

## Recommendations

${lowCoverageFiles.length > 0 ?
    `Focus on improving coverage for the ${lowCoverageFiles.length} files with <60% coverage:
    - ${lowCoverageFiles.slice(0, 5).map(f => f.file).join(', ')}
    - ${lowCoverageFiles.length > 5 ? `... and ${lowCoverageFiles.length - 5} more` : ''}` :
    'All files have good coverage (≥60%). Consider increasing coverage target.'}
`;

writeFileSync(reportFile, report);
console.log(`Low coverage analysis report generated at: ${reportFile}`);
console.log(`Found ${lowCoverageFiles.length} files with <60% coverage`);