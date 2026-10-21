// テストで共通に使うもの（東京駅のデータと、名前から地点を探す関数）
import data from '../src/data/tokyo-3d.json' with { type: 'json' }
import { listOrigins } from '../src/route-finder.js'

export { data }
export const byId = Object.fromEntries(data.points.map((p) => [p.id, p]))
export const origins = listOrigins(data)

/** 名前が name で始まる地点（出口・改札など） */
export function pointNamed(name) {
  const point = data.points.find((p) => p.name.startsWith(name))
  if (!point) throw new Error(`地点が見つかりません：${name}`)
  return point
}

/** 名前が name で始まる出発地点（改札） */
export function originNamed(name) {
  const origin = origins.find((o) => o.name.startsWith(name))
  if (!origin) throw new Error(`改札が見つかりません：${name}`)
  return origin
}

// 全部の組み合わせ（改札 49 × 行き先 176）を試すと時間がかかるので、行き先は間引いて使う
export const sampleDestinations = data.destinations.filter((_, i) => i % 9 === 0)
