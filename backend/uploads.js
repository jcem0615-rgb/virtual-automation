// Product photos, picked off the seller's phone.
//
// A marketplace will not look at a picture on somebody's device: Shopee,
// Lazada and TikTok Shop all fetch the image over HTTP while they build the
// listing. So a photo chosen in the gallery has to become a URL this
// deployment serves before a listing can carry it — which is what this file
// does, and why the served directory is public.
//
// The browser sends the File object as the whole request body, with its own
// content type. One picture per request, no multipart envelope, no parser and
// no extra dependency. What the browser claims the file is counts for
// nothing: the type is read out of the first bytes, and anything that is not
// a picture is refused.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';

// Where the files land. In the container this is a volume, so photos survive
// a rebuild; the path is absolute so it never depends on the working directory.
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? './uploads');

// 8MB is a generous phone photo. A marketplace will downscale anyway.
export const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024);

// Sniffed from the first bytes, never from the Content-Type header. Formats
// every one of these marketplaces accepts, plus webp, which modern phones
// hand over for a shared photo.
const SIGNATURES = [
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    type: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: 'webp',
    type: 'image/webp',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF'
      && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    ext: 'gif',
    type: 'image/gif',
    test: (b) => b.toString('ascii', 0, 3) === 'GIF',
  },
];

/** What this actually is, by its own first bytes. null if it is not a picture. */
export function sniff(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer)) ?? null;
}

/**
 * Write one picture under a business and give back the path it is served at.
 * The name is random: these files are public, so the only thing standing
 * between a photo and a stranger is a name nobody can guess.
 */
export async function storeImage(businessId, buffer) {
  const kind = sniff(buffer);
  if (!kind) return null;
  const dir = path.join(UPLOAD_DIR, businessId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  await fs.writeFile(path.join(dir, name), buffer);
  return { url: `/uploads/${businessId}/${name}`, type: kind.type, bytes: buffer.length };
}

/**
 * Mount the upload route and serve what it wrote.
 *
 * GET /uploads/* is open on purpose — a marketplace fetching the image is not
 * signed in to this dashboard and never will be. Writing one is not: it takes
 * an owner's session on the business the photo is filed under.
 */
export function registerUploads(app, ctx) {
  const { wrap, HttpError, requireUser, requireOwner, assertUuid, q, logAction } = ctx;

  app.use('/uploads', express.static(UPLOAD_DIR, {
    maxAge: '365d',             // the name is random, so a file never changes
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));

  app.use('/api/uploads', requireUser);
  app.post(
    '/api/uploads',
    // Any image type, and anything a phone mislabels: what it is gets decided
    // by sniff(), not by this.
    express.raw({ type: () => true, limit: MAX_UPLOAD }),
    wrap(async (req, res) => {
      const user = req.user;
      const businessId = String(req.query.business_id ?? '');
      assertUuid(businessId, 'business_id');
      requireOwner(user, businessId);

      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body?.length) throw new HttpError(400, 'send the photo as the request body');
      const stored = await storeImage(businessId, body);
      if (!stored) {
        throw new HttpError(415, 'that file is not a JPEG, PNG, WebP or GIF picture');
      }

      await logAction({ query: (text, params) => q(text, params) }, {
        businessId,
        action: 'PRODUCT_IMAGE_UPLOADED',
        actor: user.email,
        actorUserId: user.id,
        detail: { url: stored.url, bytes: stored.bytes, type: stored.type },
      });
      res.status(201).json(stored);
    }),
  );
}
