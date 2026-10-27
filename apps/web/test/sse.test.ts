import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/lib/sse';

describe('sse parser', () => {
  it('parses events across chunk boundaries', () => {
    const p = createSseParser();
    expect(p.push('event: step\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n\n: keepalive\n\nevent: done\r\ndata: x\r\n\r\n')).toEqual([
      { event: 'step', data: '{"a":1}' },
      { event: 'done', data: 'x' },
    ]);
  });
  it('joins multi-line data and defaults the event name', () => {
    expect(createSseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});
