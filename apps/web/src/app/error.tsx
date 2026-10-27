'use client';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <section className="panel space-y-4 p-8"><h1 className="text-xl font-semibold">Could not load Gremlin</h1>
    <p className="text-ink-300">Check that the engine is running and the dashboard has the correct engine URL and project API key.</p>
    <button className="rounded bg-lime px-4 py-2 text-ink-950" onClick={reset}>Try again</button></section>;
}
