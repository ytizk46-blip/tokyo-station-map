// 自由に歩くときの位置の計算と、階段を使わないルートのテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byId, data, origins, pointNamed, sampleDestinations } from './helpers.mjs'
import { createFreeWalkArea } from '../src/free-walk.js'
import { findRoute } from '../src/route-finder.js'
import { cellAt, decodeWalkGrid, encodeCells, WALK } from '../src/walk-grid.js'

const area = createFreeWalkArea(data)
const startPoint = pointNamed('JR 丸の内地下中央口') // 改札を出たところ

test('通路の上は歩けて、通路から遠く離れた所へは出られない', () => {
  const start = area.startAt(startPoint.id)
  assert.ok(area.isWalkable(start.x, start.z, start.floor))
  assert.ok(!area.isWalkable(start.x + 500, start.z + 500, start.floor))
  const moved = area.move(start, 500, 500)
  assert.ok(area.isWalkable(moved.x, moved.z, moved.floor))
})

test('マス目は書き出したとおりに読み戻せる', () => {
  const cells = new Uint8Array([0, 0, 1, 1, 1, 5, ...new Array(300).fill(1), 0])
  const grid = decodeWalkGrid({ cell: 0.5, floors: { X: { x0: 0, z0: 0, rows: 1, cols: cells.length, runs: encodeCells(cells) } } }).get('X')
  assert.deepEqual([...grid.cells], [...cells])
})

test('すべての地点は、1人称で歩けるマスの上にある', () => {
  const grids = decodeWalkGrid(data.walkGrid)
  const outside = data.points.filter((p) => !(cellAt(grids.get(p.floor), p.x, p.z) & WALK))
  assert.deepEqual(outside.map((p) => p.id), [])
})

test('お店の中には入れない（ルートの線が通る所を除く）', () => {
  const grids = decodeWalkGrid(data.walkGrid)
  let inside = 0
  let walkable = 0
  for (const floor of data.floors) {
    for (const [ring] of data.shapes[floor.id].spaces.shop ?? []) {
      // 輪の点の平均（小さな四角い店なら中にある）
      const x = ring.reduce((s, [px]) => s + px, 0) / ring.length
      const z = ring.reduce((s, [, pz]) => s + pz, 0) / ring.length
      inside++
      if (cellAt(grids.get(floor.id), x, z) & WALK) walkable++
    }
  }
  assert.ok(walkable / inside < 0.1, `${walkable} / ${inside}`)
})

test('まっすぐ歩き続けると、壁で止まる', () => {
  const start = area.startAt(startPoint.id)
  const along = area.directionAt(start)
  let position = start
  for (let i = 0; i < 5000; i++) position = area.move(position, along.x * 0.1, along.z * 0.1)
  // 500m 進もうとしても、どこかの壁で止まる（壁がなければ 500m 先まで行ってしまう）
  assert.ok(Math.hypot(position.x - start.x, position.z - start.z) < 450)
  assert.ok(area.isWalkable(position.x, position.z, position.floor))
})

test('歩けない所にいるときは、近くの歩ける所へずらす', () => {
  const start = area.startAt(startPoint.id)
  // 通路と直角の向きに進んで、最初に歩けなくなる所（壁の中）
  const along = area.directionAt(start)
  let wall = null
  for (let d = 0.5; d < 10 && !wall; d += 0.5) {
    const x = start.x - along.z * d
    const z = start.z + along.x * d
    if (!area.isWalkable(x, z, start.floor)) wall = { x, z, floor: start.floor }
  }
  assert.ok(wall, '近くに壁がない')
  const settled = area.settle(wall)
  assert.ok(area.isWalkable(settled.x, settled.z, settled.floor))
  assert.ok(Math.hypot(settled.x - wall.x, settled.z - wall.z) < 3)
})

test('通路がのびる向きに押し続けると、止まらずに進める', () => {
  let position = area.startAt(startPoint.id)
  const along = area.directionAt(position)
  for (let i = 0; i < 20; i++) position = area.move(position, along.x, along.z)
  assert.ok(Math.hypot(position.x - startPoint.x, position.z - startPoint.z) > 10)
})

test('歩き始める向きは、長さ1の向き', () => {
  const along = area.directionAt(area.startAt(startPoint.id))
  assert.ok(Math.abs(Math.hypot(along.x, along.z) - 1) < 1e-9)
})

test('階段・エスカレーターの端では、つながる階へ移動できる', () => {
  const end = data.points.find((p) => {
    if (p.type !== 'stairs' && p.type !== 'escalator') return false
    const other = data.points.find((q) => q.connector === p.connector && q.id !== p.id)
    return other.floor !== p.floor && area.nearbyConnector(area.startAt(p.id))?.to.id === other.id
  })
  const connector = area.nearbyConnector(area.startAt(end.id))
  assert.equal(connector.to.connector, end.connector)
  assert.notEqual(connector.to.floor, end.floor)
  assert.match(connector.label, /^[↑↓] (階段|エスカレーター)で.+へ$/)
})

test('階段・エスカレーターから離れた所では、階の移動ボタンは出ない', () => {
  const far = { ...area.startAt(startPoint.id) }
  far.x += 1
  const connector = area.nearbyConnector(far)
  if (connector) assert.ok(Math.hypot(connector.from.x - far.x, connector.from.z - far.z) <= 4)
})

test('「階段なし」のルートは階段を通らない', () => {
  for (const origin of origins.filter((_, i) => i % 4 === 0)) {
    for (const destination of sampleDestinations) {
      const path = findRoute(data, origin.point, destination, { avoidStairs: true })
      if (!path) continue
      for (let i = 1; i < path.length; i++) {
        const [a, b] = [byId[path[i - 1]], byId[path[i]]]
        assert.ok(!(a.type === 'stairs' && a.connector === b.connector), `${origin.name} → ${destination}`)
      }
    }
  }
})

test('「階段なし」でも、いつもの行き先へは多くの改札から行ける', () => {
  const found = origins.filter((o) => findRoute(data, o.point, data.defaultRoute.destination, { avoidStairs: true }))
  assert.ok(found.length > origins.length / 2, `${found.length} / ${origins.length}`)
})
