/**
 * Mock spies for TaskIndexer
 * This file is imported by both the mock factory and the tests
 */
import { vi } from 'vitest';

export const indexTaskSpy = vi.fn().mockResolvedValue([]);
export const countPointsByHostOsSpy = vi.fn().mockResolvedValue(0);

export const taskIndexerInstance = {
  indexTask: indexTaskSpy,
  countPointsByHostOs: countPointsByHostOsSpy,
};
