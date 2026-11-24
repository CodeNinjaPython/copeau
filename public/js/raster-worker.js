import { rasterGcode } from './shared/raster.js';

self.onmessage = ({ data }) => {
  const { bitmap, width, height, options } = data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Traitement d’image indisponible');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
    }
    self.postMessage({ result: rasterGcode({ gray, width, height }, options) });
  } catch (error) {
    self.postMessage({ error: error.message || 'Échec de la génération du G-code' });
  } finally {
    bitmap.close();
  }
};
