const fs = require('fs');
const coverage = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'));
const targetFiles = [
  'config.ts', 'apply-config.ts', 'collect-config.ts', 'compare-config.ts',
  'publish-config.ts', 'mcp-management.ts', 'storage-management.ts', 'modes-management.ts'
];

const lowCoverageFiles = [];

Object.entries(coverage).forEach(([filePath, data]) => {
  const fileName = filePath.split('/').pop();
  if (targetFiles.includes(fileName)) {
    const lineCov = data.summary?.lines?.pct || 0;
    console.log(`${fileName}: ${lineCov}% line coverage`);
    if (lineCov < 60) {
      lowCoverageFiles.push({ file: fileName, coverage: lineCov });
    }
  }
});

console.log('\n--- Files below 60% coverage ---');
lowCoverageFiles.forEach(f => console.log(`${f.file}: ${f.coverage}%`));
