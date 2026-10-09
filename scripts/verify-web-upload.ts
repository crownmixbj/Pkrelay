/**
 * Assertions for reading a photo in a browser, run against the real module.
 *
 * ⚠ This one executes rather than greps, because the bug it is about was not
 *   visible in the source.
 *
 *   A sender on a mobile browser got
 *
 *       Could not read that file off this device. (blob URI, web, …)
 *
 *   on a photograph that was in memory the whole time. Every line involved
 *   looked correct: the picker returned a uri, the uploader read the uri, the
 *   uri was a valid `blob:` URL. What was wrong is that a `blob:` URL is a
 *   *handle* into the document that made it — revocable, and droppable by the
 *   browser under memory pressure — and we were keeping the handle while
 *   throwing away the `File` the picker handed us beside it.
 *
 *   So these tests drive `readFileBytes` with each thing a browser can do,
 *   including failing the way that phone failed.
 *
 * Run with `npm run verify:web-upload`.
 */
import { fileSizeOf, readFileBytes, rememberPickedFile } from '../src/lib/upload';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const text = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).join(',');

/** How many times the network was asked for anything, across a test. */
let fetches = 0;
let xhrs = 0;

/* A browser that can do everything, until a test says otherwise. */
let fetchWorks = true;
let xhrWorks = true;

globalThis.fetch = (async () => {
  fetches += 1;
  if (!fetchWorks) throw new TypeError('Failed to fetch');
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => JPEG.buffer.slice(0),
  };
}) as unknown as typeof fetch;

class FakeXhr {
  response: ArrayBuffer | null = null;
  responseType = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open() {}

  send() {
    xhrs += 1;
    setTimeout(() => {
      if (xhrWorks) {
        this.response = JPEG.buffer.slice(0);
        this.onload?.();
      } else {
        this.onerror?.();
      }
    }, 0);
  }
}

(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;

const reset = () => {
  fetches = 0;
  xhrs = 0;
  fetchWorks = true;
  xhrWorks = true;
};

async function run() {
  // ------------------------------------------- the file the picker gave us --

  /*
   * ⚠ The rung that fixes the reported bug. Nothing here touches a URL, so a
   *   revoked or discarded object URL cannot reach it.
   */
  {
    reset();
    fetchWorks = false;
    xhrWorks = false;

    const uri = rememberPickedFile({
      uri: 'blob:https://app.pkrelay.com/9a7f',
      file: new Blob([JPEG], { type: 'image/jpeg' }),
    });

    check('the uri comes back unchanged, so a call site is one word longer', uri === 'blob:https://app.pkrelay.com/9a7f');

    const read = await readFileBytes(uri, 'image/jpeg');
    check('a remembered file reads even when the browser cannot open its own URL', text(read.bytes) === text(JPEG.buffer));
    check('and the content type comes off the file itself', read.contentType === 'image/jpeg');
    check(
      'without asking the network anything',
      fetches === 0 && xhrs === 0,
      `fetch ${fetches}, xhr ${xhrs} — the bytes are already here`,
    );
  }

  /* ⚠ Released after one read: holding a face in memory after it is uploaded
     is holding a face for no reason. */
  {
    reset();
    const uri = rememberPickedFile({
      uri: 'blob:https://app.pkrelay.com/once',
      file: new Blob([JPEG], { type: 'image/jpeg' }),
    });
    await readFileBytes(uri, 'image/jpeg');
    await readFileBytes(uri, 'image/jpeg');
    check('a second read falls through to the browser', fetches === 1, `fetch ${fetches}`);
  }

  // --------------------------------------------------- the browser camera --

  /*
   * `webcam-capture.tsx` returns `canvas.toDataURL(...)`. That string *is* the
   * bytes; handing it to a network client to parse is work for nothing, twice
   * over on a phone, because the string is copied again to do it.
   */
  {
    reset();
    /* `btoa`, not `Buffer` — the module under test runs in a browser, and so
       should the thing that builds its input. */
    const base64 = btoa(String.fromCharCode(...JPEG));
    const read = await readFileBytes(`data:image/jpeg;base64,${base64}`, 'image/jpeg');

    check('a data: URI decodes to the same bytes', text(read.bytes) === text(JPEG.buffer));
    check('with no network call at all', fetches === 0 && xhrs === 0, `fetch ${fetches}, xhr ${xhrs}`);
  }

  // ------------------------------------------- a uri with no file behind it --

  {
    reset();
    const read = await readFileBytes('blob:https://app.pkrelay.com/plain', 'image/jpeg');
    check('a bare blob: uri is read by fetch', text(read.bytes) === text(JPEG.buffer) && fetches === 1);
    check('and XHR is not troubled when fetch worked', xhrs === 0);
  }

  /* ⚠ The old path, kept: it worked everywhere it ever worked. */
  {
    reset();
    fetchWorks = false;
    const read = await readFileBytes('blob:https://app.pkrelay.com/xhr-only', 'image/jpeg');
    check('XHR still catches what fetch drops', text(read.bytes) === text(JPEG.buffer) && xhrs === 1);
  }

  // ------------------------------------------------- when everything fails --

  {
    reset();
    fetchWorks = false;
    xhrWorks = false;

    let message = '';
    try {
      await readFileBytes('blob:https://app.pkrelay.com/gone', 'image/jpeg');
    } catch (thrown) {
      message = thrown instanceof Error ? thrown.message : String(thrown);
    }

    check('a read that cannot succeed still fails', message.length > 0);
    check(
      'the message says what to do',
      /Take it again/.test(message),
      message,
    );
    check(
      'and names every rung that was tried',
      /fetch:/.test(message) && /xhr:/.test(message),
      `${message} — the next report of this should say which attempts failed, not just the last`,
    );
    check(
      'it no longer claims the file is missing from the device',
      !/off this device/.test(message),
      'it was never off the device; that wording sent a sender hunting through their gallery',
    );
  }

  // ------------------------------------------------------------- bounded --

  {
    reset();
    const uris = Array.from({ length: 10 }, (_, at) =>
      rememberPickedFile({
        uri: `blob:https://app.pkrelay.com/bulk-${at}`,
        file: new Blob([JPEG], { type: 'image/jpeg' }),
      }),
    );

    /* The first two are gone; the last is held. */
    await readFileBytes(uris[0], 'image/jpeg');
    check('the oldest entries are dropped rather than accumulating', fetches === 1, `fetch ${fetches}`);

    reset();
    await readFileBytes(uris[9], 'image/jpeg');
    check('while the newest is still in hand', fetches === 0, `fetch ${fetches}`);
  }

  // --------------------------------------------------------- the size cap --

  {
    const uri = rememberPickedFile({
      uri: 'blob:https://app.pkrelay.com/big',
      file: new Blob([new Uint8Array(4096)], { type: 'image/jpeg' }),
    });

    check(
      'a held file can answer how big it is',
      (await fileSizeOf(uri)) === 4096,
      'returning null meant the size cap did not exist in a browser',
    );
    check('and an unknown uri still answers null', (await fileSizeOf('blob:nope')) === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(
    'PASS — a photo picked in a browser is read from the file the picker handed over, a\n' +
      '       camera frame is decoded without touching the network, a bare blob: uri falls\n' +
      '       through fetch to XHR, and a read that cannot succeed says which rungs it tried.',
  );
}

void run();
