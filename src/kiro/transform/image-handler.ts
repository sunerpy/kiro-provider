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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function extractImagesFromAnthropicFormat(content: unknown[]): UnifiedImage[] {
  const images: UnifiedImage[] = []
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'image' || !isRecord(item.source)) continue
    const source = item.source
    if (source.type !== 'base64' || typeof source.data !== 'string') continue
    images.push({
      mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/jpeg',
      data: source.data
    })
  }
  return images
}

function extractImagesFromOpenAI(content: unknown[]): UnifiedImage[] {
  const images: UnifiedImage[] = []
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'image_url' || !isRecord(item.image_url)) continue
    const url = item.image_url.url
    if (typeof url !== 'string' || !url.startsWith('data:')) continue
    const [header = '', data] = url.split(',', 2)
    if (!data) continue
    const mediaType = header.split(';')[0]?.replace('data:', '')
    images.push({ mediaType: mediaType || 'image/jpeg', data })
  }
  return images
}

export function extractAllImages(content: unknown): UnifiedImage[] {
  if (!Array.isArray(content)) return []
  return [...extractImagesFromAnthropicFormat(content), ...extractImagesFromOpenAI(content)]
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

export function extractTextFromParts(parts: unknown[]): string {
  const textParts: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string') textParts.push(part.text)
    else if (part.type === 'text' && part.text) textParts.push(String(part.text))
  }
  return textParts.join('')
}
