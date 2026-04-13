#!/usr/bin/env node

import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const coverageDir = join(process.cwd(), 'coverage/.tmp');
const reportFile = join(process.cwd(), 'coverage/processed-coverage-report.md');

// Read all coverage files
const coverageFiles = readdirSync(coverageDir).filter(file => file.startsWith('coverage-') && file.endsWith('.json'));

console.log(`Processing ${coverageFiles.length} coverage files`);

let totalFiles = 0;
let coveredFiles = 0;
let totalRanges = 0;
let coveredRanges = 0;
let totalFunctions = 0;
let coveredFunctions = 0;

const fileReports = [];

for (const file of coverageFiles) { // Process all files
    try {
        const coverageData = readFileSync(join(coverageDir, file), 'utf8');
        const coverage = JSON.parse(coverageData);

        // V8 coverage format has scripts array
        if (coverage.result && coverage.result.length > 0) {
            for (const script of coverage.result) {
                // Handle missing script.url
                if (!script.url) {
                    continue; // Skip scripts without URL
                }
                const url = script.url;

                // Process each function/range in the script
                if (script.functions) {
                    for (const func of script.functions) {
                        totalFunctions++;

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

                // Process ranges directly (alternative way V8 reports coverage)
                if (script.ranges) {
                    for (const range of script.ranges) {
                        totalRanges++;
                        if (range.count > 0) {
                            coveredRanges++;
                        }
                    }
                }
            }
        }

        totalFiles++;
        if (coveredRanges > 0) {
            coveredFiles++;
        }

        // Calculate percentage for this file
        const percentage = totalRanges > 0 ? Math.round((coveredRanges / totalRanges) * 100) : 0;
        const bar = '█'.repeat(Math.min(Math.floor(percentage / 5), 20)) + '░'.repeat(Math.max(0, 20 - Math.min(Math.floor(percentage / 5), 20)));

        fileReports.push(`### ${url.substring(url.lastIndexOf('/') + 1) || url}
**Coverage:** ${percentage}% (${coveredRanges}/${totalRanges} ranges)
${bar}`);

        // Reset counters for next file
        coveredRanges = 0;
        totalRanges = 0;

    } catch (e) {
        console.error(`Error processing ${file}:`, e.message);
    }
}

// Calculate overall coverage
const fileCoverage = totalFiles > 0 ? Math.round((coveredFiles / totalFiles) * 100) : 0;
const rangeCoverage = totalRanges > 0 ? Math.round((coveredRanges / totalRanges) * 100) : 0;
const functionCoverage = totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 100) : 0;

// Generate markdown report
const report = `# Coverage Report - Processed from V8 Data

Generated on: ${new Date().toISOString()}
**Note:** Generated directly from V8 coverage data files

## Overall Statistics

- **Total Files:** ${totalFiles}
- **Covered Files:** ${coveredFiles}
- **Overall File Coverage:** ${fileCoverage}%

- **Total Ranges:** ${totalRanges}
- **Covered Ranges:** ${coveredRanges}
- **Overall Range Coverage:** ${rangeCoverage}%

- **Total Functions:** ${totalFunctions}
- **Covered Functions:** ${coveredFunctions}
- **Overall Function Coverage:** ${functionCoverage}%

## Sample File-by-File Results (First 50 Files)

${fileReports.join('\n\n')}

## Coverage Summary

${rangeCoverage > 70 ? '🟢 Good' : rangeCoverage > 50 ? '🟡 Fair' : '🔅 Needs Improvement'} coverage with ${rangeCoverage}% of code ranges covered.

Coverage data processed from ${coverageFiles.length} V8 coverage files in the coverage/.tmp/ directory.
`;

writeFileSync(reportFile, report);
console.log(`Processed coverage report generated at: ${reportFile}`);
console.log(`Overall coverage: ${rangeCoverage}% (${coveredRanges}/${totalRanges} ranges)`);