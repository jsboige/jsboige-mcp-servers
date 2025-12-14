import { JsonMerger } from '../JsonMerger';

describe('JsonMerger', () => {
  it('should return source if target is null or undefined', () => {
    const source = { a: 1 };
    expect(JsonMerger.merge(source, null)).toEqual(source);
    expect(JsonMerger.merge(source, undefined)).toEqual(source);
  });

  it('should return target if source is null or undefined', () => {
    const target = { a: 1 };
    expect(JsonMerger.merge(null, target)).toEqual(target);
    expect(JsonMerger.merge(undefined, target)).toEqual(target);
  });

  it('should overwrite simple values', () => {
    const source = { a: 2 };
    const target = { a: 1 };
    expect(JsonMerger.merge(source, target)).toEqual({ a: 2 });
  });

  it('should add new properties', () => {
    const source = { b: 2 };
    const target = { a: 1 };
    expect(JsonMerger.merge(source, target)).toEqual({ a: 1, b: 2 });
  });

  it('should merge nested objects recursively', () => {
    const source = { nested: { b: 2, c: 3 } };
    const target = { nested: { a: 1, b: 1 } };
    const expected = { nested: { a: 1, b: 2, c: 3 } };
    expect(JsonMerger.merge(source, target)).toEqual(expected);
  });

  it('should replace arrays by default', () => {
    const source = { arr: [3, 4] };
    const target = { arr: [1, 2] };
    expect(JsonMerger.merge(source, target)).toEqual({ arr: [3, 4] });
  });

  it('should concat arrays when strategy is concat', () => {
    const source = { arr: [3, 4] };
    const target = { arr: [1, 2] };
    const options = { arrayStrategy: 'concat' as const };
    expect(JsonMerger.merge(source, target, options)).toEqual({ arr: [1, 2, 3, 4] });
  });

  it('should union arrays when strategy is union', () => {
    const source = { arr: [2, 3] };
    const target = { arr: [1, 2] };
    const options = { arrayStrategy: 'union' as const };
    expect(JsonMerger.merge(source, target, options)).toEqual({ arr: [1, 2, 3] });
  });

  it('should union object arrays based on JSON stringify', () => {
    const source = { arr: [{ id: 2 }, { id: 3 }] };
    const target = { arr: [{ id: 1 }, { id: 2 }] };
    const options = { arrayStrategy: 'union' as const };
    expect(JsonMerger.merge(source, target, options)).toEqual({ arr: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  });

  it('should handle type mismatches by overwriting with source', () => {
    const source = { val: { a: 1 } };
    const target = { val: 123 };
    expect(JsonMerger.merge(source, target)).toEqual({ val: { a: 1 } });
  });

  it('should not mutate original objects', () => {
    const source = { nested: { a: 1 } };
    const target = { nested: { b: 2 } };
    const result = JsonMerger.merge(source, target);
    
    expect(result).not.toBe(source);
    expect(result).not.toBe(target);
    expect(source.nested).toEqual({ a: 1 });
    expect(target.nested).toEqual({ b: 2 });
  });
});