import { describe, expect, it } from 'vitest';
import { SERVER_NAME } from '../src/index.js';

describe('tessa-mcp', () => {
  it('exposes its server name', () => {
    expect(SERVER_NAME).toBe('tessa-mcp');
  });
});
