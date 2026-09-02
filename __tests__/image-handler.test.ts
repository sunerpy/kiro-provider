import { describe, expect, test } from 'bun:test'
import { convertImagesToKiroFormat } from '../src/kiro/transform/image-handler.js'

const HELLO_B64 = 'SGVsbG8='
const HELLO_BYTES = [72, 101, 108, 108, 111]

describe('convertImagesToKiroFormat', () => {
  test('decodes base64 to exact byte values and derives format from media type', () => {
    const result = convertImagesToKiroFormat([{ mediaType: 'image/png', data: HELLO_B64 }])
    expect(result.omitted).toBe(0)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.format).toBe('png')
    expect(Array.from(result.images[0]?.source.bytes ?? [])).toEqual(HELLO_BYTES)
    expect(result.images[0]?.source.bytes).toBeInstanceOf(Uint8Array)
  })
  test('media type without a subtype falls back to format png', () => {
    expect(convertImagesToKiroFormat([{ mediaType: 'image', data: HELLO_B64 }]).images[0]?.format).toBe('png')
  })
  test('caps at 4 images and reports the omitted count', () => {
    const result = convertImagesToKiroFormat(
      Array.from({ length: 6 }, () => ({ mediaType: 'image/png', data: HELLO_B64 }))
    )
    expect(result.images).toHaveLength(4)
    expect(result.omitted).toBe(2)
  })
  test('stops before exceeding the total byte budget', () => {
    const big = 'A'.repeat(2_000_000)
    const result = convertImagesToKiroFormat([
      { mediaType: 'image/png', data: big },
      { mediaType: 'image/png', data: big }
    ])
    expect(result.images).toHaveLength(1)
    expect(result.omitted).toBe(1)
  })
  test('empty input yields no images and zero omitted', () => {
    expect(convertImagesToKiroFormat([])).toEqual({ images: [], omitted: 0 })
  })
})
