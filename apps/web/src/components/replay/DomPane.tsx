'use client';

// Inspectable DOM replay via rrweb-player. The studio clock is authoritative; this pane only follows seeks/play state.
import 'rrweb-player/dist/style.css';
import Player from 'rrweb-player';
import { useEffect, useRef, useState } from 'react';
import type { RrwebSegment } from '@/lib/types';

export type ElementInfo = {
  tag: string;
  path: string;
  attrs: Record<string, string>;
  text: string;
  html: string;
};

type Rect = { x: number; y: number; w: number; h: number };
type PlayerApi = {
  $set(p: Record<string, unknown>): void;
  $destroy(): void;
  goto(ms: number, play?: boolean): void;
  play(): void;
  pause(): void;
  setSpeed(s: number): void;
  triggerResize(): void;
};

async function loadEvents(url: string, runId: string): Promise<unknown[]> {
  if (url.startsWith('mock://')) {
    const { mockRrwebSegment } = await import('@/lib/mock/data');
    return mockRrwebSegment(runId);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rrweb segment ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('unexpected rrweb payload');
  return body;
}

function describe(el: Element): ElementInfo {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value.length > 160 ? a.value.slice(0, 160) + '…' : a.value;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 4 && cur.tagName.toLowerCase() !== 'html') {
    const id = cur.id ? `#${cur.id}` : '';
    const cls = typeof cur.className === 'string' && cur.className ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    parts.unshift(cur.tagName.toLowerCase() + id + cls);
    cur = cur.parentElement;
  }
  const html = el.outerHTML;
  return {
    tag: el.tagName.toLowerCase(),
    path: parts.join(' > '),
    attrs,
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    html: html.length > 700 ? html.slice(0, 700) + '…' : html,
  };
}

export default function DomPane(props: {
  runId: string;
  segment: RrwebSegment;
  offsetMs: number;
  playing: boolean;
  speed: number;
  seekVersion: number;
  targetRef: string | null;
  inspect: boolean;
  onTarget: (info: ElementInfo | null) => void;
  onHover: (info: ElementInfo | null) => void;
}) {
  const { runId, segment, offsetMs, playing, speed, seekVersion, targetRef, inspect, onTarget, onHover } = props;
  const box = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerApi | null>(null);
  const latest = useRef({ offsetMs, playing, speed, targetRef });
  latest.current = { offsetMs, playing, speed, targetRef };
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [hover, setHover] = useState<Rect | null>(null);
  const [target, setTarget] = useState<Rect | null>(null);
  const [size, setSize] = useState<{ vw: number; vh: number }>({ vw: 1280, vh: 800 });

  const frame = () => {
    const iframe = mount.current?.querySelector('iframe') ?? null;
    const doc = iframe?.contentDocument ?? null;
    return iframe && doc ? { iframe, doc } : null;
  };

  const rectOf = (el: Element): Rect | null => {
    const f = frame();
    const b = box.current;
    if (!f || !b) return null;
    const fr = f.iframe.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const k = f.iframe.offsetWidth ? fr.width / f.iframe.offsetWidth : 1;
    const r = el.getBoundingClientRect();
    return { x: fr.left - br.left + r.left * k, y: fr.top - br.top + r.top * k, w: r.width * k, h: r.height * k };
  };

  const locateTarget = () => {
    const f = frame();
    const ref = latest.current.targetRef;
    if (!f || !ref) {
      setTarget(null);
      onTarget(null);
      return;
    }
    const el = f.doc.querySelector(`[data-gremlin-ref="${CSS.escape(ref)}"]`);
    setTarget(el ? rectOf(el) : null);
    onTarget(el ? describe(el) : null);
  };

  // (re)create the player when the segment changes
  useEffect(() => {
    let dead = false;
    setState('loading');
    loadEvents(segment.signedUrl, runId)
      .then((events) => {
        if (dead || !mount.current || !box.current) return;
        const meta = events.find((e): e is { type: number; data: { width: number; height: number } } => (e as { type?: number }).type === 4);
        const vw = meta?.data.width || 1280;
        const vh = meta?.data.height || 800;
        setSize({ vw, vh });
        const w = box.current.clientWidth || 800;
        mount.current.innerHTML = '';
        const p = new Player({
          target: mount.current,
          props: { events: events as never, width: w, height: Math.round((w * vh) / vw), autoPlay: false, showController: false, maxScale: 0, speed: latest.current.speed, skipInactive: false, mouseTail: false } as never,
        }) as unknown as PlayerApi;
        player.current = p;
        p.goto(latest.current.offsetMs, latest.current.playing);
        setState('ready');
        window.setTimeout(locateTarget, 120);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
        setState('error');
      });
    return () => {
      dead = true;
      try {
        player.current?.$destroy();
      } catch {
        /* already gone */
      }
      player.current = null;
      if (mount.current) mount.current.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.signedUrl, runId]);

  // explicit seeks / play toggles
  useEffect(() => {
    const p = player.current;
    if (!p || state !== 'ready') return;
    p.goto(latest.current.offsetMs, latest.current.playing);
    const id = window.setTimeout(locateTarget, 90);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekVersion, playing, state, targetRef]);

  useEffect(() => {
    if (state === 'ready') player.current?.setSpeed(speed);
  }, [speed, state]);

  // keep the player sized to its container
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const ro = new ResizeObserver(() => {
      const p = player.current;
      if (!p || !b.clientWidth) return;
      p.$set({ width: b.clientWidth, height: Math.round((b.clientWidth * size.vh) / size.vw) });
      p.triggerResize();
      window.setTimeout(locateTarget, 60);
    });
    ro.observe(b);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.vw, size.vh]);

  function move(e: React.PointerEvent) {
    if (!inspect) return;
    const f = frame();
    if (!f) return;
    const fr = f.iframe.getBoundingClientRect();
    const k = f.iframe.offsetWidth ? fr.width / f.iframe.offsetWidth : 1;
    const el = f.doc.elementFromPoint((e.clientX - fr.left) / k, (e.clientY - fr.top) / k);
    if (!el || el === f.doc.documentElement || el === f.doc.body) {
      setHover(null);
      onHover(null);
      return;
    }
    setHover(rectOf(el));
    onHover(describe(el));
  }

  return (
    <div ref={box} className="relative w-full overflow-hidden bg-white" style={{ aspectRatio: `${size.vw} / ${size.vh}` }}>
      <div ref={mount} className="absolute inset-0" />
      {state === 'loading' && <div className="absolute inset-0 grid place-items-center bg-ink-900 font-mono text-[12px] text-ink-300">loading DOM segment…</div>}
      {state === 'error' && (
        <div className="absolute inset-0 grid place-items-center bg-ink-900 p-6 text-center font-mono text-[12px] text-p1">
          DOM replay unavailable ({errMsg}). Switch to screenshots.
        </div>
      )}
      {state === 'ready' && (
        <div
          className={`absolute inset-0 ${inspect ? 'cursor-crosshair' : ''}`}
          onPointerMove={move}
          onPointerLeave={() => {
            setHover(null);
            onHover(null);
          }}
        >
          {target && (
            <div className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-lime bg-lime/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.0)]"
              style={{ left: target.x - 2, top: target.y - 2, width: target.w + 4, height: target.h + 4 }}>
              <span className="absolute -top-5 left-0 rounded-sm bg-lime px-1 font-mono text-[10px] font-semibold text-ink-950">target {targetRef}</span>
            </div>
          )}
          {hover && inspect && (
            <div className="pointer-events-none absolute rounded-[2px] border border-p3 bg-p3/20" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} />
          )}
        </div>
      )}
    </div>
  );
}
