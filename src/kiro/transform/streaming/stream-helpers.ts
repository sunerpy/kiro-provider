export function findRealTag(buffer: string, tag: string): number {
  const codeBlockPattern = /```[\s\S]*?```/g
  const codeBlocks: Array<readonly [number, number]> = []

  let match = codeBlockPattern.exec(buffer)
  while (match !== null) {
    codeBlocks.push([match.index, match.index + match[0].length])
    match = codeBlockPattern.exec(buffer)
  }

  let position = buffer.indexOf(tag, 0)
  while (position !== -1) {
    const insideCodeBlock = codeBlocks.some(
      ([start, end]) => position >= start && position < end
    )
    if (!insideCodeBlock) return position
    position = buffer.indexOf(tag, position + tag.length)
  }

  return -1
}
