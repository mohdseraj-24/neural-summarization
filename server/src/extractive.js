// Demo mode (no API key): picks the most "central" sentences, keeping their original order.
const wordsOf = s => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

export function extractiveSummary(text, maxSentences = 4) {
  let sentences = text.trim().split(/(?<=[.!?\u0964])\s+/).map(s => s.trim()).filter(Boolean)
  const longEnough = sentences.filter(s => s.length > 25)
  if (longEnough.length) sentences = longEnough
  if (sentences.length <= maxSentences) return sentences.join(' ')

  const freq = new Map()
  for (const w of wordsOf(text)) if (w.length > 3) freq.set(w, (freq.get(w) || 0) + 1)
  const score = s => {
    const ws = wordsOf(s)
    return ws.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / (ws.length || 1)
  }
  return sentences
    .map((s, i) => [i, score(s)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSentences)
    .map(([i]) => i)
    .sort((a, b) => a - b)
    .map(i => sentences[i])
    .join(' ')
}
