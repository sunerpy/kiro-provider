import { RequestTransformError } from './errors.js'

export interface UnifiedImage {
  mediaType: string
  data: string
  /** Source path of the image block, used for error `param` values. */
  path?: string
}

const MAX_KIRO_IMAGES = 4
const MAX_KIRO_IMAGE_BYTES = 3_750_000

/** The exact `ImageFormat` enum accepted by the Kiro streaming SDK. */
export const KIRO_IMAGE_FORMATS = ['gif', 'jpeg', 'png', 'webp'] as const

export type KiroImageFormat = (typeof KIRO_IMAGE_FORMATS)[number]

const MEDIA_TYPE_FORMATS: Readonly<Record<string, KiroImageFormat>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp'
}

export interface KiroImage {
  format: KiroImageFormat
  source: { bytes: Uint8Array }
}

export interface ImageConversionResult {
  images: KiroImage[]
  omitted: number
}

function kiroImageFormat(mediaType: string, path: string): KiroImageFormat {
  const format = MEDIA_TYPE_FORMATS[mediaType.trim().toLowerCase()]
  if (format === undefined) {
    throw new RequestTransformError(
      `Image ${path} media type ${mediaType} is not supported by Kiro; use image/png, image/jpeg, image/gif, or image/webp`,
      'unsupported_image_media_type',
      path
    )
  }
  return format
}

function decodeImageBase64(value: string, path: string): Uint8Array {
  if (value.length === 0) {
    throw new RequestTransformError(
      `Image ${path} contains no base64 data`,
      'invalid_image_data',
      path
    )
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    throw new RequestTransformError(
      `Image ${path} contains invalid base64 data`,
      'invalid_image_data',
      path
    )
  }
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
    images: selected.map((image) => {
      const path = image.path ?? 'image'
      return {
        format: kiroImageFormat(image.mediaType, path),
        source: { bytes: decodeImageBase64(image.data, path) }
      }
    }),
    omitted: images.length - selected.length
  }
}
