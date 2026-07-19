import { describe, expect, test } from 'bun:test'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../src/kiro/transform/image-handler.js'

const HELLO_B64 = 'SGVsbG8='
const HELLO_BYTES = [72, 101, 108, 108, 111]

describe('extractAllImages', () => {
  test('returns [] for non-array content', () => {
    expect(extractAllImages('a string')).toEqual([])
    expect(extractAllImages(null)).toEqual([])
    expect(extractAllImages(undefined)).toEqual([])
    expect(extractAllImages({ type: 'image' })).toEqual([])
  })
  test('extracts Anthropic base64 image with declared media_type', () => {
    expect(
      extractAllImages([
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: HELLO_B64 } }
      ])
    ).toEqual([{ mediaType: 'image/png', data: HELLO_B64 }])
  })
  test('Anthropic image without media_type defaults to image/jpeg', () => {
    expect(extractAllImages([{ type: 'image', source: { type: 'base64', data: HELLO_B64 } }])).toEqual([
      { mediaType: 'image/jpeg', data: HELLO_B64 }
    ])
  })
  test('ignores Anthropic image whose source type is not base64', () => {
    expect(extractAllImages([{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }])).toEqual([])
  })
  test('extracts OpenAI data-URL image and parses media type from header', () => {
    expect(
      extractAllImages([{ type: 'image_url', image_url: { url: `data:image/webp;base64,${HELLO_B64}` } }])
    ).toEqual([{ mediaType: 'image/webp', data: HELLO_B64 }])
  })
  test('OpenAI data URL with no explicit media type defaults to image/jpeg', () => {
    expect(extractAllImages([{ type: 'image_url', image_url: { url: `data:;base64,${HELLO_B64}` } }])).toEqual([
      { mediaType: 'image/jpeg', data: HELLO_B64 }
    ])
  })
  test('ignores OpenAI image_url that is not a data URL (http)', () => {
    expect(extractAllImages([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }])).toEqual([])
  })
  test('ignores data URL with no data portion after the comma', () => {
    expect(extractAllImages([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }])).toEqual([])
  })
  test('combines Anthropic then OpenAI images in that order', () => {
    expect(
      extractAllImages([
        { type: 'image_url', image_url: { url: `data:image/gif;base64,${HELLO_B64}` } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: HELLO_B64 } }
      ])
    ).toEqual([
      { mediaType: 'image/png', data: HELLO_B64 },
      { mediaType: 'image/gif', data: HELLO_B64 }
    ])
  })
})

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

describe('extractTextFromParts', () => {
  test('joins text fields with no separator', () => {
    expect(extractTextFromParts([{ text: 'foo' }, { text: 'bar' }])).toBe('foobar')
  })
  test('handles explicit type:text parts', () => {
    expect(
      extractTextFromParts([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' }
      ])
    ).toBe('hello world')
  })
  test('skips parts with no text', () => {
    expect(extractTextFromParts([{ type: 'image' }, { text: 'kept' }, {}])).toBe('kept')
  })
  test('ignores non-string text values', () => {
    expect(extractTextFromParts([{ text: 123 }, { text: 'ok' }])).toBe('ok')
  })
  test('empty array yields empty string', () => expect(extractTextFromParts([])).toBe(''))
})
