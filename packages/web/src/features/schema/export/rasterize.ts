/** Chromium refuses canvases past ~16k a side, and very large bitmaps take long to encode. */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 50_000_000;

/**
 * Pixels per diagram unit for the PNG: 2× (or the screen's ratio when higher), lowered so a
 * very large diagram still fits a canvas.
 */
export function pngScale(width: number, height: number, preferred = Math.max(2, window.devicePixelRatio || 1)): number {
  const fits = Math.min(MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.min(preferred, fits);
}

/**
 * Draws the SVG into a canvas at `scale` and encodes it as PNG. The SVG goes in as a data URL
 * (the page's CSP allows data: images, not blob:); it has no external references, so the
 * canvas isn't tainted and toBlob works.
 */
export async function svgToPng(svg: string, width: number, height: number, scale: number): Promise<Uint8Array> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The diagram could not be drawn as an image.'));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas is available to draw the diagram.');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The diagram is too large to export as PNG; try SVG.');
  return new Uint8Array(await blob.arrayBuffer());
}
