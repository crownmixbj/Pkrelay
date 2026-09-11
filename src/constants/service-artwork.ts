import type { ImageSourcePropType } from 'react-native';

/**
 * Full-bleed artwork for the four service cards on the home screen.
 *
 * These are the `-tile` renders of the supplied designs: trimmed to each one's
 * own panel so the app card *is* the panel rather than a card inside a card,
 * recoloured onto the same warm paper the "How Package Relay Works" artwork uses
 * (246,245,239 — measured, not guessed), and padded to a taller shared aspect.
 *
 * The recolour is a per-channel gain that maps each design's own paper onto the
 * target, so the line art keeps its saturation. Alpha-keying the white was
 * tried first and left every illustration visibly faded.
 *
 * Each image carries its own title — "Hub-to-Hub standard", "Public Location
 * Pickup and Delivery", "Intra & Inter-State", "Bulk & Heavy Goods" — so the
 * card renders no text of its own. Those baked-in titles do NOT match the card
 * titles in `CATEGORIES`; the copy there now survives only as the
 * accessibility label, since text inside an image is invisible to a screen
 * reader. Untouched originals remain in `assets/images/`.
 */
export type ServiceArtworkKey = 'send' | 'interstate' | 'documents' | 'freight';

export const SERVICE_ARTWORK: Record<ServiceArtworkKey, ImageSourcePropType> = {
  send: require('@/../assets/images/section1-01-tile.jpg'),
  interstate: require('@/../assets/images/section1-02-tile.jpg'),
  documents: require('@/../assets/images/section1-03-tile.jpg'),
  freight: require('@/../assets/images/section1-04-tile.jpg'),
};

/**
 * Shared aspect ratio of the four tiles. The card adopts it so nothing is
 * cropped and all four are the same height on any row.
 *
 * Taller than the supplied panels (1.92). The extra height is padding in the
 * tile's own paper colour, not a crop or a stretch, so the artwork and its
 * baked-in title render at exactly the size they always did.
 */
export const SERVICE_ARTWORK_ASPECT = 1.55;

export function serviceArtwork(key: string): ImageSourcePropType | undefined {
  return SERVICE_ARTWORK[key as ServiceArtworkKey];
}
