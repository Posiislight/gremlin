// Mock engine payloads (shapes from @gremlin/contract api.ts). Used when NEXT_PUBLIC_MOCK=1 or the engine is unreachable.
import type {
  ApiFindingDetail,
  ApiFindingSummary,
  ApiProject,
  ApiRunSummary,
  ApiScanDetail,
  ApiTimeline,
  ProjectMetrics,
  ScanEvent,
  ScanListItem,
  Signal,
  TimelineStep,
} from '../types';
import { MOCK_T0, mockRrwebEvents } from './rrweb';
import { shopSvg, type ShopScene } from './screens';

const iso = (minsAgo: number) => new Date(Date.parse('2026-10-27T12:00:00Z') - minsAgo * 60_000).toISOString();

export const MOCK_PROJECT: ApiProject = { id: 'prj_ridge', name: 'ridge&co storefront', createdAt: iso(60 * 24 * 12) };
export const mockProjects = (): ApiProject[] => [
  MOCK_PROJECT,
  { id: 'prj_docs', name: 'docs.ridge.co', createdAt: iso(60 * 24 * 30) },
];

type F = Omit<ApiFindingSummary, 'projectId' | 'unjudged' | 'fixStatus' | 'createdAt'> & { createdAgo: number; fix?: string };
const F_DEFS: F[] = [
  {
    id: 'fnd_checkout500', scanId: 'scn_0147', signature: 'http:POST:/api/checkout:500', priority: 'P0',
    title: 'Checkout returns HTTP 500 for a valid cart', expected: 'Order is created and the user lands on the confirmation page',
    actual: 'POST /api/checkout responds 500; UI shows "Something went wrong"', status: 'confirmed', url: 'https://shop.example.test/checkout',
    oracle: 'http', occurrenceCount: 3, createdAgo: 34, fix: 'handed_off',
  },
  {
    id: 'fnd_cartbadge', scanId: 'scn_0147', signature: 'expectation:cart-count', priority: 'P1',
    title: 'Cart badge stays at 1 after adding a second item', expected: 'Header cart count increments to 2',
    actual: 'Badge still reads 1; cart page lists qty 2', status: 'confirmed', url: 'https://shop.example.test/shop',
    oracle: 'expectation', occurrenceCount: 5, createdAgo: 36,
  },
  {
    id: 'fnd_pageerror', scanId: 'scn_0147', signature: 'pageerror:TypeError:cartStore', priority: 'P1',
    title: 'Uncaught TypeError in cart store on repeated add', expected: 'No uncaught exceptions during add-to-cart',
    actual: "TypeError: Cannot read properties of undefined (reading 'qty')", status: 'flaky', url: 'https://shop.example.test/shop',
    oracle: 'crash', occurrenceCount: 2, createdAgo: 35,
  },
  {
    id: 'fnd_alt', scanId: 'scn_0147', signature: 'a11y:image-alt', priority: 'P2',
    title: 'Product images have no alt text', expected: 'Every informative image exposes an accessible name',
    actual: '3 <img> elements on /shop have no alt attribute', status: 'new', url: 'https://shop.example.test/shop',
    oracle: 'a11y', occurrenceCount: 1, createdAgo: 38,
  },
  {
    id: 'fnd_slow', scanId: 'scn_0147', signature: 'slow:/api/products', priority: 'P2',
    title: 'GET /api/products takes 3.4s on first load', expected: 'API responds in under 1s',
    actual: 'Response time 3412ms (p95 across 4 agents)', status: 'unconfirmed', url: 'https://shop.example.test/shop',
    oracle: 'slow', occurrenceCount: 4, createdAgo: 40,
  },
  {
    id: 'fnd_about404', scanId: 'scn_0147', signature: 'dead_link:/about', priority: 'P3',
    title: 'Footer link "About" leads to a 404', expected: 'About page renders', actual: 'GET /about responds 404',
    status: 'new', url: 'https://shop.example.test/', oracle: 'dead_link', occurrenceCount: 2, createdAgo: 41,
  },
];

export const mockFindings = (): ApiFindingSummary[] =>
  F_DEFS.map(({ createdAgo, fix, ...f }) => ({
    ...f,
    projectId: MOCK_PROJECT.id,
    unjudged: false,
    fixStatus: fix ?? null,
    createdAt: iso(createdAgo),
  }));

const runSummary = (id: string, over: Partial<ApiRunSummary> = {}): ApiRunSummary => ({
  id, scanId: 'scn_0147', charterId: 'chr_1', kind: 'scan', status: 'done', t0: iso(45), tokens: 18420, costUsd: 0.31,
  error: null, hasVideo: false, hasRrweb: true, hasTimeline: true, ...over,
});

export const mockScanDetail = (id: string): ApiScanDetail => {
  const live = id === 'scn_live';
  const findings = live ? mockFindings().slice(0, 2).map((f) => ({ ...f, scanId: id })) : mockFindings();
  return {
    id, environmentId: 'env_1', baseUrl: 'https://shop.example.test', status: live ? 'scanning' : 'done', teamSize: 5,
    allowedActions: 'read_only', focus: 'checkout and cart', viewports: ['1280x800', '390x844'],
    costUsd: live ? 0.62 : 1.34, startedAt: iso(live ? 3 : 50), finishedAt: live ? null : iso(37),
    runs: [
      runSummary('run_demo'), runSummary('run_b', { status: live ? 'running' : 'done', tokens: 12100, costUsd: 0.2 }),
      runSummary('run_c', { status: live ? 'running' : 'done', tokens: 9300, costUsd: 0.15, hasRrweb: false }),
      runSummary('run_d', { status: 'done', kind: 'confirm', tokens: 3200, costUsd: 0.05 }),
    ],
    findings,
    cost: { scanUsd: live ? 0.62 : 1.34, runsUsd: live ? 0.4 : 0.82, llmUsd: live ? 0.22 : 0.52, tokens: live ? 21400 : 54200 },
  };
};

export const mockScans = (): ScanListItem[] => {
  const mk = (id: string, ago: number, status: string, cost: number, f: number, p0: number, p1: number): ScanListItem => ({
    id, environmentId: 'env_1', baseUrl: 'https://shop.example.test', status, teamSize: 5, allowedActions: 'read_only', focus: null,
    viewports: ['1280x800'], costUsd: cost, startedAt: iso(ago), finishedAt: status === 'done' ? iso(ago - 12) : null,
    projectId: 'prj_ridge', findingCount: f, p0, p1,
  });
  return [
    mk('scn_live', 3, 'scanning', 0.62, 2, 1, 1),
    mk('scn_0147', 50, 'done', 1.34, 6, 1, 2),
    mk('scn_0146', 60 * 22, 'done', 1.71, 5, 1, 1),
    mk('scn_0145', 60 * 70, 'done', 1.98, 4, 0, 2),
    mk('scn_0144', 60 * 120, 'partial', 2.0, 2, 0, 1),
  ];
};

export const mockMetrics = (): ProjectMetrics => ({
  projectId: 'prj_ridge',
  fixRate: 0.62,
  medianTimeToFixMs: 41 * 60_000,
  points: [
    { scanId: 'scn_0144', label: '#144', tokens: 96_000, costUsd: 2.0, wallMs: 21 * 60_000, stepsPerFinding: 46, falsePositiveRate: 0.4, confirmed: 2, regressionCatches: 0 },
    { scanId: 'scn_0145', label: '#145', tokens: 81_500, costUsd: 1.98, wallMs: 18 * 60_000, stepsPerFinding: 31, falsePositiveRate: 0.33, confirmed: 3, regressionCatches: 1 },
    { scanId: 'scn_0146', label: '#146', tokens: 66_200, costUsd: 1.71, wallMs: 15 * 60_000, stepsPerFinding: 22, falsePositiveRate: 0.2, confirmed: 4, regressionCatches: 2 },
    { scanId: 'scn_0147', label: '#147', tokens: 54_200, costUsd: 1.34, wallMs: 12 * 60_000, stepsPerFinding: 14, falsePositiveRate: 0.12, confirmed: 5, regressionCatches: 3 },
  ],
});

// ---- run replay -------------------------------------------------------------------------------

const sig = {
  consoleErr: { kind: 'console', level: 'error', text: "Failed to update cart: TypeError: Cannot read properties of undefined (reading 'qty')", location: 'cart-store.ts:88:14', tMs: 3520 } as Signal,
  pageErr: { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'qty')", stack: "TypeError: Cannot read properties of undefined (reading 'qty')\n    at addItem (cart-store.ts:88:14)\n    at onClick (AddToCart.tsx:21:9)", tMs: 3521 } as Signal,
  warn: { kind: 'console', level: 'warning', text: 'Image "ridge-shell.jpg" was loaded without explicit width/height (CLS risk)', location: 'ProductCard.tsx:14:3', tMs: 640 } as Signal,
  net500: { kind: 'network', method: 'POST', url: 'https://shop.example.test/api/checkout', status: 500, durationMs: 412, resourceType: 'fetch', bodyKey: 'bodies/checkout.json', tMs: 7120 } as Signal,
};
const netOk = (tMs: number, method: string, path: string, durationMs: number, resourceType = 'fetch', status = 200): Signal => ({
  kind: 'network', method, url: `https://shop.example.test${path}`, status, durationMs, resourceType, tMs,
});

const FOCUS_BTN1 = { x: 84, y: 564, w: 320, h: 48 };
type StepSpec = { n: number; tMs: number; action: TimelineStep['action']; locator: TimelineStep['locator']; intent: string; expectation?: string; reasoning: string; outcome: TimelineStep['outcome']; signals: Signal[]; scene: ShopScene; error?: string };

function specs(fixed: boolean): StepSpec[] {
  const base: StepSpec[] = [
    {
      n: 1, tMs: 0, action: { type: 'goto', path: '/shop', intent: 'Open the shop' }, locator: null, intent: 'Open the shop front page',
      reasoning: 'Start at the catalogue; product cards and the cart badge are the main surface for the cart charter.', outcome: 'ok',
      signals: [{ kind: 'navigation', url: 'https://shop.example.test/shop', tMs: 12 }, netOk(30, 'GET', '/shop', 120, 'document'), netOk(180, 'GET', '/api/products', 3412, 'fetch'), sig.warn],
      scene: { page: 'shop', cart: 0 },
    },
    {
      n: 2, tMs: 1800, action: { type: 'click', ref: 'e12', intent: 'Add first product to cart' },
      locator: { testId: 'add-trail-runner', role: { role: 'button', name: 'Add to cart' }, css: 'article:nth-of-type(1) button' },
      intent: 'Add "Trail Runner 2" to the cart', expectation: 'Cart badge shows 1',
      reasoning: 'The first card has an Add to cart button. Clicking it should increment the header badge from 0 to 1.', outcome: 'ok',
      signals: [netOk(1840, 'POST', '/api/cart', 96)], scene: { page: 'shop', cart: 1, focus: FOCUS_BTN1 },
    },
    {
      n: 3, tMs: 3400, action: { type: 'click', ref: 'e12', intent: 'Add the same product again' },
      locator: { testId: 'add-trail-runner', role: { role: 'button', name: 'Add to cart' }, css: 'article:nth-of-type(1) button' },
      intent: 'Add "Trail Runner 2" a second time', expectation: 'Cart badge shows 2',
      reasoning: 'Repeating the add tests quantity handling. Badge should read 2.', outcome: 'ok',
      signals: fixed ? [netOk(3440, 'POST', '/api/cart', 88)] : [netOk(3440, 'POST', '/api/cart', 88), sig.consoleErr, sig.pageErr],
      scene: { page: 'shop', cart: fixed ? 2 : 1, focus: FOCUS_BTN1 },
    },
    {
      n: 4, tMs: 5200, action: { type: 'expect', statement: 'cart badge reads 2', intent: 'Verify the badge' }, locator: { testId: 'cart-count', css: '[data-testid=cart-count]' },
      intent: 'Verify the cart badge reflects two items', expectation: 'Badge text is "2"',
      reasoning: fixed ? 'Badge reads 2 as expected.' : 'Badge still reads 1 although two POST /api/cart calls succeeded. The cart-store threw on the second add, so the UI never updated. Candidate bug: stale badge.',
      outcome: fixed ? 'ok' : 'error', error: fixed ? undefined : 'Expectation failed: cart badge reads "1", expected "2"', signals: [],
      scene: { page: 'shop', cart: fixed ? 2 : 1, focus: { x: 1158, y: 16, w: 44, h: 44 }, caption: fixed ? undefined : 'expectation failed' },
    },
    {
      n: 5, tMs: 7000, action: { type: 'click', ref: 'e31', intent: 'Go to checkout' }, locator: { role: { role: 'link', name: 'Checkout' }, text: 'Checkout', css: 'a[href="/checkout"]' },
      intent: 'Proceed to checkout from the cart', expectation: 'Order confirmation page loads',
      reasoning: 'Cart has items; checkout is the critical path. Submitting should create an order.', outcome: fixed ? 'ok' : 'error',
      error: fixed ? undefined : 'POST /api/checkout returned 500', signals: fixed ? [netOk(7110, 'POST', '/api/checkout', 240, 'fetch', 201)] : [sig.net500],
      scene: fixed ? { page: 'checkout', cart: 2, caption: 'order confirmed' } : { page: 'checkout', cart: 1, error: 'Something went wrong. Please try again.', focus: { x: 64, y: 340, w: 220, h: 52 } },
    },
    {
      n: 6, tMs: 8800, action: { type: 'report_bug', title: fixed ? 'none' : 'Checkout 500', expected: 'Order created', actual: fixed ? 'ok' : '500', severityHint: 'P0', intent: 'Report' }, locator: null,
      intent: fixed ? 'Finish: no issues found on this path' : 'Report the failing checkout', reasoning: fixed ? 'Everything behaved.' : 'Server error on a valid cart is release-blocking. Reporting with evidence from step 5.',
      outcome: 'ok', signals: [], scene: { page: 'checkout', cart: fixed ? 2 : 1, error: fixed ? undefined : 'Something went wrong. Please try again.' },
    },
  ];
  return base;
}

export function mockTimeline(runId: string): ApiTimeline {
  const fixed = runId === 'run_fixed';
  const sp = specs(fixed);
  const rr = mockRrwebEvents({ fixed });
  const steps = sp.map((s): TimelineStep => ({
    n: s.n, action: s.action, locator: s.locator, intent: s.intent, ...(s.expectation ? { expectation: s.expectation } : {}),
    tMs: s.tMs, stateHash: `sha-${s.n}`, signals: s.signals, outcome: s.outcome, ...(s.error ? { error: s.error } : {}),
    reasoningSummary: s.reasoning, screenshotUrl: shopSvg(s.scene),
  }));
  const signals = sp.flatMap((s) => s.signals).sort((a, b) => a.tMs - b.tMs);
  return {
    runId, t0: MOCK_T0, durationMs: rr.durationMs, videoUrl: null, traceUrl: null,
    rrwebSegments: [{ index: 0, startMs: 0, endMs: rr.durationMs, url: 'https://shop.example.test/shop', key: `mock/${runId}/rrweb/0.json`, signedUrl: `mock://rrweb/${runId}/0` }],
    steps, signals, findings: fixed ? [] : [{ id: 'fnd_cartbadge', tMs: 5200 }, { id: 'fnd_checkout500', tMs: 7120 }],
  };
}

export function mockRrwebSegment(runId: string): Record<string, unknown>[] {
  return mockRrwebEvents({ fixed: runId === 'run_fixed' }).events;
}

export function mockFindingDetail(id: string): ApiFindingDetail | null {
  const f = mockFindings().find((x) => x.id === id);
  if (!f) return null;
  const tl = mockTimeline('run_demo');
  const stepN = id === 'fnd_checkout500' ? 5 : id === 'fnd_cartbadge' ? 4 : id === 'fnd_pageerror' ? 3 : 2;
  const st = tl.steps.find((s) => s.n === stepN)!;
  const verdict =
    f.status === 'unconfirmed'
      ? { reason: 'Not reproduced on 3 replays; single slow sample.' }
      : { isBug: true, priority: f.priority, title: f.title, expected: f.expected, actual: f.actual, duplicateOf: null,
          reasoning: 'The observed behaviour contradicts the stated expectation, is deterministic across replays, and is user-visible. Evidence: console + network signals aligned within 20ms of the failing step.' };
  return {
    ...f,
    verdict,
    confirm: f.status === 'confirmed' ? { reproduced: 3, attempts: 3 } : f.status === 'flaky' ? { reproduced: 1, attempts: 3 } : null,
    promptVariant: f.fixStatus ? 'v3-evidence-first' : null,
    occurrences: Array.from({ length: Math.min(f.occurrenceCount, 3) }, (_, i) => ({
      runId: i === 0 ? 'run_demo' : `run_${'bcd'[i - 1]}`, stepId: `stp_${i}`, stepN: i === 0 ? stepN : stepN + i, tMs: st.tMs + i * 90,
      intent: st.intent, screenshotUrl: st.screenshotUrl,
    })),
    screenshotUrls: tl.steps.filter((s) => s.n >= Math.max(1, stepN - 1) && s.n <= stepN).map((s) => s.screenshotUrl!).filter(Boolean),
  };
}

export const mockFixPrompt = (id: string): string => {
  const f = mockFindingDetail(id);
  if (!f) return '';
  return `You are fixing a bug found by Gremlin in https://shop.example.test.

## ${f.priority} ${f.title}
Expected: ${f.expected}
Actual:   ${f.actual}
Page:     ${f.url}

## Reproduce
1. Open /shop
2. Click "Add to cart" on "Trail Runner 2" twice
3. Observe the header cart badge

## Evidence
- Console: TypeError: Cannot read properties of undefined (reading 'qty') at cart-store.ts:88
- Network: POST /api/checkout -> 500 (412ms)
- Replay: /runs/${f.occurrences[0]?.runId ?? 'run_demo'}?step=${f.occurrences[0]?.stepN ?? 1}&finding=${f.id}

## Task
Find the root cause in the codebase, make the smallest correct fix, add a regression test, and do not change unrelated behaviour.
Then run: gremlin findings verify ${f.id} --url <preview-url>`;
};

/** Scripted SSE-like stream for the live scan page when the engine is unavailable. Each entry fires after `at` ms. */
export function mockScanScript(): { at: number; event: ScanEvent }[] {
  const f = mockFindings();
  const stepEv = (at: number, runId: string, n: number, intent: string, outcome = 'ok'): { at: number; event: ScanEvent } => ({
    at, event: { type: 'step', runId, stepId: `${runId}_${n}`, n, intent, outcome, tMs: n * 1400 },
  });
  return [
    { at: 400, event: { type: 'scan', scanId: 'scn_live', status: 'scanning', costUsd: 0.62 } },
    stepEv(900, 'run_b', 5, 'Filter products by size M'), stepEv(1500, 'run_c', 4, 'Open the size guide'),
    stepEv(2200, 'run_b', 6, 'Add filtered product to cart'), stepEv(2800, 'run_demo', 7, 'Open /checkout'),
    { at: 3300, event: { type: 'finding', finding: f[2]! } },
    stepEv(3800, 'run_c', 5, 'Expect size guide modal to be dismissible', 'error'), stepEv(4600, 'run_b', 7, 'Apply coupon SAVE10'),
    { at: 5200, event: { type: 'scan', scanId: 'scn_live', status: 'confirming', costUsd: 0.91 } },
    { at: 5600, event: { type: 'finding', finding: f[3]! } },
    { at: 7000, event: { type: 'scan', scanId: 'scn_live', status: 'reflecting', costUsd: 1.12 } },
    { at: 8200, event: { type: 'done', status: 'done' } },
  ];
}
