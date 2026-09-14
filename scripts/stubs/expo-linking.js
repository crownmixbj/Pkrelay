/**
 * expo-linking, stubbed for the verification bundles.
 *
 * The real module calls `requireNativeModule('ExpoLinking')` at import time,
 * which throws under plain node — so a single `import * as Linking` anywhere in
 * the bundled graph takes the whole script down before the first assertion runs.
 *
 * ⚠ `createURL` returns the *release-build* answer on purpose.
 *
 *   The real one returns `exp://<lan-ip>:<port>/--/…` under Expo Go and
 *   `parcelmobile://…` in a dev client or a release build. The verify bundles
 *   are built with `--define:__DEV__=false`, so the release answer is the
 *   truthful one to model here. Anything asserting on the Expo Go shape would
 *   be asserting on this file rather than on the app.
 */
const SCHEME = 'parcelmobile';

function createURL(path = '', options = {}) {
  const rooted = path.startsWith('/') ? path : `/${path}`;
  const query = options.queryParams
    ? `?${new URLSearchParams(options.queryParams).toString()}`
    : '';
  return `${SCHEME}:/${rooted}${query}`;
}

const parse = (url) => ({ hostname: null, path: null, queryParams: {}, url });

module.exports = {
  __esModule: true,
  createURL,
  parse,
  default: { createURL, parse },
};
