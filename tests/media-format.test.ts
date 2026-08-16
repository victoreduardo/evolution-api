import assert from 'node:assert/strict';

import { isURL } from 'class-validator';

import {
  isWhatsAppCompatibleVideo,
  resolveMediaMimetype,
  WHATSAPP_COMPATIBLE_VIDEO_MIMETYPES,
} from '../src/utils/media-format';

function testCompatibleMimetypesPassThrough() {
  // The two mimetypes WhatsApp's Cloud API docs list as inline-playable for video.
  assert.equal(WHATSAPP_COMPATIBLE_VIDEO_MIMETYPES.length, 2, 'exactly two compatible mimetypes are documented');
  assert.ok(isWhatsAppCompatibleVideo('video/mp4'), 'video/mp4 is compatible');
  assert.ok(isWhatsAppCompatibleVideo('video/3gpp'), 'video/3gpp is compatible');
}

function testIncompatibleMimetypesAreFlagged() {
  assert.equal(isWhatsAppCompatibleVideo('video/quicktime'), false, '.mov mimetype is not compatible');
  assert.equal(isWhatsAppCompatibleVideo('video/x-matroska'), false, '.mkv mimetype is not compatible');
  assert.equal(isWhatsAppCompatibleVideo('video/avi'), false, '.avi mimetype is not compatible');
}

function testNullMimetypeIsNotCompatible() {
  // A null resolved mimetype (no reliable signal) must never be treated as compatible - the
  // caller relies on this to decide "leave the video send alone" vs "we know it's bad, reroute".
  assert.equal(isWhatsAppCompatibleVideo(null), false, 'null is not compatible');
}

function testExplicitMimetypeWinsOverFileNameAndUrl() {
  const resolved = resolveMediaMimetype(
    { mimetype: 'video/mp4', fileName: 'clip.mov', media: 'https://example.com/clip.mkv' },
    isURL,
  );
  assert.equal(resolved, 'video/mp4', 'explicit mimetype takes priority over fileName and URL');
}

function testFileNameWinsOverUrlWhenNoExplicitMimetype() {
  const resolved = resolveMediaMimetype({ fileName: 'clip.mov', media: 'https://example.com/clip.mp4' }, isURL);
  assert.equal(resolved, 'video/quicktime', 'fileName extension is used when there is no explicit mimetype');
}

function testUrlExtensionIsUsedAsLastResort() {
  const resolved = resolveMediaMimetype({ media: 'https://example.com/path/clip.mov' }, isURL);
  assert.equal(resolved, 'video/quicktime', 'URL path extension is used when mimetype and fileName are absent');
}

function testUrlWithQueryStringStillResolvesFromPathname() {
  // new URL(...).pathname strips the query string, so a signed URL with a token after the
  // extension must still resolve correctly.
  const resolved = resolveMediaMimetype({ media: 'https://example.com/clip.mp4?token=abc123&exp=999' }, isURL);
  assert.equal(resolved, 'video/mp4', 'query string does not interfere with extension lookup');
}

function testNoReliableSignalReturnsNull() {
  // Bare base64 payload, no mimetype, no fileName, media is not a URL - nothing to go on.
  const resolved = resolveMediaMimetype({ media: 'aGVsbG8gd29ybGQ=' }, isURL);
  assert.equal(resolved, null, 'returns null instead of guessing when there is no signal');
}

function testEmptyStringMimetypeFallsThroughToFileName() {
  // An explicit-but-empty mimetype (e.g. a client sending mimetype: "") must not be treated as
  // a real signal - `if (media.mimetype)` is falsy for '', so this should fall through to the
  // next tier rather than resolving to an empty string.
  const resolved = resolveMediaMimetype({ mimetype: '', fileName: 'clip.mov' }, isURL);
  assert.equal(resolved, 'video/quicktime', 'empty-string mimetype falls through to fileName tier');
}

function testUnresolvableFileNameFallsThroughToUrl() {
  // fileName with no recognizable extension (mime-types.lookup returns false) must not stop
  // resolution - it should still fall through to the URL tier.
  const resolved = resolveMediaMimetype({ fileName: 'clip', media: 'https://example.com/clip.mp4' }, isURL);
  assert.equal(resolved, 'video/mp4', 'unresolvable fileName extension falls through to URL tier');
}

function testProtocolLessUrlDoesNotThrow() {
  // Regression test. class-validator's isURL() defaults to `require_protocol: false`, so it
  // returns true for a bare-domain string like "example.com/clip.mov" - but `new URL(...)` on
  // that same string throws TypeError [ERR_INVALID_URL] because it has no scheme. Before the
  // fix, this crashed resolveMediaMimetype (and therefore mediaMessage()) with a raw, unhandled
  // TypeError for any video sent with only this kind of protocol-less media URL and no explicit
  // mimetype/fileName - live-reproduced, isURL('example.com/clip.mov') === true while
  // `new URL('example.com/clip.mov')` throws.
  const protocolLessUrl = 'example.com/clip.mov';
  assert.ok(isURL(protocolLessUrl), 'sanity check: isURL() does consider this string a URL');
  assert.throws(() => new URL(protocolLessUrl), 'sanity check: the URL constructor rejects it');

  let resolved: string | null = 'not called';
  assert.doesNotThrow(() => {
    resolved = resolveMediaMimetype({ media: protocolLessUrl }, isURL);
  }, 'resolveMediaMimetype must not throw for a protocol-less URL isURL() accepts');
  assert.equal(resolved, null, 'falls back to "no reliable signal" instead of crashing');
}

function testWellFormedAbsoluteUrlStillWorksAfterFix() {
  // Make sure the try/catch fix didn't silently swallow the success path too.
  const resolved = resolveMediaMimetype({ media: 'https://example.com/clip.mp4' }, isURL);
  assert.equal(resolved, 'video/mp4', 'a well-formed absolute URL still resolves normally');
}

function run() {
  testCompatibleMimetypesPassThrough();
  testIncompatibleMimetypesAreFlagged();
  testNullMimetypeIsNotCompatible();
  testExplicitMimetypeWinsOverFileNameAndUrl();
  testFileNameWinsOverUrlWhenNoExplicitMimetype();
  testUrlExtensionIsUsedAsLastResort();
  testUrlWithQueryStringStillResolvesFromPathname();
  testNoReliableSignalReturnsNull();
  testEmptyStringMimetypeFallsThroughToFileName();
  testUnresolvableFileNameFallsThroughToUrl();
  testProtocolLessUrlDoesNotThrow();
  testWellFormedAbsoluteUrlStillWorksAfterFix();
  console.log('media-format: OK');
}

run();
