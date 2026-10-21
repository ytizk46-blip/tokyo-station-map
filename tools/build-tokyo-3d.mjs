// 国土交通省「東京駅周辺屋内地図オープンデータ（Shapefile）」から、構内ナビで使う東京駅のデータを作る。
//
//   src/data/tokyo-3d.json … 階・地点・歩けるつながり（ルート探索用）と、立体の形（床・部屋・柱や壁）
//   src/data/tokyo.json    … 検索用の行き先（出口・建物の入口・建物）
//
// 使い方：node tools/build-tokyo-3d.mjs [データのフォルダ]（npm run data）
// フォルダを省略したときは、このプロジェクトの隣の shapefile フォルダ（C:\projects\shapefile）の中を使う。
// 元データは大きい（約43MB）ので git には入れず、作ったデータだけを入れる。
//
// 最後に「全部の改札 × 全部の行き先」でルートが見つかるか、1人称で歩けるマス目がルートとずれていないかを確かめ、
// 問題があれば終了コード 1 で終わる。
import { readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readShapefile } from './shapefile.mjs'
import { encodeCells, WALK, LOW, OUTDOOR, FIXTURE } from '../src/walk-grid.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = process.argv[2] ??
  join(here, '..', '..', 'shapefile', '東京駅周辺屋内地図オープンデータ（Shapefile）')
const outputMap = join(here, '..', 'src', 'data', 'tokyo-3d.json')
const outputStation = join(here, '..', 'src', 'data', 'tokyo.json')

if (!existsSync(source)) {
  console.error(`データのフォルダが見つかりません：${source}`)
  console.error('G空間情報センター「東京駅周辺屋内地図オープンデータ」の Shapefile をダウンロードして展開してください')
  console.error('https://www.geospatial.jp/ckan/dataset/mlit-indoor-tokyo-r2')
  process.exit(1)
}

// ---- 座標の変換 ----
// 原点は JR 東京駅（丸の内駅舎と八重洲口の間あたり）。単位はメートル。
// 構内ナビの決まりに合わせて、X は北がプラス、Z は東がプラス。範囲が2km ほどなので平面とみなして計算する。
const ORIGIN = [139.7671, 35.6812] // [経度, 緯度]
const R = 6378137
const toRad = Math.PI / 180
const kx = R * toRad * Math.cos(ORIGIN[1] * toRad)
const ky = R * toRad
const round = (v) => Math.round(v * 10) / 10 // 10cm 単位にして、ファイルを小さくする
// [経度, 緯度] → [x（北）, z（東）]
const project = ([lon, lat]) => [round((lat - ORIGIN[1]) * ky), round((lon - ORIGIN[0]) * kx)]

// ---- 階 ----
// 元データの階（ordinal）は 1（1階）、0（グランドレベル＝駅前広場などの屋外）、-1（地下1階）、-2（地下2階）。
// 1 と 0 は同じ高さ（地上）なので、ひとつの「1階・地上」にまとめる。
// 1.5 や -0.5 は階段の踊り場などで、つながりを作るときに取り除く（removeLandings）
const FLOORS = [
  { id: '1F', name: '1階・地上', level: 0, color: '#0284c7' },
  { id: 'B1', name: '地下1階', level: -1, color: '#7c3aed' },
  { id: 'B2', name: '地下2階', level: -2, color: '#dc2626' },
]
function floorOf(ordinal) {
  if (!Number.isInteger(ordinal)) return null
  if (ordinal >= 0) return '1F'
  return ordinal === -1 ? 'B1' : 'B2'
}
const floorName = (id) => FLOORS.find((f) => f.id === id).name

// ---- 形のデータ ----

// 同じ点が続いているところを1つにまとめる
function cleanRing(points) {
  const out = []
  for (const p of points.map(project)) {
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  // 閉じた輪の最後の点（最初と同じ点）は要らない
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
  return out
}

// 輪の面積（向きによって符号が変わる）
function signedArea(ring) {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function insideRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Shapefile の面は「外側の輪（時計回り）」と「穴（反時計回り）」が並んでいる。
// これを [[外側, 穴, 穴...], ...] の形にまとめる。
// （緯度経度の向きで判定してから座標を変換するので、x と y が入れ替わっても向きの判定は変わらない）
function toPolygons(parts) {
  const rings = parts.map(cleanRing).filter((r) => r.length >= 3)
  const outers = []
  const holes = []
  // project で x と y が入れ替わるので、面積の符号も逆になる（時計回りの外側がプラス）
  for (const r of rings) (signedArea(r) > 0 ? outers : holes).push(r)
  // 向きが逆に入っているデータもあるので、外側が無いときは全部外側として扱う
  if (outers.length === 0) return holes.map((r) => [r])
  const polygons = outers.map((r) => [r])
  for (const h of holes) {
    const owner = polygons.find((p) => insideRing(h[0], p[0]))
    if (owner) owner.push(h)
  }
  return polygons
}

// 部屋・空間（Space）の種類 → 見た目のグループ。
// コードは国土地理院「階層別屋内地理空間情報データ仕様書（案）」別表による
function spaceStyleOf(code) {
  if (code === 'B029' || code === 'B028' || code === 'B024') return 'walkway'
  if (code === 'B001') return 'shop'
  if (/^B0(0[7-9]|1[0-4])$/.test(code)) return 'toilet'
  if (['B002', 'B003', 'B004', 'B005', 'B006', 'B015', 'B016', 'B017', 'B018'].includes(code)) return 'service'
  if (code === 'B021') return 'stairs'
  if (code === 'B022') return 'elevator'
  if (code === 'B023') return 'escalator'
  if (code === 'B025') return 'slope'
  if (code === 'B020') return null // 吹き抜けは描かない
  return 'other'
}

// ---- 建物（施設）ごとのフォルダを読む ----
// フォルダ名は「1.JR東京駅」「2.地下鉄_公共通路」のような形
const ordinalOf = (name) => (name.startsWith('B') ? -Number(name.slice(1)) : Number(name))

const buildings = []
const shapes = Object.fromEntries(FLOORS.map((f) => [f.id, { floor: [], spaces: {}, fixture: [] }]))
const buildingFloors = [] // 地点がどの建物の中かを調べるための床の形 { b, floor, ring, area }
const segments = [] // 区画（地下街の名前など） { floor, name, ring }
const facilities = [] // 設備（出口・入口など） { b, floor, c, name, at }
const openings = [] // 開口部（改札・入口など） { b, floor, name, at }
const groundFloors = Object.fromEntries(FLOORS.map((f) => [f.id, []])) // 地上（ordinal 0）の床。屋外なので天井を付けない

const buildingDirs = readdirSync(source)
  .filter((d) => d !== 'nw' && /^\d+\./.test(d))
  .sort((a, b) => parseInt(a) - parseInt(b))

for (const dir of buildingDirs) {
  const b = buildings.length
  buildings.push(dir.replace(/^\d+\./, '').replace(/_/g, '・'))
  for (const floorDir of readdirSync(join(source, dir))) {
    if (floorDir.endsWith('.xml')) continue
    const floor = floorOf(ordinalOf(floorDir))
    const shape = shapes[floor]
    for (const file of readdirSync(join(source, dir, floorDir))) {
      if (!file.endsWith('.shp')) continue
      const layer = file.slice(0, -4).split('_').pop() // 例：JRTokyoSta_1_Space → Space
      for (const { geometry, properties: p } of readShapefile(join(source, dir, floorDir, file.slice(0, -4)))) {
        if (!geometry) continue
        if (layer === 'Floor') {
          for (const poly of toPolygons(geometry)) {
            shape.floor.push(poly)
            if (ordinalOf(floorDir) === 0) groundFloors[floor].push(poly)
            buildingFloors.push({ b, floor, ring: poly[0], area: Math.abs(signedArea(poly[0])) })
          }
        } else if (layer === 'Space') {
          const style = spaceStyleOf(p.category)
          if (style) for (const poly of toPolygons(geometry)) (shape.spaces[style] ??= []).push(poly)
        } else if (layer === 'Fixture') {
          for (const poly of toPolygons(geometry)) shape.fixture.push(poly)
        } else if (layer === 'Segment' && p.name) {
          for (const poly of toPolygons(geometry)) {
            segments.push({ floor, name: p.name.trim(), poly, area: Math.abs(signedArea(poly[0])) })
          }
        } else if (layer === 'Facility') {
          facilities.push({ b, floor, c: p.category, name: p.name, at: project(geometry) })
        } else if (layer === 'Opening' && p.name) {
          // 開口部は線。真ん中あたりの点を位置にする
          const line = geometry.flat().map(project)
          const a = line[0]
          const z = line[line.length - 1]
          openings.push({ b, floor, name: p.name, at: [round((a[0] + z[0]) / 2), round((a[1] + z[1]) / 2)] })
        }
        // Drawing（図面の線）と TWSI（点字ブロック）は使わない（ファイルを小さくするため）
      }
    }
  }
}

// ---- 歩行者ネットワーク ----
// node：位置と階（ordinal。踊り場などは 1.5 のような小数）
// link：start_id → end_id。route_type は 1 通路、4 エレベーター、5 エスカレーター、6 階段、7 スロープ。
//       direction は 1 両方向、2 起点→終点だけ、3 終点→起点だけ。
const nodeFeatures = readShapefile(join(source, 'nw', 'Tokyo_node'))
const linkFeatures = readShapefile(join(source, 'nw', 'Tokyo_Link'))
const nodeIndex = new Map()
const rawNodes = nodeFeatures.map(({ geometry, properties: p }, i) => {
  nodeIndex.set(p.node_id, i)
  const [x, z] = project(geometry)
  return { x, z, ordinal: p.ordinal }
})
let links = []
for (const { geometry, properties: p } of linkFeatures) {
  const a = nodeIndex.get(p.start_id)
  const b = nodeIndex.get(p.end_id)
  if (a === undefined || b === undefined || a === b) continue
  const middle = geometry ? geometry.flat().slice(1, -1).map(project) : []
  const direction = Number(p.direction)
  links.push({
    a, b,
    type: Number(p.route_type),
    forward: direction !== 3, // a → b へ通れるか
    backward: direction !== 2, // b → a へ通れるか
    distance: p.distance > 0 ? p.distance : Math.hypot(rawNodes[a].x - rawNodes[b].x, rawNodes[a].z - rawNodes[b].z),
    middle,
  })
}

// 踊り場（階が小数の地点）を取り除き、その両側の地点を直接つなぐ。
// 種類は「階段 > エレベーター > エスカレーター > スロープ > 通路」の順で強いほうにする
// （階段を1か所でも通るなら「階段なし」では使わない）
const TYPE_RANK = { 6: 5, 4: 4, 5: 3, 7: 2, 1: 1 }
function removeLandings() {
  for (;;) {
    const landing = rawNodes.findIndex((n, i) => !Number.isInteger(n.ordinal) && links.some((l) => l.a === i || l.b === i))
    if (landing < 0) return
    // landing を向こう側（other）へ向けたつながりにそろえる
    const around = links
      .filter((l) => l.a === landing || l.b === landing)
      .map((l) => (l.a === landing
        ? { other: l.b, toLanding: l.backward, fromLanding: l.forward, link: l }
        : { other: l.a, toLanding: l.forward, fromLanding: l.backward, link: l }))
    links = links.filter((l) => l.a !== landing && l.b !== landing)
    for (let i = 0; i < around.length; i++) {
      for (let j = i + 1; j < around.length; j++) {
        const [p, q] = [around[i], around[j]]
        if (p.other === q.other) continue
        const forward = p.toLanding && q.fromLanding // p.other → landing → q.other
        const backward = q.toLanding && p.fromLanding
        if (!forward && !backward) continue
        const type = TYPE_RANK[p.link.type] >= TYPE_RANK[q.link.type] ? p.link.type : q.link.type
        links.push({ a: p.other, b: q.other, type, forward, backward, distance: p.link.distance + q.link.distance, middle: [] })
      }
    }
  }
}
removeLandings()

// ---- 地点と、歩けるつながり（構内ナビの形） ----
// 通路の地点は type: 'node'。階段・エスカレーター・エレベーターは、両端に connector 番号が同じ2点を置く。
// 歩きにくさの倍率（ルートのコスト）：階段 1.5、エスカレーター 1、エレベーター 5（ふだんは選ばれない）
const CONNECTOR = {
  6: { type: 'stairs', factor: 1.5 },
  5: { type: 'escalator', factor: 1 },
  4: { type: 'elevator', factor: 5 },
  7: { type: 'slope', factor: 1 },
  1: { type: 'slope', factor: 1 }, // 階をまたぐ通路（ゆるい坂）。データでは数か所だけ
}

const points = []
const edges = []
const nodeId = (i) => `n${i}`
const usedNodes = new Set()
for (const l of links) usedNodes.add(l.a).add(l.b)
for (const i of usedNodes) {
  const n = rawNodes[i]
  points.push({ id: nodeId(i), name: '通路', type: 'node', floor: floorOf(n.ordinal), x: n.x, z: n.z })
}
const pointById = new Map(points.map((p) => [p.id, p]))

let connectorCount = 0
let middleCount = 0
const addEdge = (a, b, cost, forward = true, backward = true) => {
  if (!forward && !backward) return
  if (forward && backward) edges.push([a, b, round(Math.max(0.1, cost))])
  else if (forward) edges.push([a, b, round(Math.max(0.1, cost)), 1])
  else edges.push([b, a, round(Math.max(0.1, cost)), 1])
}

for (const l of links) {
  const [pa, pb] = [pointById.get(nodeId(l.a)), pointById.get(nodeId(l.b))]
  const crossFloor = pa.floor !== pb.floor
  // 階をまたぐつながりと、同じ階の中の階段（数段の段差など）は、両端に connector の2点を置く。
  // 同じ階の中の階段も connector にするのは、「階段なし」で避けられるようにするため
  if (crossFloor || l.type === 6) {
    const { type, factor } = CONNECTOR[l.type] ?? CONNECTOR[1]
    const k = ++connectorCount
    const ends = [pa, pb].map((p, e) => {
      const point = { id: `c${k}-${e + 1}`, name: '', type, connector: k, floor: p.floor, x: p.x, z: p.z }
      points.push(point)
      pointById.set(point.id, point)
      return point
    })
    addEdge(pa.id, ends[0].id, 0.1)
    addEdge(ends[0].id, ends[1].id, l.distance * factor, l.forward, l.backward)
    addEdge(ends[1].id, pb.id, 0.1)
    continue
  }
  // 同じ階の通路など。途中で曲がるつながりは、曲がり角にも地点を置く（ルートの線を通路に沿わせるため）
  const factor = l.type === 4 ? 5 : 1 // 同じ階の中のエレベーター（乗り場の前の短い区間など）
  let prev = pa
  const total = l.distance
  const pathLength = [pa, ...l.middle.map(([x, z]) => ({ x, z })), pb]
    .reduce((sum, p, i, all) => (i ? sum + Math.hypot(p.x - all[i - 1].x, p.z - all[i - 1].z) : 0), 0) || 1
  for (const [x, z] of l.middle) {
    const point = { id: `m${++middleCount}`, name: '通路', type: 'node', floor: pa.floor, x, z }
    points.push(point)
    pointById.set(point.id, point)
    const part = (Math.hypot(x - prev.x, z - prev.z) / pathLength) * total * factor
    addEdge(prev.id, point.id, part, l.forward, l.backward)
    prev = point
  }
  addEdge(prev.id, pb.id, (Math.hypot(pb.x - prev.x, pb.z - prev.z) / pathLength) * total * factor, l.forward, l.backward)
}

// ---- いちばん大きなひと続きのネットワークだけを残す ----
// （ほかとつながっていない小さなネットワークが十数個ある。そこへはルートを探せないので除く）
function keepLargestComponent() {
  const neighbors = new Map(points.map((p) => [p.id, []]))
  for (const [a, b] of edges) {
    neighbors.get(a).push(b)
    neighbors.get(b).push(a)
  }
  const component = new Map()
  const sizes = []
  for (const p of points) {
    if (component.has(p.id)) continue
    const c = sizes.length
    const stack = [p.id]
    component.set(p.id, c)
    let size = 0
    while (stack.length) {
      const id = stack.pop()
      size++
      for (const next of neighbors.get(id)) {
        if (!component.has(next)) {
          component.set(next, c)
          stack.push(next)
        }
      }
    }
    sizes.push(size)
  }
  const largest = sizes.indexOf(Math.max(...sizes))
  const keep = new Set(points.filter((p) => component.get(p.id) === largest).map((p) => p.id))
  const removed = points.length - keep.size
  points.splice(0, points.length, ...points.filter((p) => keep.has(p.id)))
  edges.splice(0, edges.length, ...edges.filter(([a]) => keep.has(a)))
  return { removed, groups: sizes.length }
}
const pruned = keepLargestComponent()
pointById.clear()
for (const p of points) pointById.set(p.id, p)

// ---- 地点がどこの通路か（道順の文章に使う） ----
// 地下街などの区画（Segment）の中ならいちばん小さい区画の名前、そうでなければいちばん小さい建物の床の中の、建物の名前
function insidePolygon(at, poly) {
  return insideRing(at, poly[0]) && !poly.slice(1).some((hole) => insideRing(at, hole))
}
function passageOf(point) {
  const at = [point.x, point.z]
  let bestSegment = null
  for (const s of segments) {
    if (s.floor !== point.floor || (bestSegment && s.area >= bestSegment.area)) continue
    if (insidePolygon(at, s.poly)) bestSegment = s
  }
  if (bestSegment) return bestSegment.name
  let best = null
  for (const f of buildingFloors) {
    if (f.floor !== point.floor || (best && f.area >= best.area)) continue
    if (insideRing(at, f.ring)) best = f
  }
  if (!best) return null
  const name = buildings[best.b]
  if (name === 'JR東京駅') return 'JR東京駅の改札外の通路'
  if (name === '地下鉄・公共通路') return '地下通路'
  return `${name}の中`
}
for (const p of points) {
  if (p.type !== 'node') continue
  const passage = passageOf(p)
  if (passage) p.passage = passage
}

// ---- 出口・入口・改札を、近くの通路の地点につなぐ ----
const ATTACH_LIMIT = 40 // これより遠い通路にしかつなげない物は使わない（m）
const walkNodes = points.filter((p) => p.type === 'node')
function nearestNode(floor, [x, z]) {
  let best = null
  for (const p of walkNodes) {
    if (p.floor !== floor) continue
    const d = Math.hypot(p.x - x, p.z - z)
    if (!best || d < best.d) best = { point: p, d }
  }
  return best && best.d <= ATTACH_LIMIT ? best : null
}

// 地下鉄の駅のおおよその中心（推定。出口や改札の名前に「〇〇駅付近」と付けるのに使う）。
// 出口の番号（A1 など）は駅ごとに付いていて、データには駅の名前が入っていないため
const STATIONS = [
  { id: 'tokyo', name: '東京駅', at: [35.6813, 139.7644] },
  { id: 'otemachi', name: '大手町駅', at: [35.6848, 139.7631] },
  { id: 'nijubashimae', name: '二重橋前駅', at: [35.6803, 139.7614] },
  { id: 'hibiya', name: '日比谷駅', at: [35.6745, 139.7597] },
  { id: 'yurakucho', name: '有楽町駅', at: [35.6753, 139.763] },
  { id: 'ginza', name: '銀座駅', at: [35.6716, 139.765] },
  { id: 'higashiginza', name: '東銀座駅', at: [35.6696, 139.7672] },
  { id: 'ginza1', name: '銀座一丁目駅', at: [35.6744, 139.7669] },
  { id: 'kyobashi', name: '京橋駅', at: [35.6766, 139.77] },
  { id: 'nihombashi', name: '日本橋駅', at: [35.682, 139.7737] },
].map((s) => ({ ...s, xz: project([s.at[1], s.at[0]]) }))
const STATION_REACH = 350 // 駅の中心からこれより遠いときは、駅の名前ではなく東京駅からの方角で表す（m）
const DIRECTIONS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西']
function stationArea(id) {
  const s = STATIONS.find((st) => st.id === id)
  return { id: s.id, label: `${s.name}付近` }
}
function areaOf([x, z], number = '', note = '') {
  // 路線名や出口番号の規則から、どの駅の出口・改札かがはっきり分かるものを先に判定する
  if (note && note.includes('京葉線')) return stationArea('tokyo')
  // 東京駅の北側（x > 200、日本橋側を除く）は大手町駅の5路線が広く伸びている範囲
  if (x > 200 && z < 350 && !/^M\d+/i.test(number)) return stationArea('otemachi')
  // 日比谷通り沿い北側の D1〜D6 出口は都営三田線の大手町駅
  if (/^D\d+/i.test(number) && x > 100) return stationArea('otemachi')
  // 皇居・丸の内西側の 1〜7 出口は東京メトロ千代田線の二重橋前駅
  if (/^[1-7][ab]?$/i.test(number) && x > -200 && x < 150 && z < -250) return stationArea('nijubashimae')
  // 数寄屋橋まわりの C1〜C9 出口は東京メトロ丸ノ内線の銀座駅
  if (/^C[1-9]$/i.test(number) && x < -500) return stationArea('ginza')
  // 日比谷通り沿い（z < -500）の A・B 出口と A0 出口は日比谷駅（有楽町駅の出口は D1〜D9、晴海通り側の B1〜B10 は銀座駅）
  if ((/^A0$/i.test(number) || (/^(A\d+|B[1-7])$/i.test(number) && z < -500)) && x < -200) return stationArea('hibiya')

  let best = null
  for (const s of STATIONS) {
    const d = Math.hypot(s.xz[0] - x, s.xz[1] - z)
    if (!best || d < best.d) best = { station: s, d }
  }
  if (best.d <= STATION_REACH) return { id: best.station.id, label: `${best.station.name}付近` }
  const angle = (Math.atan2(z, x) * 180) / Math.PI // 北から東回り
  const direction = DIRECTIONS[Math.round(((angle + 360) % 360) / 45) % 8]
  return { id: `around-${direction}`, label: `東京駅の${direction}` }
}

// 丸かっこを全角にそろえる。元データの「東京メロト」は「東京メトロ」の書き間違いなので直す
const tidy = (text) =>
  text.replace(/\s+/g, ' ').replace(/\(/g, '（').replace(/\)/g, '）').replace(/東京メロト/g, '東京メトロ').trim()
const slug = (text) => text.toLowerCase().replace(/[^0-9a-z]+/g, '')

// 同じ名前が近く（別の階を含む）に2つ以上あるときは、つなぐ通路がいちばん近い物を1つだけ使う
const SAME_PLACE = 60
function pickBest(candidates) {
  const chosen = []
  for (const c of candidates.sort((a, b) => a.attach.d - b.attach.d)) {
    if (chosen.some((o) => Math.hypot(o.at[0] - c.at[0], o.at[1] - c.at[1]) < SAME_PLACE)) continue
    chosen.push(c)
  }
  return chosen
}

function addAttachedPoint(point, attach) {
  points.push(point)
  pointById.set(point.id, point)
  edges.push([point.id, attach.point.id, round(Math.max(0.1, attach.d))])
}

const exits = [] // 検索用の行き先
const usedIds = new Set()
const uniqueId = (base) => {
  let id = base
  for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`
  usedIds.add(id)
  return id
}

// 地下鉄・地下通路の出口（Facility の F108）。番号は「A1」「4(京葉線)」のような形。閉鎖中の出口は使わない
const exitGroups = new Map()
for (const f of facilities) {
  if (f.c !== 'F108' || !f.name || /閉鎖/.test(f.name)) continue
  const attach = nearestNode(f.floor, f.at)
  if (!attach) continue
  const [, number, note] = tidy(f.name).match(/^([0-9A-Za-z]+)(?:（(.+)）)?$/) ?? [null, tidy(f.name), null]
  const area = areaOf(f.at, number, note)
  const key = `${area.id}:${number}`
  if (!exitGroups.has(key)) exitGroups.set(key, [])
  exitGroups.get(key).push({ ...f, attach, number, note, area })
}
for (const group of exitGroups.values()) {
  for (const e of pickBest(group)) {
    const id = uniqueId(`exit-${e.area.id}-${slug(e.number)}`)
    const name = `${e.number}出口（${e.area.label}${e.note ? `・${e.note}` : ''}）`
    addAttachedPoint({ id, name, type: 'exit', floor: e.floor, x: e.at[0], z: e.at[1], estimated: true }, e.attach)
    exits.push({
      id,
      name,
      description: `地下鉄・地下通路の出口（${floorName(e.floor)}）。駅の名前は位置から推定したものです`,
      kind: 'exit',
    })
  }
}

// 建物の入口（Facility の F017）。名前は「JR東京駅方面」「丸ビル連絡口」のような、入口の向きや行き先
const entranceGroups = new Map()
for (const f of facilities) {
  if (f.c !== 'F017' || !f.name) continue
  const attach = nearestNode(f.floor, f.at)
  if (!attach) continue
  const key = `${f.b}:${tidy(f.name)}`
  if (!entranceGroups.has(key)) entranceGroups.set(key, [])
  entranceGroups.get(key).push({ ...f, attach })
}
const entrancesOf = new Map() // 建物の番号 → 入口の id
for (const group of entranceGroups.values()) {
  const chosen = pickBest(group)
  for (const e of chosen) {
    const building = buildings[e.b]
    // 同じ入口が別の階にもあるときだけ、階の名前を付ける
    const where = new Set(chosen.map((c) => c.floor)).size > 1 ? `・${floorName(e.floor)}` : ''
    const name = building === 'JR東京駅' ? `JR東京駅 ${tidy(e.name)}${where ? `（${floorName(e.floor)}）` : ''}` : `${building}の入口（${tidy(e.name)}${where}）`
    const id = uniqueId(`entrance-${e.b + 1}-${entrancesOf.get(e.b)?.length ?? 0}`)
    addAttachedPoint({ id, name, type: 'exit', floor: e.floor, x: e.at[0], z: e.at[1] }, e.attach)
    exits.push({ id, name, description: `${building}の入口（${floorName(e.floor)}）`, kind: 'entrance' })
    if (!entrancesOf.has(e.b)) entrancesOf.set(e.b, [])
    entrancesOf.get(e.b).push(id)
  }
}

// 名前つきの F017 が無い周辺ビルについて、名前のない F017 または建物内の通路入口を補う
for (let b = 0; b < buildings.length; b++) {
  const building = buildings[b]
  if (building === 'JR東京駅' || building === '地下鉄・公共通路' || entrancesOf.has(b)) continue
  const unnamed = facilities
    .filter((f) => f.b === b && f.c === 'F017' && !f.name)
    .map((f) => ({ ...f, attach: nearestNode(f.floor, f.at) }))
    .filter((f) => f.attach)
  let candidates = pickBest(unnamed)
  if (!candidates.length) {
    // F017 が無いビルは、建物の床の中にある通路地点のうち外部とつながる地点を入口とする
    const inBuilding = (p) => buildingFloors.some((bf) => bf.b === b && bf.floor === p.floor && insideRing([p.x, p.z], bf.ring))
    const insideNodes = walkNodes.filter(inBuilding)
    const insideSet = new Set(insideNodes.map((p) => p.id))
    const boundaryNodes = insideNodes.filter((p) =>
      edges.some(([u, v]) => (u === p.id && !insideSet.has(v)) || (v === p.id && !insideSet.has(u))),
    )
    const pool = boundaryNodes.length ? boundaryNodes : insideNodes
    candidates = pickBest(pool.map((p) => ({ b, floor: p.floor, at: [p.x, p.z], attach: { point: p, d: 0.1 } })))
  }
  for (const e of candidates) {
    const name = `${building}の入口（${floorName(e.floor)}）`
    const id = uniqueId(`entrance-${b + 1}-${entrancesOf.get(b)?.length ?? 0}`)
    addAttachedPoint({ id, name, type: 'exit', floor: e.floor, x: e.at[0], z: e.at[1] }, e.attach)
    exits.push({ id, name, description: `${building}の入口（${floorName(e.floor)}）`, kind: 'entrance' })
    if (!entrancesOf.has(b)) entrancesOf.set(b, [])
    entrancesOf.get(b).push(id)
  }
}

// 改札（Opening の名前）。データは改札の外だけなので、改札は「出発地点」として使う。
// JR東京駅のフォルダの名前つきの開口部は JR の改札（八重洲北口など）、地下鉄・公共通路のフォルダは名前が「〜改札」の物
const gateGroups = new Map()
for (const o of openings) {
  const building = buildings[o.b]
  const isJr = building === 'JR東京駅'
  if (!isJr && !(building === '地下鉄・公共通路' && /改札$/.test(o.name))) continue
  const attach = nearestNode(o.floor, o.at)
  if (!attach) continue
  const name = tidy(o.name).replace(/^ＪＲ/, 'JR')
  const label = isJr ? `JR ${name.replace(/（東海道、山陽新幹線）/, '（新幹線）')}` : `${name}（${areaOf(o.at).label}）`
  const key = label
  if (!gateGroups.has(key)) gateGroups.set(key, [])
  gateGroups.get(key).push({ ...o, attach, label, isJr })
}
let gateCount = 0
for (const group of gateGroups.values()) {
  const chosen = pickBest(group)
  for (const g of chosen) {
    const name = chosen.length > 1 ? `${g.label}・${floorName(g.floor)}` : g.label
    const point = { id: `gate-${++gateCount}`, name, type: 'gatepass', floor: g.floor, x: g.at[0], z: g.at[1], operator: g.isJr ? 'JR' : '地下鉄' }
    addAttachedPoint(point, g.attach)
  }
}

// 同じ名前が2つ以上残ったとき（同じ階の離れた所に同じ番号の出口があるときなど）は、
// その中でどちら側にあるか（北側・南東側など）を名前に付けて区別する
const SIDES = ['北', '北東', '東', '南東', '南', '南西', '西', '北西']
function nameApart(list) {
  const byName = new Map()
  for (const item of list) {
    if (!byName.has(item.point.name)) byName.set(item.point.name, [])
    byName.get(item.point.name).push(item)
  }
  for (const [name, same] of byName) {
    if (same.length < 2) continue
    const cx = same.reduce((s, i) => s + i.point.x, 0) / same.length
    const cz = same.reduce((s, i) => s + i.point.z, 0) / same.length
    const used = new Set()
    for (const item of same) {
      const angle = (Math.atan2(item.point.z - cz, item.point.x - cx) * 180) / Math.PI
      let side = `${SIDES[Math.round(((angle + 360) % 360) / 45) % 8]}側`
      for (let n = 2; used.has(side); n++) side = `${side}${n}`
      used.add(side)
      const renamed = `${name}・${side}`
      item.point.name = renamed
      if (item.exit) item.exit.name = renamed
    }
  }
}
nameApart(exits.map((exit) => ({ exit, point: pointById.get(exit.id) })))
nameApart(points.filter((p) => p.type === 'gatepass').map((point) => ({ point })))

// ---- 検索用の建物（行き先）。入口のある建物だけ ----
// keywords は読みがなと、よく使われる呼び方（正式名称など）
const BUILDING_KEYWORDS = {
  丸ビル: ['まるびる', '丸の内ビルディング'],
  新丸ビル: ['しんまるびる', '新丸の内ビルディング'],
  TOKIA: ['ときあ', '東京ビル'],
  丸の内ブリックスクエア: ['ぶりっくすくえあ', 'ブリックスクエア'],
  イーヨ: ['いーよ', 'iiyo', '丸の内永楽ビルディング'],
  丸の内オアゾ: ['おあぞ', 'OAZO'],
  三菱商事ビル: ['みつびししょうじ'],
  KITTE: ['きって', 'JPタワー'],
  東京交通会館: ['こうつうかいかん'],
  有楽町イトシア: ['いとしあ', 'ITOCiA'],
  有楽町マリオン: ['まりおん'],
  オーテモリ: ['おーてもり', '大手町タワー'],
  東京国際フォーラム: ['こくさいふぉーらむ', '国際フォーラム'],
  鉄鋼ビルディング: ['てっこうびる', '鉄鋼ビル'],
  三菱UFJ信託銀行本店ビル: ['みつびしゆーえふじぇー', '三菱UFJ信託銀行'],
}
const places = []
for (const [b, ids] of entrancesOf) {
  const name = buildings[b]
  if (name === 'JR東京駅' || name === '地下鉄・公共通路') continue
  places.push({ name, keywords: BUILDING_KEYWORDS[name] ?? [], exitId: ids[0], exitIds: ids })
}

// ---- 確認：全部の改札から、全部の行き先へ行けるか ----
const adjacency = new Map(points.map((p) => [p.id, []]))
for (const [a, b, , oneway] of edges) {
  adjacency.get(a).push(b)
  if (!oneway) adjacency.get(b).push(a)
}
function reachableFrom(start) {
  const seen = new Set([start])
  const stack = [start]
  while (stack.length) {
    for (const next of adjacency.get(stack.pop())) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}
const gates = points.filter((p) => p.type === 'gatepass')
const problems = []
for (const gate of gates) {
  const reach = reachableFrom(gate.id)
  for (const exit of exits) if (!reach.has(exit.id)) problems.push(`${gate.name} → ${exit.name}`)
}

// ---- 1人称で歩ける場所（0.5m 四方のマス目。形式は src/walk-grid.js） ----
// 通路とスロープの面は歩ける。ルートの線から WIDE_REACH 以内も、部屋・柱・階段の穴でなければ歩ける
// （改札のまわりや、面のない屋外の歩道を歩けるように）。
// ルートの線から CORE_REACH 以内は、部屋や階段の穴の中を通っていても歩ける（ルートで通る所が行き止まりにならないように）。
// それ以外の階段・エスカレーターの穴は歩けない（階の移動はボタンで行う）
const CELL = 0.5
const WIDE_REACH = 2.5
const CORE_REACH = 0.75
const GRID_MARGIN = 4 // 床と地点を囲む範囲のまわりに足す幅（m）
// 塗り分けの種類（大きい数ほど後から塗って上書きする）
const KIND = { none: 0, floor: 1, ground: 2, walkway: 3, hole: 4, blocked: 5, fixture: 6 }
// これより小さい「歩けない島」（柱・壁を除く）は歩けるようにし、これより小さい「歩ける島」は歩けなくする（マスの数。8 マス = 2m²）。
// 細い階段の面などが 0.5m のマスでは途切れ途切れになり、小さな手すり壁がたくさん並んでギザギザに見えるため
const MIN_ISLAND = 8
const BLOCKING_SPACES = ['shop', 'toilet', 'service', 'other', 'elevator']

// 多角形の中のマス（中心が中に入るマス）に value を塗る。穴の中は塗らない
function fillPolygons(grid, polygons, value) {
  for (const polygon of polygons) {
    let minX = Infinity
    let maxX = -Infinity
    for (const [x] of polygon[0]) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
    const i0 = Math.max(0, Math.ceil((minX - grid.x0) / CELL - 0.5))
    const i1 = Math.min(grid.rows - 1, Math.floor((maxX - grid.x0) / CELL - 0.5))
    for (let i = i0; i <= i1; i++) {
      // この行（X が一定の線）が輪と交わる Z を集め、交わりの間を塗る
      const x = grid.x0 + (i + 0.5) * CELL
      const crossings = []
      for (const ring of polygon) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const [xa, za] = ring[a]
          const [xb, zb] = ring[b]
          if ((xa > x) !== (xb > x)) crossings.push(za + ((x - xa) * (zb - za)) / (xb - xa))
        }
      }
      crossings.sort((p, q) => p - q)
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const j0 = Math.max(0, Math.ceil((crossings[k] - grid.z0) / CELL - 0.5))
        const j1 = Math.min(grid.cols - 1, Math.floor((crossings[k + 1] - grid.z0) / CELL - 0.5))
        for (let j = j0; j <= j1; j++) grid.kind[i * grid.cols + j] = value
      }
    }
  }
}

// 線分 a-b から reach 以内のマスについて、callback(マスの番号) を呼ぶ
function forCellsNear(grid, a, b, reach, callback) {
  const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - grid.x0) / CELL))
  const i1 = Math.min(grid.rows - 1, Math.floor((Math.max(a.x, b.x) + reach - grid.x0) / CELL))
  const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - grid.z0) / CELL))
  const j1 = Math.min(grid.cols - 1, Math.floor((Math.max(a.z, b.z) + reach - grid.z0) / CELL))
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSq = dx * dx + dz * dz
  for (let i = i0; i <= i1; i++) {
    const x = grid.x0 + (i + 0.5) * CELL
    for (let j = j0; j <= j1; j++) {
      const z = grid.z0 + (j + 0.5) * CELL
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0
      if (Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) <= reach) callback(i * grid.cols + j)
    }
  }
}

// 小さな島を取り除く（MIN_ISLAND）。上下左右でつながるマスを1つの島とする。
// 地点（階段の端など）が乗っている歩ける島は、小さくても残す（keep は地点のあるマスの印）
function removeIslands(grid, walk, keep) {
  const { rows, cols } = grid
  const seen = new Uint8Array(walk.length)
  for (let start = 0; start < walk.length; start++) {
    if (seen[start]) continue
    const value = walk[start]
    const island = [start]
    seen[start] = 1
    let hasFixture = false
    let hasPoint = false
    for (let n = 0; n < island.length; n++) {
      const k = island[n]
      if (grid.kind[k] === KIND.fixture) hasFixture = true
      if (keep[k]) hasPoint = true
      const i = Math.floor(k / cols)
      const j = k % cols
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue
        const m = ni * cols + nj
        if (!seen[m] && walk[m] === value) {
          seen[m] = 1
          island.push(m)
        }
      }
    }
    if (island.length >= MIN_ISLAND) continue
    if (value === 0 && hasFixture) continue // 柱は小さくても本物なので残す
    if (value === 1 && hasPoint) continue
    for (const k of island) walk[k] = value ? 0 : 1
  }
}

function buildWalkGrid(floorId) {
  const shape = shapes[floorId]
  const floorPoints = points.filter((p) => p.floor === floorId)
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const [x, z] of [...shape.floor.flatMap((polygon) => polygon[0]), ...floorPoints.map((p) => [p.x, p.z])]) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  const x0 = Math.floor(minX - GRID_MARGIN)
  const z0 = Math.floor(minZ - GRID_MARGIN)
  const rows = Math.ceil((maxX + GRID_MARGIN - x0) / CELL)
  const cols = Math.ceil((maxZ + GRID_MARGIN - z0) / CELL)
  const grid = { x0, z0, rows, cols, kind: new Uint8Array(rows * cols) }

  fillPolygons(grid, shape.floor, KIND.floor)
  fillPolygons(grid, groundFloors[floorId], KIND.ground)
  for (const style of ['walkway', 'slope']) fillPolygons(grid, shape.spaces[style] ?? [], KIND.walkway)
  for (const style of ['stairs', 'escalator']) fillPolygons(grid, shape.spaces[style] ?? [], KIND.hole)
  for (const style of BLOCKING_SPACES) fillPolygons(grid, shape.spaces[style] ?? [], KIND.blocked)
  fillPolygons(grid, shape.fixture, KIND.fixture)

  const walk = new Uint8Array(rows * cols)
  for (let k = 0; k < walk.length; k++) walk[k] = grid.kind[k] === KIND.walkway ? 1 : 0
  // ルートの線のまわり。同じ階の中の階段（connector の2点を結ぶ線）は、ボタンで通るので除く
  for (const [a, b] of edges) {
    const [pa, pb] = [pointById.get(a), pointById.get(b)]
    if (pa.floor !== floorId || pb.floor !== floorId) continue
    if (pa.connector && pa.connector === pb.connector) continue
    forCellsNear(grid, pa, pb, WIDE_REACH, (k) => {
      if (grid.kind[k] <= KIND.walkway) walk[k] = 1
    })
    forCellsNear(grid, pa, pb, CORE_REACH, (k) => {
      walk[k] = 1
    })
  }

  const pointCells = new Uint8Array(rows * cols)
  for (const p of floorPoints) pointCells[Math.floor((p.x - x0) / CELL) * cols + Math.floor((p.z - z0) / CELL)] = 1
  removeIslands(grid, walk, pointCells)

  // 屋外は、地上の階の「床の形の外」と「地上（ordinal 0）の床」。地下の階に屋外はない
  const aboveGround = FLOORS.find((f) => f.id === floorId).level === 0
  const cells = new Uint8Array(rows * cols)
  for (let k = 0; k < cells.length; k++) {
    const kind = grid.kind[k]
    cells[k] = (walk[k] ? WALK : 0) |
      (kind === KIND.hole && !walk[k] ? LOW : 0) |
      (kind === KIND.fixture && !walk[k] ? FIXTURE : 0) |
      (aboveGround && (kind === KIND.none || kind === KIND.ground) ? OUTDOOR : 0)
  }
  // 柱・壁の印は、歩ける所に面している物だけに残す（部屋の中の柱のまわりに、見えない壁を作らないように）
  const seen = new Uint8Array(cells.length)
  for (let start = 0; start < cells.length; start++) {
    if (!(cells[start] & FIXTURE) || seen[start]) continue
    const group = [start]
    seen[start] = 1
    let facesWalk = false
    for (let n = 0; n < group.length; n++) {
      const k = group[n]
      const i = Math.floor(k / cols)
      const j = k % cols
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue
        const m = ni * cols + nj
        if (cells[m] & WALK) facesWalk = true
        if (cells[m] & FIXTURE && !seen[m]) {
          seen[m] = 1
          group.push(m)
        }
      }
    }
    if (!facesWalk) for (const k of group) cells[k] &= ~FIXTURE
  }
  return { x0, z0, rows, cols, cells }
}

const walkGrids = Object.fromEntries(FLOORS.map((f) => [f.id, buildWalkGrid(f.id)]))

// 確認：通路の地点が歩けるマスの上にあり、同じ階の通路でつながる地点どうしが、マス目の上でもつながっているか
// （つながっていない所があると、1人称ではルートどおりに歩けない）
const walkProblems = []
for (const [floorId, grid] of Object.entries(walkGrids)) {
  const cellOf = (p) => Math.floor((p.x - grid.x0) / CELL) * grid.cols + Math.floor((p.z - grid.z0) / CELL)
  // ひと続きの歩ける範囲ごとに番号を付ける（上下左右でつながるマス）
  const group = new Int32Array(grid.cells.length).fill(-1)
  let groups = 0
  for (let start = 0; start < grid.cells.length; start++) {
    if (!(grid.cells[start] & WALK) || group[start] >= 0) continue
    const stack = [start]
    group[start] = groups
    while (stack.length) {
      const k = stack.pop()
      const i = Math.floor(k / grid.cols)
      const j = k % grid.cols
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= grid.rows || nj >= grid.cols) continue
        const n = ni * grid.cols + nj
        if (grid.cells[n] & WALK && group[n] < 0) {
          group[n] = groups
          stack.push(n)
        }
      }
    }
    groups++
  }
  for (const p of points) {
    if (p.floor === floorId && !(grid.cells[cellOf(p)] & WALK)) walkProblems.push(`${floorId} ${p.id}（${p.name}）が歩けないマスの上`)
  }
  for (const [a, b] of edges) {
    const [pa, pb] = [pointById.get(a), pointById.get(b)]
    if (pa.floor !== floorId || pb.floor !== floorId || (pa.connector && pa.connector === pb.connector)) continue
    const [ga, gb] = [group[cellOf(pa)], group[cellOf(pb)]]
    if (ga !== gb) walkProblems.push(`${floorId} ${a} と ${b} がマス目の上でつながっていない`)
  }
}

// ---- 書き出し ----
const defaultOrigin = gates.find((g) => g.name.startsWith('JR 丸の内地下中央口')) ?? gates[0]
const defaultExit = exits.find((e) => e.name.startsWith('KITTEの入口（JR東京駅')) ?? exits[0]
const sources = [
  '国土交通省「東京駅周辺屋内地図オープンデータ」（G空間情報センター）を加工して作成 https://www.geospatial.jp/ckan/dataset/mlit-indoor-tokyo-r2',
  '部屋・設備の種類のコード：国土地理院「階層別屋内地理空間情報データ仕様書（案）」',
]
const map = {
  _note: '国土交通省の東京駅周辺屋内地図オープンデータから自動生成したデータです（tools/build-tokyo-3d.mjs）。データは改札の外だけです。出口の「〇〇駅付近」は位置から推定した駅の名前です（"estimated": true）。座標の単位はメートル（X: 北、Z: 東）。',
  _sources: sources,
  floorGap: 30,
  floors: FLOORS,
  points,
  graph: { edges },
  arrivals: [],
  destinations: exits.map((e) => e.id),
  defaultRoute: { origin: `gate:${defaultOrigin.id}`, destination: defaultExit.id },
  shapes,
  walkGrid: {
    cell: CELL,
    floors: Object.fromEntries(Object.entries(walkGrids).map(([id, { x0, z0, rows, cols, cells }]) =>
      [id, { x0, z0, rows, cols, runs: encodeCells(cells) }])),
  },
}
const station = {
  _note: '行き先の検索用データ（tools/build-tokyo-3d.mjs が作る）。出口の id は 3Dマップ（tokyo-3d.json）の出口と同じ。',
  _sources: sources,
  station: '東京駅',
  exits: exits.map(({ id, name, description, kind }) => ({ id, name, description, kind })),
  places,
}

writeFileSync(outputMap, JSON.stringify(map))
writeFileSync(outputStation, JSON.stringify(station, null, 1) + '\n')

const count = (type) => points.filter((p) => p.type === type).length
console.log(`地点 ${points.length}（通路 ${count('node')}、出口・入口 ${count('exit')}、改札 ${count('gatepass')}、階段など ${connectorCount * 2}）、つながり ${edges.length}`)
console.log(`ほかとつながっていない小さなネットワーク ${pruned.groups - 1} 個（地点 ${pruned.removed}）を除外`)
console.log(`行き先：出口・入口 ${exits.length}、建物 ${places.length}`)
console.log(`書き出し：${outputMap}（${(JSON.stringify(map).length / 1024 / 1024).toFixed(1)}MB）`)
const walkCells = Object.entries(walkGrids).map(([id, g]) => `${id} ${Math.round(g.cells.filter((c) => c & WALK).length * CELL * CELL / 1000)}千m²`)
console.log(`1人称で歩ける広さ：${walkCells.join('、')}（マス目 ${(JSON.stringify(map.walkGrid).length / 1024).toFixed(0)}KB）`)
if (walkProblems.length) {
  console.error(`1人称で歩けるマス目の問題が ${walkProblems.length} 件あります（例：${walkProblems.slice(0, 5).join(' / ')}）`)
  process.exit(1)
}
if (problems.length) {
  console.error(`ルートが見つからない組み合わせが ${problems.length} 件あります（例：${problems.slice(0, 5).join(' / ')}）`)
  process.exit(1)
}
console.log(`確認：改札 ${gates.length} × 行き先 ${exits.length} のすべてでルートが見つかります`)
