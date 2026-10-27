import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import Link from 'next/link';
import './globals.css';
import { Logo } from '@/components/ui';

export const metadata: Metadata = {
  title: { default: 'Gremlin', template: '%s - Gremlin' },
  description: 'Autonomous QA swarm. Every bug ships with a replay you can inspect.',
};

export const viewport: Viewport = { themeColor: '#07070a', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">
        <header className="sticky top-0 z-40 border-b border-ink-700/80 bg-ink-950/80 backdrop-blur-md">
          <div className="mx-auto flex h-12 max-w-[1680px] items-center gap-5 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Gremlin home">
              <Logo />
              <span className="text-[15px] font-semibold tracking-tight text-ink-50">gremlin</span>
            </Link>
            <span className="hidden h-4 w-px bg-ink-600 sm:block" />
            <nav className="flex items-center gap-1 font-mono text-[12px] text-ink-300">
              <Link className="rounded px-2 py-1 hover:bg-ink-800 hover:text-ink-50" href="/">scans</Link>
            </nav>
            <div className="ml-auto hidden font-mono text-[11px] text-ink-400 sm:block">autonomous QA swarm</div>
          </div>
        </header>
        <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
