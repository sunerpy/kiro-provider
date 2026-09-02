export interface UnifiedImage {
  mediaType: string
  data: string
}

const MAX_KIRO_IMAGES = 4
const MAX_KIRO_IMAGE_BYTES = 3_750_000

export interface KiroImage {
  format: string
  source: { bytes: Uint8Array }
}

export interface ImageConversionResult {
  images: KiroImage[]
  omitted: number
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function convertImagesToKiroFormat(images: UnifiedImage[]): ImageConversionResult {
  const selected: UnifiedImage[] = []
  let totalBase64Chars = 0
  for (const image of images) {
    if (selected.length >= MAX_KIRO_IMAGES) break
    if (totalBase64Chars + image.data.length > MAX_KIRO_IMAGE_BYTES) break
    selected.push(image)
    totalBase64Chars += image.data.length
  }

  return {
    images: selected.map((image) => ({
      format: image.mediaType.split('/')[1] || 'png',
      source: { bytes: base64ToUint8Array(image.data) }
    })),
    omitted: images.length - selected.length
  }
}
