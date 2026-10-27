import { candidate, type Oracle } from './common.js';

/** Body text under 20 chars and no interactables after settle. P1. */
export const blank: Oracle = (input) => {
  const { observation } = input;
  const textLen = observation.text.trim().length;
  if (textLen >= 20 || observation.interactables.length > 0) return [];
  return [
    candidate(input, {
      oracle: 'blank',
      severity: 'P1',
      url: observation.url,
      message: 'Page is blank: almost no text and nothing to interact with',
      evidence: { textLength: textLen, interactables: 0, title: observation.title },
    }),
  ];
};
