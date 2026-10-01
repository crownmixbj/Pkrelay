/**
 * Assertions for the distribution configuration.
 *
 * A broken build config does not fail here — it fails twenty minutes into a
 * cloud build, or worse, it succeeds and produces an artefact that crashes the
 * first time a tester opens the camera. Both cost a round trip with every
 * tester on the list, so the cheap checks belong here.
 *
 * The rule this file exists to enforce: every native capability the code
 * actually uses must have a permission string, and every identifier a store
 * needs must be set to something that is not the Expo default.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));

/**
 * Comments stripped before searching.
 *
 * `build-banner.tsx` explains at length *why* it is not dismissible, so a
 * search of the raw text finds the explanation and reports it as the problem.
 */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const app = readJson('app.json').expo;
const eas = readJson('eas.json');
const pkg = readJson('package.json');

// ------------------------------------------------------------ identifiers ---

check('eas.json exists', existsSync(join(ROOT, 'eas.json')));

check(
  'the iOS bundle identifier is set',
  typeof app.ios?.bundleIdentifier === 'string' && app.ios.bundleIdentifier.length > 0,
);
check(
  'and is not the Expo default',
  !String(app.ios?.bundleIdentifier ?? '').startsWith('com.anonymous.'),
  'com.anonymous.* cannot be registered with Apple, and the first TestFlight upload fixes this value permanently',
);
check(
  'the Android package is set',
  typeof app.android?.package === 'string' && app.android.package.length > 0,
  'without android.package there is no Android build at all — this is the first thing EAS refuses',
);
check(
  'both platforms use the same identifier',
  app.ios?.bundleIdentifier === app.android?.package,
  'they may legally differ, but two ids means two places to get wrong and two app records to keep in step',
);

check(
  'the app has a human name',
  typeof app.name === 'string' && app.name !== 'parcel_mobile',
  'this is the label under the icon on every tester’s phone',
);

// -------------------------------------------------------------- permissions --

/*
 * Every native capability the source actually reaches for, and the config key
 * that keeps iOS from killing the app when it does.
 *
 * iOS does not warn: an app that touches the camera with no
 * NSCameraUsageDescription is terminated by the OS on the spot, and App Store
 * Connect rejects the upload. Both failures land after the build, on a tester's
 * phone, which is the most expensive place to discover them.
 */
const CAPABILITIES: { name: string; usedBy: RegExp; plistKey: string }[] = [
  {
    name: 'camera',
    usedBy: /ImagePicker\.launchCameraAsync|requestCameraPermissionsAsync/,
    plistKey: 'NSCameraUsageDescription',
  },
  {
    name: 'photo library',
    usedBy: /ImagePicker\.launchImageLibraryAsync|requestMediaLibraryPermissionsAsync/,
    plistKey: 'NSPhotoLibraryUsageDescription',
  },
];

const sources = ['src/components/ui/photo-picker.tsx', 'src/app/(tabs)/driver-signup.tsx']
  .map((path) => read(path))
  .join('\n');

for (const capability of CAPABILITIES) {
  const used = capability.usedBy.test(sources);
  const declared = String(app.ios?.infoPlist?.[capability.plistKey] ?? '');

  check(
    `the ${capability.name} has a usage description`,
    !used || declared.length > 20,
    used
      ? `the code calls it but ${capability.plistKey} is missing or too short — iOS terminates the app the moment it is used`
      : undefined,
  );

  check(
    `the ${capability.name} description says what Package Relay does with it`,
    !used || /Package Relay/.test(declared),
    'Apple rejects boilerplate that does not name the app’s own reason',
  );
}

/*
 * The plugin has to be listed too. A usage string in infoPlist alone does not
 * link the native module on a Continuous Native Generation project — /ios is
 * git-ignored here, so app.json is the only description of the native project
 * that survives.
 */
const plugins = (app.plugins ?? []).map((entry: unknown) =>
  Array.isArray(entry) ? String(entry[0]) : String(entry),
);

for (const required of ['expo-image-picker', 'expo-document-picker', 'expo-router']) {
  check(
    `${required} is registered as a config plugin`,
    plugins.includes(required),
    'it is a dependency, but prebuild will not configure the native side without this entry',
  );
}

check(
  'every listed plugin is actually installed',
  plugins.every((name: string) => existsSync(join(ROOT, 'node_modules', name, 'app.plugin.js'))),
  'a plugin that cannot resolve fails prebuild on the build server, not locally',
);

/*
 * No permission the app cannot justify.
 *
 * expo-image-picker asks for RECORD_AUDIO by default, because it can record
 * video. Package Relay never does — every call passes `mediaTypes: ['images']`. A
 * microphone permission on a delivery app is a question at Play review and a
 * scary line on the install screen, for a capability that is never used.
 */
const imagePicker = (app.plugins ?? []).find(
  (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-image-picker',
) as [string, Record<string, unknown>] | undefined;

check(
  'the microphone permission is switched off',
  imagePicker?.[1]?.microphonePermission === false,
  'expo-image-picker adds RECORD_AUDIO unless told not to, and nothing here records audio',
);

check(
  'nothing in the app records video',
  !/mediaTypes:\s*\[[^\]]*videos/.test(sources),
  'if that changes, microphonePermission has to come back',
);

// ---------------------------------------------------------- TestFlight prep --

check(
  'export compliance is answered in config',
  app.ios?.config?.usesNonExemptEncryption === false,
  'otherwise every single upload sits at "Missing Compliance" in App Store Connect until someone answers it by hand',
);

// --------------------------------------------------------------- profiles ---

const profiles = eas.build ?? {};

check('there is a development profile', Boolean(profiles.development));
check('there is a preview profile', Boolean(profiles.preview));

check(
  'the development profile builds a dev client',
  profiles.development?.developmentClient === true,
  'without this it is just a preview build that cannot attach to Metro',
);
check(
  'expo-dev-client is installed to match',
  Boolean(pkg.dependencies?.['expo-dev-client']),
  'developmentClient: true without the package produces a build that opens to a blank screen',
);

check(
  'the preview profile is not a dev client',
  profiles.preview?.developmentClient !== true,
  'the point of preview is production-like behaviour — a dev client is not that',
);

for (const name of ['development', 'preview']) {
  check(
    `${name} is marked for internal distribution`,
    profiles[name]?.distribution === 'internal',
    'without it EAS signs for the store and there is no install link',
  );
  check(
    `${name} produces an installable Android APK`,
    profiles[name]?.android?.buildType === 'apk',
    'the default app-bundle cannot be sideloaded — a tester cannot install an .aab from a link',
  );
}

/*
 * TestFlight is the one profile that must NOT be internal distribution.
 *
 * "Internal distribution" and "internal testing" are different things that
 * sound identical: the first is an ad-hoc build installed from a URL and
 * limited to registered device UDIDs, the second goes through Apple. TestFlight
 * only accepts store-signed builds.
 */
check(
  'the TestFlight profile is store-signed',
  profiles['preview-testflight']?.distribution === 'store',
  'TestFlight rejects ad-hoc builds — internal *distribution* is not internal *testing*',
);
check(
  'and it does not target the simulator',
  profiles['preview-testflight']?.ios?.simulator !== true,
  'a simulator build is an .app, not an uploadable .ipa',
);

check(
  'build numbers are managed remotely and increment',
  eas.cli?.appVersionSource === 'remote' &&
    profiles.preview?.autoIncrement === true &&
    profiles['preview-testflight']?.autoIncrement === true,
  'two builds sharing a build number confuse testers and are rejected by App Store Connect',
);

/*
 * The link between a profile and the variables EAS holds for it.
 *
 * This is the whole reason the first preview build came out with no database.
 * An `env` block in eas.json only carries literals that are committed; anything
 * stored on EAS reaches the build *only* if the profile names an environment.
 * Without this line the build runs with EXPO_PUBLIC_SUPABASE_URL unset, which
 * is not an error — the app quietly falls back to seed data.
 */
const ENVIRONMENTS: Record<string, string> = {
  development: 'development',
  preview: 'preview',
  'preview-testflight': 'preview',
  production: 'production',
};

for (const [profile, environment] of Object.entries(ENVIRONMENTS)) {
  check(
    `the ${profile} profile is bound to the ${environment} environment`,
    profiles[profile]?.environment === environment,
    'without it, variables set with `eas env:set` never reach the build and the app ships pointing at nothing',
  );
}

check(
  'each profile stamps the build channel into the app',
  ['development', 'preview', 'preview-testflight', 'production'].every(
    (name) => typeof profiles[name]?.env?.EXPO_PUBLIC_BUILD_CHANNEL === 'string',
  ),
  'the settings sheet reads this back so a bug report can name the artefact it came from',
);

// ------------------------------------------------------------- no secrets ---

/*
 * Nothing committed may carry credentials.
 *
 * The anon key is publishable by design and the app ships it in the bundle —
 * that is fine and RLS is what protects the data. A service_role key is the
 * opposite, and the fastest way to leak one is an env block in eas.json that
 * someone filled in "just to get the build working".
 */
const committed = [readJson('eas.json'), readJson('app.json')].map((value) =>
  JSON.stringify(value),
);

for (const source of committed) {
  check(
    'no service_role key in committed config',
    !/service_role|SERVICE_ROLE|SUPABASE_SERVICE/.test(source),
    'that key bypasses every Row Level Security policy in the project',
  );
  check(
    'no legacy JWT key in committed config',
    !/eyJ[A-Za-z0-9_-]{20,}/.test(source),
    'a token pasted into a tracked file is a token in the git history forever',
  );
  /*
   * Supabase's newer key format is not a JWT, so the check above walks straight
   * past it. `sb_secret_` is the dangerous one; `sb_publishable_` is safe to
   * ship inside the app but still should not enter git — this repo has a
   * GitHub remote, and a committed project URL is a permanent invitation to
   * scan it.
   */
  check(
    'no Supabase key literal in committed config',
    !/sb_(publishable|secret)_[A-Za-z0-9_-]{8,}/.test(source),
    'set it with `eas env:set` instead — the profile’s `environment` field is what carries it into the build',
  );
  check(
    'no Supabase project URL in committed config',
    !/https:\/\/[a-z0-9]{16,}\.supabase\.co/.test(source),
    'it pins this repo to one project and publishes the endpoint to anyone who can read the remote',
  );
}

check(
  '.env stays git-ignored',
  /^\.env$/m.test(read('.gitignore')),
  'the local file holds real project credentials',
);

// ---------------------------------------------------- the disconnected build --

check(
  'a build with no backend warns the tester',
  read('src/app/_layout.tsx').includes('<BuildBanner />'),
  'otherwise a build made without EXPO_PUBLIC_SUPABASE_* silently runs on seed data and every bug report is about a fiction',
);
check(
  'and the warning cannot be dismissed',
  !/dismiss|onClose|setHidden/i.test(code(read('src/components/ui/build-banner.tsx'))),
  'the condition is a property of the build; it cannot stop being true until someone rebuilds',
);
check(
  'the build is identifiable from inside the app',
  read('src/components/ui/settings-menu.tsx').includes('buildLabel()'),
  '"it crashes" is unactionable when four builds are in circulation',
);

// ------------------------------------------------- the type, and the blank page --

/*
 * ⚠ Every assertion below is one bug, and the bug was a white page shown to a
 *   sender one second after their card was charged.
 *
 *   `_layout.tsx` holds the app behind `!fontsLoaded && !fontError`, so that
 *   nothing renders in a fallback face and then reflows. That is right, and it
 *   assumed those two states are exhaustive. A font that downloads but does not
 *   *decode* is neither: `useFonts` waits on a promise that never settles and
 *   the root renders an empty background-coloured View for ever. No exception,
 *   so no error boundary catches it. Nothing in the console but a decode
 *   warning.
 *
 *   And the fonts did not decode, in production, all five of them — because
 *   importing them from `@expo-google-fonts` emits them to
 *   `assets/node_modules/@expo-google-fonts/…`, Cloudflare Pages will not
 *   upload a path containing `node_modules`, and `public/_redirects` turns each
 *   404 into `200 text/html`. The browser was handed `<!DOCTYPE html>` where a
 *   TTF should be, on every page load, for the life of that deployment.
 */
{
  const layout = read('src/app/_layout.tsx');

  check(
    'the font gate cannot hang the app for ever',
    /*
     * ⚠ The `ready` expression itself, not "is the deadline mentioned anywhere".
     *
     *   The first version of this check looked for `FONT_DEADLINE_MS` in the
     *   file, and passed happily when the deadline was declared, the timer was
     *   set, and the result was simply left out of the condition — which is the
     *   most likely way for somebody to reintroduce the bug while tidying.
     */
    /const ready =[^;]*waitedLongEnough/.test(layout) && /FONT_DEADLINE_MS/.test(layout),
    'loaded-or-errored is not exhaustive: a font that resolves but fails to decode settles\n' +
      '       neither way, and the root layout then renders an empty View permanently',
  );

  check(
    'and the deadline releases the splash too',
    /if \(ready\) \{[\s\S]{0,80}SplashScreen\.hideAsync/.test(layout),
    'a released render behind a held splash is the same blank page with extra steps',
  );

  check(
    'fonts are loaded from the repo, not from node_modules',
    /assets\/fonts\/PlusJakartaSans/.test(layout) && !/from '@expo-google-fonts/.test(layout),
    'the web export emits a package import to assets/node_modules/…, and Cloudflare Pages\n' +
      '       silently refuses to upload any path with a node_modules segment',
  );

  /*
   * ⚠ The files themselves, checked by their magic bytes.
   *
   *   A missing font is caught by the check above; a *corrupt* one is not, and
   *   corrupt is what the deployment produced. A git-lfs pointer, a truncated
   *   copy or an HTML error page committed by accident all pass a
   *   "does the file exist" test and fail in exactly the way that started this.
   */
  for (const weight of [
    '400Regular',
    '500Medium',
    '600SemiBold',
    '700Bold',
    '800ExtraBold',
  ]) {
    const path = `assets/fonts/PlusJakartaSans_${weight}.ttf`;

    check(`${weight} is present`, existsSync(join(ROOT, path)));
    if (!existsSync(join(ROOT, path))) continue;

    /*
     * ⚠ Read as latin1, not as a Buffer.
     *
     *   This project's Node types declare `readFileSync` with a required
     *   encoding, so the Buffer overload does not typecheck here — the suite
     *   passed alone and `tsc` at the end of `verify` refused it, which is the
     *   same trap the directory walk above documents. latin1 is one byte per
     *   character, so the first four characters are the first four bytes.
     */
    const head = readFileSync(join(ROOT, path), 'latin1').slice(0, 4);
    const tag = [...head].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

    check(
      `${weight} is a real font file`,
      /* 00010000 is a TrueType outline; OTTO and 'true' are the other valid tags. */
      tag === '00010000' || head === 'OTTO' || head === 'true',
      `starts with ${tag} — an HTML error page starts 3c21444f ("<!DO"), which is exactly what\n` +
        '       the CDN was serving for every font on the site',
    );
  }

  check(
    'the SPA fallback is still a catch-all, which is why a missing asset is silent',
    read('public/_redirects').includes('/*    /index.html    200'),
    'not a fault — dynamic routes need it — but it is the reason a 404 on a font arrives as a\n' +
      '       200 full of HTML, and the reason the checks above have to exist',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — identifiers are real and match, every native capability the code uses has a\n' +
    '       usage string and a registered plugin, dev/preview are internally distributed\n' +
    '       APKs, TestFlight is store-signed with auto-incrementing build numbers, no\n' +
    '       credentials are committed, and a build with no database says so on every screen.',
);
