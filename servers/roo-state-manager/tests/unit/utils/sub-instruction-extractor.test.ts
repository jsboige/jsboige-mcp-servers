import { describe, it, expect } from 'vitest';
import { extractSubInstructions } from '../../../src/utils/sub-instruction-extractor.js';

describe('extractSubInstructions', () => {
  it('returns empty array for empty string', () => {
    expect(extractSubInstructions('')).toEqual([]);
  });

  it('returns empty array for null-ish input', () => {
    expect(extractSubInstructions(null as any)).toEqual([]);
    expect(extractSubInstructions(undefined as any)).toEqual([]);
  });

  // Pattern 1: <new_task> XML tags
  it('extracts instructions from new_task XML tags', () => {
    const text = `<new_task mode="code"><message>Create the component with validation logic and error handling.</message></new_task>`;
    const result = extractSubInstructions(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Create the component');
  });

  it('extracts multiple new_task messages', () => {
    const text = '<new_task mode="code"><message>First task with enough length here.</message></new_task><new_task mode="ask"><message>Second task also with sufficient length.</message></new_task>';
    const result = extractSubInstructions(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some(r => r.includes('First task'))).toBe(true);
    expect(result.some(r => r.includes('Second task'))).toBe(true);
  });

  it('ignores short new_task messages (<10 chars)', () => {
    const text = `<new_task><message>short</message></new_task>`;
    expect(extractSubInstructions(text)).toEqual([]);
  });

  // Pattern 2: Code blocks
  it('extracts code blocks with enough content', () => {
    const text = '```typescript\nexport class UserManager {\n  createUser() {}\n}\n```';
    const result = extractSubInstructions(text);
    expect(result.some(r => r.includes('UserManager'))).toBe(true);
  });

  it('ignores short code blocks (<20 chars)', () => {
    const text = '```js\nshort\n```';
    expect(extractSubInstructions(text)).toEqual([]);
  });

  // Pattern 3: Bullet points
  it('extracts bullet point instructions', () => {
    const text = `
- Create the configuration file with proper defaults
- Implement the validation logic for inputs
    `;
    const result = extractSubInstructions(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores short bullet points (<10 chars)', () => {
    const text = '- short\n- tiny';
    expect(extractSubInstructions(text)).toEqual([]);
  });

  // Pattern 4: Numbered lists
  it('extracts numbered list instructions', () => {
    const text = `
1. Analyze the requirements and constraints
2. Develop the architecture for the system
    `;
    const result = extractSubInstructions(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  // Pattern 5: <task> XML tags
  it('extracts task XML tags', () => {
    const text = '<task>Create the main component with all required functionality</task>';
    const result = extractSubInstructions(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('main component');
  });

  // Pattern 6: Nested indentation
  it('extracts indented instructions', () => {
    const text = `Tasks:
   Create the unit test file for the module
   Implement integration tests for API`;
    const result = extractSubInstructions(text);
    expect(result.some(r => r.includes('unit test'))).toBe(true);
  });

  it('ignores indented comments starting with //', () => {
    const text = '  // this is a comment that is long enough';
    const result = extractSubInstructions(text);
    expect(result.every(r => !r.includes('// this is'))).toBe(true);
  });

  // Deduplication
  it('deduplicates identical instructions', () => {
    const text = `
- Create the configuration file with defaults
- Create the configuration file with defaults
`;
    const result = extractSubInstructions(text);
    const configItems = result.filter(r => r.includes('configuration file'));
    expect(configItems).toHaveLength(1);
  });

  // Combined patterns
  it('extracts from mixed pattern types', () => {
    const text = `
1. Analyze the architecture requirements

<new_task mode="code"><message>Implement the service layer with proper error handling and logging.</message></new_task>

- Deploy the updated configuration to staging
`;
    const result = extractSubInstructions(text);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('filters instructions shorter than 10 chars', () => {
    const text = '- tiny\n- This is a proper instruction with enough text';
    const result = extractSubInstructions(text);
    expect(result.every(r => r.length > 10)).toBe(true);
  });

  it('trims whitespace from extracted instructions', () => {
    const text = '  -   Instruction with leading and trailing spaces   ';
    const result = extractSubInstructions(text);
    result.forEach(r => {
      expect(r).toBe(r.trim());
    });
  });
});
