/**
 * Test script for build_skeleton_cache tool
 * Validates log reduction after fixes
 */

import { buildSkeletonCache } from '../build/tools/cache/build-skeleton-cache.tool.js';

console.log('=== TEST build_skeleton_cache ===\n');
console.log('Parameters: { force_rebuild: true }\n');
console.log('Expected: ~15-20 lines (aggregate logs only)');
console.log('---\n');

// Execute the tool
buildSkeletonCache({ force_rebuild: true })
  .then(result => {
    console.log('\n---');
    console.log('\n=== TEST COMPLETED ===');
    console.log('\nResult:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('\n---');
    console.error('\n=== TEST FAILED ===');
    console.error('\nError:', err.message);
    process.exit(1);
  });