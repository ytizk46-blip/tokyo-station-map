// 一人称で駅の中を自由に歩くときの、位置の計算（画面や Three.js には依存しない）。
// 壁の当たり判定は、歩ける場所のマス目（data.walkGrid、src/walk-grid.js）で行う。
// 階の移動は、階段・エスカレーター・エレベーターの端に近づいたときに出るボタンで行う

import { CONNECTOR_NAMES } from './route-finder.js'
import { cellAt, decodeWalkGrid, nearestWalkable, WALK } from './walk-grid.js'

const BODY_RADIUS = 0.25 // 体の半径（m）。壁にこれより近づけない
const MAX_STEP = 0.2 // 1回に調べる移動の長さ（m）。大きく動くときは分けて調べ、壁をすり抜けないようにする
const CONNECTOR_REACH = 4 // 階段・エスカレーター・エレベーターの端からこの距離（m）以内で、階を移動できる

// 点 (x, z) から線分 a-b までの距離
function distanceToSegment(x, z, a, b) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSq = dx * dx + dz * dz
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0
  return Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz))
}

export function createFreeWalkArea(data) {
  const byId = Object.fromEntries(data.points.map((p) => [p.id, p]))
  const floorById = Object.fromEntries(data.floors.map((f) => [f.id, f]))

  const grids = decodeWalkGrid(data.walkGrid)

  // 階ごとの、歩ける線分（同じ階の地点どうしのつながり）。歩き始める向きを決めるのに使う
  const segments = new Map()
  for (const [a, b] of data.graph.edges) {
    const [pa, pb] = [byId[a], byId[b]]
    if (pa.floor !== pb.floor) continue
    if (!segments.has(pa.floor)) segments.set(pa.floor, [])
    segments.get(pa.floor).push([pa, pb])
  }

  // 階段・エスカレーターの端（どの端から、どの階のどの端へ行けるか）。
  // 上りだけのエスカレーターのような一方通行は、通れる向きだけにする
  const canGo = new Set()
  for (const [a, b, , oneway] of data.graph.edges) {
    canGo.add(`${a}>${b}`)
    if (!oneway) canGo.add(`${b}>${a}`)
  }
  const byConnector = new Map()
  for (const point of data.points) {
    if (!point.connector) continue
    if (!byConnector.has(point.connector)) byConnector.set(point.connector, [])
    byConnector.get(point.connector).push(point)
  }
  const connectorEnds = []
  for (const [a, b] of byConnector.values()) {
    if (!b) continue
    if (canGo.has(`${a.id}>${b.id}`)) connectorEnds.push({ from: a, to: b })
    if (canGo.has(`${b.id}>${a.id}`)) connectorEnds.push({ from: b, to: a })
  }

  // 体の真ん中と、前後左右の端が、どれも歩けるマスの上にあれば歩ける
  function isWalkable(x, z, floor) {
    const grid = grids.get(floor)
    if (!grid) return false
    return [[0, 0], [BODY_RADIUS, 0], [-BODY_RADIUS, 0], [0, BODY_RADIUS], [0, -BODY_RADIUS]]
      .every(([ox, oz]) => cellAt(grid, x + ox, z + oz) & WALK)
  }

  // 少しだけ動かす（MAX_STEP 以下）。斜めにぶつかったときは、壁に沿う向きだけ動く（壁に沿って滑る）
  function smallMove(position, dx, dz) {
    const { x, z, floor } = position
    for (const [mx, mz] of [[dx, dz], [dx, 0], [0, dz]]) {
      if ((mx || mz) && isWalkable(x + mx, z + mz, floor)) return { x: x + mx, z: z + mz, floor }
    }
    return position
  }

  // 歩けない所にいるとき（階段の端に着いたときなど）は、いちばん近い歩ける所へずらす
  function settle(position) {
    const { x, z, floor } = position
    if (isWalkable(x, z, floor)) return position
    const grid = grids.get(floor)
    const near = grid && nearestWalkable(grid, x, z, 10, (cx, cz) => isWalkable(cx, cz, floor))
    return near ? { ...position, x: near.x, z: near.z } : position
  }

  return {
    /** 階の ID → 歩ける場所のマス目（1人称の見た目 interior.js でも使う） */
    grids,

    isWalkable,

    settle,

    /**
     * position から (dx, dz) だけ動いた位置を返す。歩ける範囲の外へは出ない。
     * 斜めにぶつかったときは、壁に沿う向きだけ動く（壁に沿って滑る）
     */
    move(position, dx, dz) {
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / MAX_STEP))
      let current = { ...position }
      for (let i = 0; i < steps; i++) current = smallMove(current, dx / steps, dz / steps)
      return current
    },

    /** 近くにある階段・エスカレーターの端（いちばん近い物）。なければ null */
    nearbyConnector(position) {
      let best = null
      for (const end of connectorEnds) {
        if (end.from.floor !== position.floor) continue
        const d = Math.hypot(end.from.x - position.x, end.from.z - position.z)
        if (d <= CONNECTOR_REACH && (!best || d < best.distance)) best = { ...end, distance: d }
      }
      if (!best) return null
      const up = floorById[best.to.floor].level > floorById[best.from.floor].level
      const kind = CONNECTOR_NAMES[best.from.type] ?? '階段'
      // 同じ階の中の数段の階段は「階段を通る」
      const label = best.to.floor === best.from.floor
        ? `${kind}を通る`
        : `${up ? '↑' : '↓'} ${kind}で${floorById[best.to.floor].name}へ`
      return { from: best.from, to: best.to, up, label }
    },

    /**
     * いちばん近い通路（線分）がのびる向き（{ x, z } の単位ベクトル）。
     * 歩き始めるときに、通路に沿う方向を向くために使う
     */
    directionAt(position) {
      let best = null
      for (const [a, b] of segments.get(position.floor) ?? []) {
        const d = distanceToSegment(position.x, position.z, a, b)
        const length = Math.hypot(b.x - a.x, b.z - a.z)
        if (length <= 0 || (best && d >= best.d)) continue
        // 線分の両端のうち、今いる場所から遠いほうの端へ向ける（行き止まりや改札の壁を向かないように）
        const da = Math.hypot(a.x - position.x, a.z - position.z)
        const db = Math.hypot(b.x - position.x, b.z - position.z)
        const sign = db >= da ? 1 : -1
        best = { d, x: ((b.x - a.x) / length) * sign, z: ((b.z - a.z) / length) * sign }
      }
      if (!best) return { x: 1, z: 0 }
      if (!isWalkable(position.x + best.x, position.z + best.z, position.floor) &&
          isWalkable(position.x - best.x, position.z - best.z, position.floor)) {
        return { x: -best.x, z: -best.z }
      }
      return { x: best.x, z: best.z }
    },

    /** 地点 pointId から歩き始める位置（地点が壁ぎわにあるときは、少し離れた歩ける所） */
    startAt(pointId) {
      const point = byId[pointId]
      return settle({ x: point.x, z: point.z, floor: point.floor })
    },
  }
}
