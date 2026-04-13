#!/usr/bin/env node

import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const coverageDir = join(process.cwd(), 'coverage/.tmp');
const reportFile = join(process.cwd(), 'coverage/quick-report.txt');

// Read all coverage files
const coverageFiles = readdirSync(coverageDir).filter(file => file.startsWith('coverage-') && file.endsWith('.json'));

console.log(`Found ${coverageFiles.length} coverage files`);

let totalSize = 0;
let fileCount = 0;

// Calculate simple statistics
coverageFiles.forEach(file => {
    const stats = readFileSync(join(coverageDir, file), 'utf8');
    const size = stats.length;
    totalSize += size;
    fileCount++;
});

// Generate a simple report
const report = `Quick Coverage Report
====================
Generated: ${new Date().toISOString()}
Coverage Files: ${coverageFiles.length}
Total Size: ${(totalSize / 1024).toFixed(2)} KB

Largest files:
${coverageFiles
    .map(file => ({
        name: file,
        size: readFileSync(join(coverageDir, file), 'utf8').length
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map(file => `- ${file.name}: ${(file.size / 1024).toFixed(2)} KB`)
    .join('\n')}

All coverage files processed successfully.
`;

writeFileSync(reportFile, report);
console.log(`Quick report generated at: ${reportFile}`);