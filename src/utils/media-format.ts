import mimeTypes from 'mime-types';

// WhatsApp's official Supported Media Types table lists exactly these two for video messages
// (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media/). Anything else -
// e.g. QuickTime .mov, Matroska .mkv - either fails to play or never shows up on the recipient's
// device, even though the upload to WhatsApp's servers itself succeeds without error.
//
// Note: this is a container/mimetype-level check only, not a codec check. WhatsApp additionally
// requires H.264 video (+ AAC audio, if any) inside the container - an .mp4 carrying HEVC/H.265
// would pass this check and still fail to play. Baileys itself does no codec validation; deep
// validation would need a codec probe (e.g. ffprobe), which this does not do. Known limitation,
// not fixed here - see docs/plans/2026-08-16-known-bugs.md.
export const WHATSAPP_COMPATIBLE_VIDEO_MIMETYPES = ['video/mp4', 'video/3gpp'];

export type MediaLike = {
  mimetype?: string;
  fileName?: string;
  media?: string;
};

/**
 * Best-effort mimetype resolution for outgoing media, used to decide whether a "video" send can
 * go out as an inline-playable video message or needs to fall back to a generic document
 * attachment. Returns null when there's no reliable signal (e.g. bare base64 with no
 * fileName/mimetype/URL extension) - callers should leave the requested type unchanged in that
 * case rather than guessing.
 */
export function resolveMediaMimetype(media: MediaLike, isUrl: (value: string) => boolean): string | null {
  if (media.mimetype) {
    return media.mimetype;
  }

  if (media.fileName) {
    const byFileName = mimeTypes.lookup(media.fileName);
    if (byFileName) return byFileName;
  }

  if (media.media && isUrl(media.media)) {
    const byUrl = mimeTypes.lookup(new URL(media.media).pathname);
    if (byUrl) return byUrl;
  }

  return null;
}

/** True when a resolved video mimetype is one WhatsApp will actually play inline. */
export function isWhatsAppCompatibleVideo(mimetype: string | null): boolean {
  return mimetype !== null && WHATSAPP_COMPATIBLE_VIDEO_MIMETYPES.includes(mimetype);
}
