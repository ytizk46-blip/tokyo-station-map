// 行き先（出口と周辺施設）の一覧と、文字からの検索

// 表記の違いをそろえる（全角英数字→半角、カタカナ→ひらがな、大文字→小文字、髙→高）
export function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replaceAll('髙', '高')
    .toLowerCase()
    .trim()
}

/**
 * 行き先の一覧を作る。出口と施設を同じ形で扱う。
 * 施設を選んだときは、その施設に近い出口までのルートを探す（exitId）
 * @param station 検索用データ（src/data/tokyo.json）
 */
export function listDestinations(station) {
  const exits = station.exits.map((exit) => ({
    id: `exit:${exit.id}`,
    kind: 'exit',
    name: exit.name,
    exitId: exit.id,
    note: exit.description,
    entrance: exit.kind === 'entrance', // 建物の入口（出口と同じように行き先にできる）
    words: [exit.name],
  }))
  const places = station.places.map((place) => {
    const exit = station.exits.find((e) => e.id === place.exitId)
    return {
      id: `place:${place.name}`,
      kind: 'place',
      name: place.name,
      exitId: place.exitId,
      exitIds: place.exitIds ?? [place.exitId],
      note: `${exit.name}が近い`,
      words: [place.name, ...place.keywords],
    }
  })
  return [...exits, ...places]
}

// 検索語に対する一致の強さ（小さいほど優先）
function matchRank(destination, query) {
  const name = normalize(destination.name)
  if (name === query || name.startsWith(`${query}出口`) || name.startsWith(`${query}の入口`)) return 0
  const words = destination.words.map(normalize)
  if (words.some((w) => w === query)) return 0
  // 数字で終わる検索語（例：「a1」「1」）は、後ろに数字が続かないもの（「a10」ではなく「a1出口」）を優先する
  const boundary = /\d$/.test(query)
    ? words.some((w) => w.startsWith(query) && !/^\d/.test(w.slice(query.length)))
    : words.some((w) => w.startsWith(query))
  if (boundary) return 1
  if (words.some((w) => w.startsWith(query))) return 2
  return 3
}

// 名前かキーワードに入力した文字が含まれる行き先を探す（出口を先に並べ、建物も候補に残す）
export function searchDestinations(destinations, text, limit = 8) {
  const query = normalize(text)
  if (query === '') return []
  const matched = destinations.filter((d) => d.words.some((word) => normalize(word).includes(query)))
  const exits = matched.filter((d) => d.kind === 'exit').sort((a, b) => matchRank(a, query) - matchRank(b, query))
  const places = matched.filter((d) => d.kind === 'place').sort((a, b) => matchRank(a, query) - matchRank(b, query))
  const reservedPlaces = places.slice(0, Math.min(places.length, Math.max(1, Math.floor(limit / 3))))
  const exitLimit = Math.max(0, limit - reservedPlaces.length)
  return [...exits.slice(0, exitLimit), ...reservedPlaces].slice(0, limit)
}

