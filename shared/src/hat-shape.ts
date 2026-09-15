// Rarity no longer implies shape — a limited hat may be animated or
// variant-based — so shape questions go through these helpers.

import type { Hat, HatAnimation, HatVariant } from './types.js';

export type AnimatedHat = Extract<Hat, { animation: HatAnimation }>;
export type VariantHat = Extract<Hat, { variants: HatVariant[] }>;

export function isAnimatedHat(hat: Hat): hat is AnimatedHat {
  return 'animation' in hat;
}

/** How many distinct collectibles this hat yields. Animated hats are one-offs. */
export function variantCount(hat: Hat): number {
  return isAnimatedHat(hat) ? 1 : hat.variants.length;
}

/** The palette to draw with. An out-of-range index falls back to the first variant. */
export function hatColors(hat: Hat, variantIdx = 0): HatVariant {
  if (isAnimatedHat(hat)) return hat.colors;
  return hat.variants[variantIdx] ?? hat.variants[0]!;
}
