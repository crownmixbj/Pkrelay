import type { ImageSourcePropType } from 'react-native';

/**
 * Hero photograph behind the headline and the track-a-parcel card.
 *
 * There's no `public/` folder in an Expo app — bundled assets live under
 * `assets/` and are resolved by Metro at build time, so the path has to be a
 * static `require`, not a runtime string. `@/` points at `src/`, hence the
 * `../` back out to the asset folder.
 *
 * ⚠ The picture is composed for the layout, not merely decorative.
 *
 *   `New-hero-bg.jpeg` is 1024×572 and puts the handover in its right half;
 *   the left 45% is an empty blue-to-cream gradient. That empty band is the
 *   copy column — see the `Hero` constant in `(tabs)/index.tsx`, which sizes
 *   the column and the wash to it. A replacement that fills the frame edge to
 *   edge will not drop in: the headline would land on the subject and the
 *   measured contrast in that file would stop being true.
 *
 * Set this to `null` to fall back to the vector rider illustration. The layout
 * and the glass card behave the same either way.
 *
 * The previous illustration is still at `assets/images/hero-bg.jpg`, now
 * unreferenced.
 */
export const HERO_BACKGROUND: ImageSourcePropType | null = require('@/../assets/images/New-hero-bg.jpeg');
