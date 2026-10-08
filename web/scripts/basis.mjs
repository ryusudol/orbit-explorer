// KTX2 (Basis ETC1S) encoding shared by the texture scripts.
//
// Basis builds mipmaps with wrap-around addressing by default. Our maps are cut
// into tiles, and a plate-carrée map doesn't wrap north to south anyway, so at
// lower mip levels wrapping would bleed each tile's far edge into its border and
// draw faint lines along the tile seams. Clamp instead.

import { NodeBasisEncoder } from 'ktx2-encoder';
import sharp from 'sharp';

const basis = new NodeBasisEncoder();
const module = await basis.init();
const setMipGen = module.BasisEncoder.prototype.setMipGen;
module.BasisEncoder.prototype.setMipGen = function (on) {
  setMipGen.call(this, on);
  this.setMipWrapping(false);
};

/** RGB rows top-down -> KTX2 bytes, rows flipped bottom-up (v = 0 at the bottom edge), with clamped mips. */
export async function encodeKtx2(rgb, width, height, quality) {
  const rgba = await sharp(rgb, { raw: { width, height, channels: 3 } }).flip().ensureAlpha().raw().toBuffer();
  const bytes = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
  return basis.encode(bytes, {
    isUASTC: false,
    generateMipmap: true,
    qualityLevel: quality,
    compressionLevel: 2,
    isSetKTX2SRGBTransferFunc: true,
    imageDecoder: async () => ({ data: bytes, width, height }),
  });
}
