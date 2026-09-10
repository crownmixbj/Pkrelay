import type { ImageSourcePropType } from 'react-native';

/**
 * Illustrations for the three "How Package Relay Works" cards.
 *
 * Metro resolves bundled assets at build time, so these have to be static
 * `require`s — a runtime path string won't work. If an entry is ever set back
 * to null the card falls back to its lucide icon tile, so the layout holds
 * either way and nothing breaks in the meantime.
 *
 * These are the `-art` crops, not the originals. The supplied artwork has the
 * step number and title baked into a band across the top; that band is cropped
 * off here so the card can print the title as real text underneath, at a size
 * that stays legible when the image box is only 150dp tall. The uncropped
 * originals are still in `assets/images/` if the full composition is ever
 * wanted somewhere with more room.
 */
export const STEP_ILLUSTRATIONS: Record<
  'post-parcel' | 'handover-parcel' | 'recipient-collects',
  ImageSourcePropType | null
> = {
  'post-parcel': require('@/../assets/images/post-parcel-01-art.png'),
  'handover-parcel': require('@/../assets/images/parcel-handover-02-art.jpg'),
  'recipient-collects': require('@/../assets/images/recepient-collect-03-art.jpg'),
};

/**
 * Height of the image box on a step card. The art is letterboxed into this at
 * its own aspect ratio (~1.44:1), so a 150dp box shows roughly a 216dp-wide
 * illustration — small enough to keep the card compact, large enough that the
 * figures in it still read.
 */
export const STEP_ILLUSTRATION_HEIGHT = 150;
