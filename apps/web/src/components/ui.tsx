import type { ReactNode } from 'react';
import type { Priority } from '@/lib/types';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#b9ff3b" />
      <path d="M5 5.5 9.4 9.2M19 5.5 14.6 9.2" stroke="#07070a" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="13" r="1.7" fill="#07070a" />
      <circle cx="15" cy="13" r="1.7" fill="#07070a" />
      <path d="M8.2 17.4c1.2 1 2.4 1.4 3.8 1.4s2.6-.4 3.8-1.4" stroke="#07070a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const PRI: Record<Priority, string> = {
  P0: 'bg-p0/15 text-p0 ring-p0/40',
  P1: 'bg-p1/15 text-p1 ring-p1/40',
  P2: 'bg-p2/12 text-p2 ring-p2/35',
  P3: 'bg-p3/15 text-p3 ring-p3/40',
};

export function PriorityBadge({ p, className = '' }: { p: Priority; className?: string }) {
  return (
    <span className={`inline-flex h-[18px] min-w-[26px] items-center justify-center rounded-[4px] px-1 font-mono text-[10.5px] font-semibold tracking-wide ring-1 ring-inset ${PRI[p]} ${className}`}>
      {p}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  confirmed: 'text-ok', fixed: 'text-ok', done: 'text-ok',
  flaky: 'text-warn', partial: 'text-warn', unconfirmed: 'text-ink-300',
  new: 'text-p3', dismissed: 'text-ink-400', still_failing: 'text-fail', failed: 'text-fail',
  scanning: 'text-lime', discovering: 'text-lime', confirming: 'text-lime', reflecting: 'text-lime', running: 'text-lime', queued: 'text-ink-300',
};
const LIVE = new Set(['scanning', 'discovering', 'confirming', 'reflecting', 'running']);

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'text-ink-200';
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${tone}`}>
      <span className={`size-1.5 rounded-full bg-current ${LIVE.has(status) ? 'animate-pulse-dot' : ''}`} />
      {status.replace('_', ' ')}
    </span>
  );
}

export function SourceBadge({ source }: { source: 'engine' | 'mock' }) {
  if (source === 'engine') return null;
  return (
    <span title="Engine unreachable or NEXT_PUBLIC_MOCK=1: showing generated sample data" className="inline-flex items-center gap-1 rounded border border-p2/40 bg-p2/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-p2">
      MOCK DATA
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-600 bg-ink-800 px-1 font-mono text-[10px] text-ink-200">{children}</kbd>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <h2 className="label">{children}</h2>
      {right}
    </div>
  );
}

export function Btn({
  children, onClick, href, variant = 'ghost', disabled, title, type = 'button', className = '',
}: {
  children: ReactNode; onClick?: () => void; href?: string; variant?: 'ghost' | 'primary' | 'danger'; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string;
}) {
  const base = 'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 font-mono text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const tone =
    variant === 'primary'
      ? 'bg-lime text-ink-950 font-semibold hover:bg-[#cdff6b]'
      : variant === 'danger'
        ? 'border border-p0/40 text-p0 hover:bg-p0/10'
        : 'border border-ink-600 text-ink-100 hover:border-ink-400 hover:bg-ink-800';
  if (href && !disabled) {
    return (
      <a href={href} title={title} className={`${base} ${tone} ${className}`}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${tone} ${className}`}>
      {children}
    </button>
  );
}
