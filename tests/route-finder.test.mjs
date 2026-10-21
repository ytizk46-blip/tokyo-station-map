// ルート探索と道順の文章のテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byId, data, originNamed, origins, pointNamed, sampleDestinations } from './helpers.mjs'
import { describeRoute, findRoute, reachableFrom } from '../src/route-finder.js'

const pairs = origins.flatMap((origin) => sampleDestinations.map((destination) => ({ origin, destination })))

test('出発地点は改札だけで、JR と地下鉄に分かれて並ぶ（データは改札の外だけ）', () => {
  assert.equal(data.arrivals.length, 0)
  assert.equal(origins.length, data.points.filter((p) => p.type === 'gatepass').length)
  assert.ok(origins.some((o) => o.group === '今いる改札（JR）'))
  assert.ok(origins.some((o) => o.group === '今いる改札（地下鉄）'))
  assert.equal(new Set(origins.map((o) => o.id)).size, origins.length, 'id は重ならない')
  assert.equal(new Set(origins.map((o) => o.name)).size, origins.length, '名前も重ならない')
})

test('いつもの出発地点と行き先がデータにある', () => {
  assert.ok(origins.some((o) => o.id === data.defaultRoute.origin))
  assert.ok(data.destinations.includes(data.defaultRoute.destination))
})

test('改札と行き先の組み合わせでルートが見つかり、隣り合う地点はデータ上つながっている', () => {
  const linked = new Set(data.graph.edges.flatMap(([a, b, , oneway]) => (oneway ? [`${a}>${b}`] : [`${a}>${b}`, `${b}>${a}`])))
  for (const { origin, destination } of pairs) {
    const path = findRoute(data, origin.point, destination)
    assert.ok(path, `${origin.name} → ${destination}`)
    assert.equal(path[0], origin.point)
    assert.equal(path[path.length - 1], destination)
    for (let i = 1; i < path.length; i++) assert.ok(linked.has(`${path[i - 1]}>${path[i]}`), `${path[i - 1]} → ${path[i]}`)
  }
})

test('道順は「改札を出る」で始まり「到着」で終わり、ルートの順番に並ぶ', () => {
  for (const { origin, destination } of pairs) {
    const route = describeRoute(data, findRoute(data, origin.point, destination), origin)
    const first = route.steps[0]
    const last = route.steps[route.steps.length - 1]
    assert.match(first.text, /を出る$/)
    assert.equal(first.point, origin.point)
    assert.match(last.text, /に到着$/)
    assert.equal(last.point, destination)

    const indexes = route.steps.map((step) => route.path.indexOf(step.point))
    assert.ok(indexes.every((i) => i >= 0), '道順の地点はすべてルート上にある')
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), '道順はルートの順番に並ぶ')
    assert.ok(route.minutes >= 1 && route.distance > 0)
  }
})

test('同じ階のままなら上り下りの案内は出ない', () => {
  for (const { origin, destination } of pairs) {
    const route = describeRoute(data, findRoute(data, origin.point, destination), origin)
    for (const step of route.steps) {
      if (!/(上がる|下りる)$/.test(step.text)) continue
      const i = route.path.indexOf(step.point)
      assert.notEqual(byId[route.path[i]].floor, byId[route.path[i + 1]].floor, step.text)
    }
  }
})

test('分かれ道が多くても、細かい案内が続きすぎない', () => {
  for (const { origin, destination } of pairs) {
    const route = describeRoute(data, findRoute(data, origin.point, destination), origin)
    // 25m に1件より多くは案内しない（出発と到着の分などは別に数える）
    assert.ok(route.steps.length <= 6 + route.distance / 25, `${route.name}: ${route.steps.length}件 / ${route.distance}m`)
  }
})

test('同じ案内が近くで続かない（「階段を通る」が続くときなどは1つにまとめる）', () => {
  for (const { origin, destination } of pairs) {
    const route = describeRoute(data, findRoute(data, origin.point, destination), origin)
    for (let i = 2; i < route.steps.length; i++) {
      const [a, b] = [route.steps[i - 1], route.steps[i]]
      if (a.text !== b.text) continue
      const [pa, pb] = [byId[a.point], byId[b.point]]
      assert.ok(Math.hypot(pa.x - pb.x, pa.z - pb.z) >= 10, `${route.name}: ${a.text} が続く`)
    }
  }
})

test('歩いて行ける地点の一覧は、ルートが見つかるかどうかと食い違わない', () => {
  for (const avoidStairs of [false, true]) {
    for (const origin of origins.slice(0, 8)) {
      const reached = reachableFrom(data, origin.point, { avoidStairs })
      for (const destination of sampleDestinations) {
        assert.equal(reached.has(destination), Boolean(findRoute(data, origin.point, destination, { avoidStairs })), `${origin.name} → ${destination}`)
      }
    }
  }
})

test('JR丸の内地下中央口からKITTEへは、グランスタ丸の内を通って数分で着く', () => {
  const origin = originNamed('JR 丸の内地下中央口')
  const goal = pointNamed('KITTEの入口（JR東京駅）')
  const route = describeRoute(data, findRoute(data, origin.point, goal.id), origin)
  assert.ok(route.distance > 100 && route.distance < 600, `${route.distance}m`)
  assert.ok(route.minutes <= 8)
  assert.ok(route.steps.some((s) => s.text.includes('グランスタ丸の内')), route.steps.map((s) => s.text).join(' / '))
})

test('見つからないときは null を返す', () => {
  assert.equal(findRoute(data, data.defaultRoute.destination, 'no-such-point'), null)
})
