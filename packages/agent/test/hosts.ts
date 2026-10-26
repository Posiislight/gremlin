/**
 * Chromium host-resolver rules mapping foreign / payment hostnames to the local fixture servers (127.0.0.1), so
 * tests can use genuinely foreign sites and REAL payment hostnames and then assert the servers received no hit.
 * Loopback aliases (127.x, localhost) are the same site as a loopback target by design, hence host names.
 */
export const HOST_RULES = [
  'MAP *.test 127.0.0.1',
  'MAP stripe.com 127.0.0.1',
  'MAP *.stripe.com 127.0.0.1',
  'MAP paypal.com 127.0.0.1',
  'MAP *.paypal.com 127.0.0.1',
  'MAP adyen.com 127.0.0.1',
  'MAP squareup.com 127.0.0.1',
].join(',');

/** `http://127.0.0.1:1234` -> `http://foreign.test:1234` */
export function asHost(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return u.origin;
}

export const FOREIGN = 'foreign.test';
