// 屋内地図オープンデータから作った東京駅のデータのテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import station from '../src/data/tokyo.json' with { type: 'json' }
import { byId, data, originNamed, pointNamed } from './helpers.mjs'
import { createFreeWalkArea } from '../src/free-walk.js'
import { describeRoute, findRoute } from '../src/route-finder.js'

// connector 番号ごとの両端
function connectors() {
  const ends = new Map()
  for (const p of data.points.filter((p) => p.connector)) {
    if (!ends.has(p.connector)) ends.set(p.connector, [])
    ends.get(p.connector).push(p)
  }
  return [...ends.values()]
}

test('階は「1階・地上」「地下1階」「地下2階」の3つで、どの階にも床と部屋の形がある', () => {
  assert.deepEqual(data.floors.map((f) => f.id), ['1F', 'B1', 'B2'])
  for (const floor of data.floors) {
    const shape = data.shapes[floor.id]
    assert.ok(shape.floor.length > 0, floor.id)
    assert.ok(Object.keys(shape.spaces).length > 0, floor.id)
    assert.ok(data.points.some((p) => p.floor === floor.id && p.type === 'node'), floor.id)
  }
})

test('すべての地点はデータにある階にあり、つながりの両端はどれも地点にある', () => {
  const floors = new Set(data.floors.map((f) => f.id))
  for (const p of data.points) assert.ok(floors.has(p.floor), p.id)
  for (const [a, b] of data.graph.edges) assert.ok(byId[a] && byId[b], `${a} - ${b}`)
})

test('階段・エスカレーター・エレベーターは、connector 番号が同じ2点でつながる', () => {
  const list = connectors()
  assert.ok(list.length > 100)
  for (const ends of list) {
    assert.equal(ends.length, 2)
    assert.equal(ends[0].type, ends[1].type)
  }
  const types = new Set(list.filter(([a, b]) => a.floor !== b.floor).map(([a]) => a.type))
  for (const type of ['stairs', 'escalator', 'elevator']) assert.ok(types.has(type), type)
})

test('一方通行のエスカレーターでは、自由に歩くときも通れる向きにしか移動ボタンが出ない', () => {
  const oneway = data.graph.edges.filter(([a, b, , o]) => o && byId[a].connector && byId[a].connector === byId[b].connector)
  assert.ok(oneway.length > 0)
  const area = createFreeWalkArea(data)
  for (const [from, to] of oneway) {
    const atEnd = area.nearbyConnector(area.startAt(to))
    assert.ok(!atEnd || atEnd.to.id !== from, `${to} から ${from} へは戻れない`)
  }
})

test('出口・入口の名前は重ならず、出口の駅名は推定である印が付く', () => {
  const names = station.exits.map((e) => e.name)
  assert.equal(new Set(names).size, names.length)
  for (const exit of station.exits) {
    const point = byId[exit.id]
    assert.equal(point.type, 'exit')
    assert.equal(point.name, exit.name)
    if (exit.kind === 'exit') assert.equal(point.estimated, true)
  }
  assert.ok(!names.some((n) => n.includes('閉鎖')), '閉鎖中の出口は入れない')
  assert.ok(!names.some((n) => n.includes('メロト')), '元データの書き間違いは直す')
})

test('「階段なし」では階段を通らず、エレベーターを使うルートも探せる', () => {
  const origin = originNamed('JR 丸の内地下中央口')
  let usedElevator = false
  for (const destination of data.destinations.slice(0, 40)) {
    const path = findRoute(data, origin.point, destination, { avoidStairs: true })
    if (!path) continue
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [byId[path[i - 1]], byId[path[i]]]
      assert.ok(!(a.type === 'stairs' && a.connector === b.connector), `${origin.name} → ${destination}`)
    }
    const texts = describeRoute(data, path, origin).steps.map((s) => s.text)
    if (texts.some((t) => /^エレベーターで/.test(t))) usedElevator = true
  }
  assert.ok(usedElevator)
})

test('ふだんのルートでは、階段やエスカレーターで行ける所でエレベーターを選ばない', () => {
  const origin = originNamed('JR 丸の内地下中央口')
  const goal = pointNamed('KITTEの入口（JR東京駅）')
  const path = findRoute(data, origin.point, goal.id)
  assert.ok(path.every((id) => byId[id].type !== 'elevator'))
})

test('エレベーターの乗り場では、別の階へ移動するボタンが出る', () => {
  const area = createFreeWalkArea(data)
  const elevator = connectors().find(([a, b]) => a.type === 'elevator' && a.floor !== b.floor)
  const connector = area.nearbyConnector(area.startAt(elevator[0].id))
  assert.ok(connector)
  assert.match(connector.label, /^[↑↓] エレベーターで.+へ$/)
})

test('地下鉄の出口と改札はすべて適切な駅名（〇〇駅付近）が付き、方角だけの仮名にならない', () => {
  const exitNames = station.exits.filter((e) => e.kind === 'exit').map((e) => e.name)
  assert.ok(exitNames.every((n) => !n.includes('東京駅の')), '東京駅の北・北東などの仮名が残らない')
  for (const expected of [
    '4出口（東京駅付近・京葉線）',
    '7出口（二重橋前駅付近）',
    'D1出口（大手町駅付近）',
    'D2出口（大手町駅付近）',
    'B6出口（大手町駅付近）',
    'C2b出口（大手町駅付近）',
    'C1出口（銀座駅付近）',
    'C9出口（銀座駅付近）',
    'B3出口（銀座駅付近）',
    'B4出口（銀座駅付近）',
    'B5出口（銀座駅付近）',
    'B6出口（銀座駅付近）',
    'B7出口（銀座駅付近）',
    'A0出口（日比谷駅付近）',
    'B3出口（日比谷駅付近）',
    'B4出口（日比谷駅付近）',
    'B5出口（日比谷駅付近）',
    'B6出口（日比谷駅付近）',
    'B7出口（日比谷駅付近）',
  ]) {
    assert.ok(exitNames.includes(expected), `出口がある: ${expected}`)
  }
  const gateNames = data.points.filter((p) => p.type === 'gatepass').map((p) => p.name)
  assert.ok(gateNames.every((n) => !n.includes('東京駅の')), '改札にも方角だけの仮名が残らない')
  assert.ok(gateNames.some((n) => n.startsWith('東改札（大手町駅付近）')))
})

