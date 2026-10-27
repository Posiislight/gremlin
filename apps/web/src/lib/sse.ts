// Incremental Server-Sent Events parser for fetch() streaming (EventSource cannot send auth headers).
export type SseMessage = { event: string; data: string; id?: string };

export function createSseParser() {
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;
  return {
    push(chunk: string): SseMessage[] {
      buf += chunk;
      const out: SseMessage[] = [];
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        const m = /^(\r\n|\n|\r)/.exec(buf.slice(nl))!;
        const line = buf.slice(0, nl);
        if (m[0] === '\r' && nl + 1 === buf.length) break; // maybe half of \r\n
        buf = buf.slice(nl + m[0].length);
        if (line === '') {
          if (data.length) out.push({ event, data: data.join('\n'), ...(id ? { id } : {}) });
          event = 'message';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let val = c < 0 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        else if (field === 'id') id = val;
      }
      return out;
    },
  };
}
