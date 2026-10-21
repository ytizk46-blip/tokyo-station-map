// 駅の中を歩けるつながり（data.graph）から最短ルートを探し、道順の文章を作る

const WALK_SPEED = 1.3 // 実際に歩く速さ（m/秒）。所要時間の目安に使う
const TURN_ANGLE = 40 // これより大きく向きが変わったら「右/左に曲がる」と案内する（度）
// 東京駅のデータは分かれ道がとても多いので、細かい案内が続かないようにする
const TURN_GAP = 12 // 前の案内からこれより近い所では「曲がる」と案内しない（m）
const PASSAGE_STAY = 20 // 新しい通路にこれより短い間しかいないときは「〇〇を進む」と案内しない（m）
const LOOK = 6 // 曲がる向きは、その地点の前後これだけの道のりで見る（m）。短い線のガタつきで「曲がる」と出さないため
const STRAIGHTER = 30 // ほかの道がこれ以上まっすぐでなければ、曲がっていても「道なり」とみなす（度）
const REPEAT_GAP = 30 // 同じ案内（「階段を通る」など）がこれより近くで続くときは1つにまとめる（m）
const TURN_PAIR = 20 // 曲がってからこれより近くでまた曲がるときは「左に曲がり、すぐ右に曲がる」と1つにまとめる（m）

// 地点ごとの、つながっている地点の一覧（分かれ道かどうか、ほかの道の向きの判断に使う）
const neighborCache = new WeakMap()
function neighborsOf(data) {
  if (neighborCache.has(data)) return neighborCache.get(data)
  const neighbors = new Map()
  const add = (a, b) => {
    if (!neighbors.has(a)) neighbors.set(a, [])
    neighbors.get(a).push(b)
  }
  for (const [a, b] of data.graph.edges) {
    add(a, b)
    add(b, a)
  }
  neighborCache.set(data, neighbors)
  return neighbors
}

// 階をまたぐ物の名前
export const CONNECTOR_NAMES = { stairs: '階段', escalator: 'エスカレーター', elevator: 'エレベーター', slope: 'スロープ' }

// 階段の端から、同じ階段のもう一方の端へのつながりか
function isStairs(byId, a, b) {
  return byId[a].type === 'stairs' && byId[a].connector === byId[b].connector
}

// 歩けるつながりを、地点ごとの「隣の地点とコスト」の一覧にする。
// edges の4番目が 1 のつながりは一方通行（上りだけのエスカレーターなど）。
// 地点が数千あるので、作った一覧は覚えておいて使い回す
const adjacencyCache = new WeakMap()
function adjacencyOf(data, avoidStairs) {
  if (!adjacencyCache.has(data)) adjacencyCache.set(data, {})
  const cache = adjacencyCache.get(data)
  const key = avoidStairs ? 'avoidStairs' : 'all'
  cache[key] ??= buildAdjacency(data, avoidStairs)
  return cache[key]
}

function buildAdjacency(data, avoidStairs) {
  const byId = Object.fromEntries(data.points.map((p) => [p.id, p]))
  const adjacency = new Map()
  const add = (from, to, cost) => {
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from).push({ to, cost })
  }
  for (const [a, b, cost, oneway] of data.graph.edges) {
    if (avoidStairs && isStairs(byId, a, b)) continue
    add(a, b, cost)
    if (!oneway) add(b, a, cost)
  }
  return adjacency
}

/**
 * ダイクストラ法で、start から goal までコストが最小のルートを探す。
 * 見つからなければ null を返す。
 * @param avoidStairs true なら階段を使わない（エスカレーターとエレベーターだけで階を移動する）
 */
export function findRoute(data, start, goal, { avoidStairs = false } = {}) {
  const adjacency = adjacencyOf(data, avoidStairs)
  const cost = new Map([[start, 0]])
  const previous = new Map()
  const done = new Set()
  // まだ確定していない地点を、コストの小さい順に取り出せるようにしておく（地点が数千あるため）
  const queue = new MinHeap()
  queue.push(0, start)

  while (true) {
    const item = queue.pop()
    if (!item) return null
    const current = item.value
    if (done.has(current)) continue // もっと小さいコストで先に確定した地点
    if (current === goal) break
    done.add(current)

    for (const { to, cost: edgeCost } of adjacency.get(current) ?? []) {
      const next = cost.get(current) + edgeCost
      if (!cost.has(to) || next < cost.get(to)) {
        cost.set(to, next)
        previous.set(to, current)
        queue.push(next, to)
      }
    }
  }

  const path = [goal]
  while (path[0] !== start) path.unshift(previous.get(path[0]))
  return path
}

/**
 * start から歩いて行ける地点をすべて返す（Set）。
 * 「階段なし」でルートが見つからないとき、代わりに行ける出口を探すのに使う
 */
export function reachableFrom(data, start, { avoidStairs = false } = {}) {
  const adjacency = adjacencyOf(data, avoidStairs)
  const reached = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    for (const { to } of adjacency.get(queue.pop()) ?? []) {
      if (reached.has(to)) continue
      reached.add(to)
      queue.push(to)
    }
  }
  return reached
}

// コストの小さい物から取り出せる入れ物（二分ヒープ）
class MinHeap {
  constructor() {
    this.items = []
  }

  push(key, value) {
    const items = this.items
    items.push({ key, value })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].key <= items[i].key) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }

  pop() {
    const items = this.items
    if (items.length === 0) return null
    const top = items[0]
    const last = items.pop()
    if (items.length > 0) {
      items[0] = last
      let i = 0
      while (true) {
        const [left, right] = [i * 2 + 1, i * 2 + 2]
        let smallest = i
        if (left < items.length && items[left].key < items[smallest].key) smallest = left
        if (right < items.length && items[right].key < items[smallest].key) smallest = right
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i], items[smallest]]
        i = smallest
      }
    }
    return top
  }
}

// 進んできた向きから、point → next の向きへ何度曲がるか（右がプラス）
// 座標は X が北、Z が東なので、北から東へ曲がると外積がプラス＝右
function angleAt(prev, point, next) {
  const a = [point.x - prev.x, point.z - prev.z]
  const b = [next.x - point.x, next.z - point.z]
  const cross = a[0] * b[1] - a[1] * b[0]
  const dot = a[0] * b[0] + a[1] * b[1]
  return (Math.atan2(cross, dot) * 180) / Math.PI
}

/**
 * 出発地点の一覧。「乗ってきた電車」（ホームから）と「今いる改札」（改札を出たところから）の2種類。
 * 東京駅のデータは改札の外だけなので、「乗ってきた電車」（data.arrivals）は空
 * 改札は、改札機を通り抜ける地点（gatepass）から探す。そこからは外側へしか進めない
 */
export function listOrigins(data) {
  const fromTrains = data.arrivals.map((arrival) => ({
    id: `arrival:${arrival.id}`,
    group: '乗ってきた電車',
    label: `${arrival.name}（${arrival.track}）`,
    name: arrival.name,
    point: arrival.platform,
    firstStep: `${arrival.name}の電車を降りる（${arrival.track}）`,
  }))
  const fromGates = data.points
    .filter((point) => point.type === 'gatepass')
    .map((point) => ({
      id: `gate:${point.id}`,
      // JR と地下鉄の改札を分けて並べる（operator はデータの作成時に付けている）
      group: point.operator ? `今いる改札（${point.operator}）` : '今いる改札',
      label: point.name,
      name: point.name,
      point: point.id,
      firstStep: `${point.name}を出る`,
    }))
  return [...fromTrains, ...fromGates]
}

/**
 * ルート（地点の並び）から、道順の文章と所要時間の目安を作る。
 * @param origin 出発地点（listOrigins の1つ）
 */
export function describeRoute(data, path, origin) {
  const byId = Object.fromEntries(data.points.map((p) => [p.id, p]))
  const floorById = Object.fromEntries(data.floors.map((f) => [f.id, f]))
  const nodes = path.map((id) => byId[id])
  const neighbors = neighborsOf(data)
  const steps = [{ point: path[0], text: origin.firstStep }]

  // 出発地点からの道のり（水平方向）
  const along = [0]
  for (let i = 1; i < nodes.length; i++) {
    along.push(along[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z))
  }
  // i 番目の地点から先、同じ通路が続く道のり（階段などの connector は挟んでもよいが、屋外など通路名のない node で途切れる）
  const passageLength = (i) => {
    let j = i
    while (j + 1 < nodes.length) {
      const nextNode = nodes[j + 1]
      const nextPassage = nextNode.type === 'node' ? nextNode.passage : nodes[i].passage
      if (nextPassage !== nodes[i].passage) break
      j++
    }
    return along[j] - along[i]
  }
  // i 番目の地点の前後 LOOK m の所（同じ階の中だけ）。曲がる向きを、短い線のガタつきに左右されずに見るため
  const around = (i, step) => {
    let j = i
    while (j + step >= 0 && j + step < nodes.length && nodes[j + step].floor === nodes[i].floor) {
      j += step
      if (Math.abs(along[j] - along[i]) >= LOOK) break
    }
    return nodes[j]
  }
  // i 番目の地点で曲がるなら「右」「左」を返す。
  // ほかの道のほうがずっとまっすぐなときだけ曲がると案内する（自分の道がいちばんまっすぐなら「道なり」）
  const turnAt = (i) => {
    const [back, ahead] = [around(i, -1), around(i, 1)]
    if (back === nodes[i] || ahead === nodes[i]) return null
    if (Math.hypot(back.x - nodes[i].x, back.z - nodes[i].z) < 1.5) return null
    if (Math.hypot(ahead.x - nodes[i].x, ahead.z - nodes[i].z) < 1.5) return null
    const angle = angleAt(back, nodes[i], ahead)
    if (Math.abs(angle) < TURN_ANGLE) return null
    const others = (neighbors.get(nodes[i].id) ?? [])
      .filter((id) => id !== nodes[i - 1].id && id !== nodes[i + 1].id)
      .map((id) => byId[id])
      .filter((p) => p.floor === nodes[i].floor && (p.x !== nodes[i].x || p.z !== nodes[i].z))
    if (others.length === 0) return null // 分かれ道でない（通路が折れ曲がっているだけ）
    if (others.every((p) => Math.abs(angleAt(back, nodes[i], p)) > Math.abs(angle) + STRAIGHTER)) return null
    return angle > 0 ? '右' : '左'
  }

  let lastStepAt = 0 // 最後に案内した所の道のり
  let lastPassage = null // 最後に案内した通路の名前
  let currentPassage = nodes[0].passage ?? null // 直前の通路地点の通路名
  const push = (i, text) => {
    // 「階段を通る」などが近くで続くときは、1つにまとめる
    if (steps.length > 1 && steps[steps.length - 1].text === text && along[i] - lastStepAt < REPEAT_GAP) return
    steps.push({ point: nodes[i].id, text })
    lastStepAt = along[i]
  }

  for (let i = 1; i < nodes.length; i++) {
    const [, point, next] = [nodes[i - 1], nodes[i], nodes[i + 1]]

    if (point.type === 'exit' && i === nodes.length - 1) {
      push(i, `${point.name}に到着`)
    } else if (next && point.connector && point.connector === next.connector) {
      // 階段・エスカレーター・エレベーターの端から、もう一方の端へ
      const kind = CONNECTOR_NAMES[point.type] ?? '階段'
      if (next.floor === point.floor) {
        // 同じ階の中の数段の階段など
        push(i, `${kind}を通る`)
      } else {
        const up = floorById[next.floor].level > floorById[point.floor].level
        push(i, `${kind}で${floorById[next.floor].name}へ${up ? '上がる' : '下りる'}`)
      }
    } else if (point.type === 'gatepass') {
      push(i, `${point.name}を出る`)
    } else if (point.type === 'node' && next) {
      const turn = turnAt(i)
      const turnText = turn ? `${turn}に曲がり、` : ''
      if (point.passage && point.passage !== currentPassage && point.passage !== lastPassage && passageLength(i) >= PASSAGE_STAY) {
        // 新しい通路に入る（すぐに出てしまう通路や、さっきまでいた通路に戻るときは案内しない）
        push(i, `${turnText}${point.passage}を進む`)
        lastPassage = point.passage
      } else if (turn && along[i] - lastStepAt >= TURN_GAP) {
        const last = steps[steps.length - 1]
        if (steps.length > 1 && /^[右左]に曲がる$/.test(last.text) && along[i] - lastStepAt < TURN_PAIR) {
          // 続けて曲がるときは、1つの案内にまとめる（案内の地点は1回目に曲がる所のまま）
          last.text = `${last.text[0]}に曲がり、すぐ${turn}に曲がる`
          lastStepAt = along[i]
        } else {
          push(i, `${turn}に曲がる`)
        }
      }
      currentPassage = point.passage ?? null
    }
  }

  // 道のり（水平方向）と所要時間の目安
  const distance = along[along.length - 1]
  const minutes = Math.max(1, Math.ceil(distance / WALK_SPEED / 60))

  const goal = nodes[nodes.length - 1]
  return {
    name: `${origin.name} → ${goal.name}`,
    path,
    steps,
    distance: Math.round(distance),
    minutes,
  }
}
