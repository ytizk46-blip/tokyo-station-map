import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { cellAt, FIXTURE, LOW, OUTDOOR, WALK } from './walk-grid.js'

// 1人称で歩くときの、駅の中の見た目（床・天井・壁・柱・蛍光灯）。
// 歩ける場所のマス目（data.walkGrid）から作るので、見えている壁と当たり判定がずれない。
// ただし柱と壁（元データの Fixture）は小さく、マス目の輪郭ではいびつな形になるので、元データの形をそのまま立てる。
// タイルなどの模様は画像ファイルを使わず、canvas に描いて作る
// （見た目は「新宿ダンジョン」https://shinjukudungeon.com/ を参考にした）

const CEILING_HEIGHT = 3
const LOW_WALL_HEIGHT = 1.1 // 階段・エスカレーターの穴のまわりの手すり壁
const FLOOR_TILE = 0.9 // 床のタイルの大きさ（m）
const CEILING_TILE = 0.6
const LIGHT_SPACING = { x: 8, z: 6 } // 蛍光灯を置く間隔（マスの数。0.5m のマスなので 4m × 3m）
const LIGHT_SIZE = { along: 1.8, across: 0.35 } // 蛍光灯の大きさ（m）
// 壁の線をなめらかにするときに許す、元の線からのずれ（m）。
// マスの境目のままだと、斜めの通路の壁がのこぎりの刃のようにギザギザになるため
const SMOOTHING = 0.35

const COLORS = {
  floor: '#8f877a',
  floorGrout: '#5f594f',
  outdoorFloor: '#7c7d80', // 屋外の歩道（同じタイルを灰色に寄せる）
  ceiling: '#d4d1c8',
  ceilingGrout: '#a9a59b',
  wallTile: '#d8d1c1',
  wallGrout: '#b3ab9a',
  wainscot: '#4b4c50', // 壁の下のほうの濃い帯
  stripe: '#c9a227', // 帯の上の黄色い線
  hole: '#c8732f', // 階段・エスカレーターの穴（構内図の階段と同じ橙）
  light: '#fffaf0',
}

// ---- 模様（canvas に描く） ----

function canvasTexture(width, height, draw, maxAnisotropy) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  draw(canvas.getContext('2d'), width, height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = maxAnisotropy
  return texture
}

// 1枚のタイル（まわりに目地）。ところどころ明るさを変えて、のっぺりしないようにする
function drawTile(ctx, size, base, grout, groutWidth) {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  for (let n = 0; n < 900; n++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.05})`
    ctx.fillRect(Math.random() * size, Math.random() * size, 2 + Math.random() * 3, 2 + Math.random() * 3)
  }
  ctx.strokeStyle = grout
  ctx.lineWidth = groutWidth
  ctx.strokeRect(0, 0, size, size)
}

function makeTextures(maxAnisotropy) {
  const floor = canvasTexture(256, 256, (ctx, w) => drawTile(ctx, w, COLORS.floor, COLORS.floorGrout, 6), maxAnisotropy)
  floor.repeat.set(1 / FLOOR_TILE, 1 / FLOOR_TILE)

  const ceiling = canvasTexture(128, 128, (ctx, w) => {
    drawTile(ctx, w, COLORS.ceiling, COLORS.ceilingGrout, 4)
    // 吸音板の小さな穴
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    for (let n = 0; n < 160; n++) ctx.fillRect(4 + Math.random() * (w - 8), 4 + Math.random() * (w - 8), 1.5, 1.5)
  }, maxAnisotropy)
  ceiling.repeat.set(1 / CEILING_TILE, 1 / CEILING_TILE)

  // 壁：横 1m・縦は床から天井まで（uv の v が 0 で床、1 で天井）。
  // 下から濃い帯（0.85m）、黄色い線、その上に小さなタイル（20cm）
  const wall = canvasTexture(128, 384, (ctx, w, h) => {
    const perMeter = h / CEILING_HEIGHT
    const band = h - 0.85 * perMeter
    const stripe = 0.06 * perMeter
    ctx.fillStyle = COLORS.wallTile
    ctx.fillRect(0, 0, w, band - stripe)
    ctx.strokeStyle = COLORS.wallGrout
    ctx.lineWidth = 2
    const tile = 0.2 * perMeter
    for (let y = band - stripe; y > 0; y -= tile) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    for (let x = 0; x <= w; x += w / 5) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, band - stripe)
      ctx.stroke()
    }
    ctx.fillStyle = COLORS.stripe
    ctx.fillRect(0, band - stripe, w, stripe)
    ctx.fillStyle = COLORS.wainscot
    ctx.fillRect(0, band, w, h - band)
  }, maxAnisotropy)
  wall.wrapT = THREE.ClampToEdgeWrapping

  // 階段の穴：段のような縞
  const hole = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = COLORS.hole
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, h * 0.8, w, h * 0.2)
  }, maxAnisotropy)
  hole.repeat.set(1 / 0.3, 1 / 0.3)

  // 柱は ExtrudeGeometry の uv（v は 1 − 高さ m）に合わせて、壁と同じ模様が床から天井へ並ぶようにする
  const pillar = wall.clone()
  pillar.repeat.set(1, -1 / CEILING_HEIGHT)
  pillar.offset.set(0, 1 / CEILING_HEIGHT)

  // 頭上の案内看板（駅の吊り下げ看板のように、枠・色帯・ピクトグラム風の印・日英の文字を描く）
  function signBoard({ accent, badge, title, sub }) {
    const tex = canvasTexture(256, 64, (ctx, w, h) => {
      // 外枠（濃いグレーの金属枠）と白い盤面
      ctx.fillStyle = '#1e293b'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(4, 4, w - 8, h - 8)
      // 上の色帯
      ctx.fillStyle = accent
      ctx.fillRect(4, 4, w - 8, 10)
      // 左側のピクトグラム枠
      ctx.fillStyle = accent
      ctx.fillRect(12, 18, 40, 38)
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 16px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(badge, 32, 37)
      // 日本語と英語の案内文字
      ctx.fillStyle = '#0f172a'
      ctx.font = 'bold 22px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(title, 62, 31)
      ctx.fillStyle = '#475569'
      ctx.font = 'bold 11px sans-serif'
      ctx.fillText(sub, 62, 50)
    }, maxAnisotropy)
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    return tex
  }

  return {
    floor,
    ceiling,
    wall,
    hole,
    pillar,
    exitSign: signBoard({ accent: '#15803d', badge: 'EXIT', title: '出口・入口', sub: 'Exit / Way Out' }),
    gateSign: signBoard({ accent: '#1d4ed8', badge: '改札', title: '改札口', sub: 'Ticket Gates' }),
    stairsSign: signBoard({ accent: '#ea580c', badge: '階段', title: '階段', sub: 'Stairs' }),
    escalatorSign: signBoard({ accent: '#ca8a04', badge: 'ESC', title: 'エスカレーター', sub: 'Escalator' }),
    elevatorSign: signBoard({ accent: '#c026d3', badge: 'EV', title: 'エレベーター', sub: 'Elevator' }),
  }
}

// ---- マス目から形を作る ----

// mask（0/1 の並び）の 1 のマスを、なるべく大きな長方形にまとめる。
// 行ごとに 1 が続く区間を出し、すぐ上の行と同じ区間なら1つの長方形にのばす
function rectangles(mask, rows, cols) {
  const result = []
  let open = new Map() // 区間 "j0,j1" → 長方形 { i0, i1, j0, j1 }
  for (let i = 0; i < rows; i++) {
    const next = new Map()
    for (let j = 0; j < cols; j++) {
      if (!mask[i * cols + j]) continue
      const j0 = j
      while (j + 1 < cols && mask[i * cols + j + 1]) j++
      const key = `${j0},${j}`
      const rect = open.get(key)
      if (rect) {
        rect.i1 = i
        open.delete(key)
        next.set(key, rect)
      } else {
        next.set(key, { i0: i, i1: i, j0, j1: j })
      }
    }
    for (const rect of open.values()) result.push(rect)
    open = next
  }
  for (const rect of open.values()) result.push(rect)
  return result
}

// 長方形を、高さ y の水平な板にする。up が true なら上向き（床）、false なら下向き（天井）。
// uv はメートル単位の位置（模様の大きさは texture.repeat で決める）
function flatGeometry(rects, grid, y, up) {
  const positions = []
  const uvs = []
  const indices = []
  for (const { i0, i1, j0, j1 } of rects) {
    const xa = grid.x0 + i0 * grid.cell
    const xb = grid.x0 + (i1 + 1) * grid.cell
    const za = grid.z0 + j0 * grid.cell
    const zb = grid.z0 + (j1 + 1) * grid.cell
    const base = positions.length / 3
    positions.push(xa, y, za, xa, y, zb, xb, y, za, xb, y, zb)
    uvs.push(za, xa, zb, xa, za, xb, zb, xb)
    // (xa,za) → (xa,zb) → (xb,za) の順に結ぶと上向きの面になる
    if (up) indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
    else indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// 1 のマスと、そのまわり1マス（斜めも）を 1 にする（壁の下や角に、床と天井のすき間ができないように）
function dilate(mask, rows, cols) {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (!mask[i * cols + j]) continue
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const ni = i + di
          const nj = j + dj
          if (ni >= 0 && nj >= 0 && ni < rows && nj < cols) out[ni * cols + nj] = 1
        }
      }
    }
  }
  return out
}

// 折れ線 points（[x, z] の並び）を、ずれが tolerance 以内の、点の少ない折れ線にする（ダグラス・ポーカー法）。
// 両端の点は残す
function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    const [ax, az] = points[first]
    const [bx, bz] = points[last]
    const length = Math.hypot(bx - ax, bz - az)
    let farthest = -1
    let distance = tolerance
    for (let k = first + 1; k < last; k++) {
      const [px, pz] = points[k]
      // 線 a-b からの距離（a と b が同じ点のときは a からの距離）
      const d = length > 0
        ? Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / length
        : Math.hypot(px - ax, pz - az)
      if (d > distance) {
        distance = d
        farthest = k
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  return points.filter((_, k) => keep[k])
}

/**
 * 歩けるマスと歩けないマスの境目に立てる壁を、線の並びとして求める（マーチングスクエア法）。
 * マスの中心を格子の点とみなし、2×2 の点の組ごとに、歩ける点と歩けない点の間（辺の中点）を結ぶ。
 * 結んだ線は輪になるので、輪をたどって、同じ高さで続く区間ごとになめらかな折れ線にする。
 * 戻り値：[{ ax, az, bx, bz, height, u0, u1 }]（u0・u1 は輪に沿った長さ。壁の模様の位置に使う）
 */
export function wallSegments(grid) {
  const { rows, cols, cells, cell, x0, z0 } = grid
  // 柱・壁のマスは、ここでは歩けるマスとして扱う（柱は元データの形で別に描くため、まわりに壁を作らない）
  const walk = (i, j) => (cells[i * cols + j] & (WALK | FIXTURE)) !== 0
  const low = (i, j) => (cells[i * cols + j] & LOW) !== 0
  // 辺の中点の番号：H(i, j) は点 (i, j)-(i, j+1) の間、V(i, j) は点 (i, j)-(i+1, j) の間
  const H = (i, j) => (i * cols + j) * 2
  const V = (i, j) => (i * cols + j) * 2 + 1
  // 中点の位置（半マス単位の整数）
  const halfUnits = (key) => {
    const k = key >> 1
    const i = Math.floor(k / cols)
    const j = k % cols
    return key & 1 ? [2 * i + 2, 2 * j + 1] : [2 * i + 1, 2 * j + 2]
  }

  const segments = [] // [中点a, 中点b, 低い壁か]
  const touching = new Map() // 中点 → その中点を通る線の番号
  const add = (a, b, lowWall) => {
    const s = segments.length
    segments.push([a, b, lowWall])
    for (const key of [a, b]) {
      const list = touching.get(key)
      if (list) list.push(s)
      else touching.set(key, [s])
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      // 2×2 の点：a(i,j) b(i,j+1) c(i+1,j+1) d(i+1,j)
      const a = walk(i, j)
      const b = walk(i, j + 1)
      const c = walk(i + 1, j + 1)
      const d = walk(i + 1, j)
      const count = a + b + c + d
      if (count === 0 || count === 4) continue
      const ab = H(i, j)
      const bc = V(i, j + 1)
      const dc = H(i + 1, j)
      const ad = V(i, j)
      // 歩けない点がすべて階段の穴なら、低い手すり壁にする
      const blocked = [[a, i, j], [b, i, j + 1], [c, i + 1, j + 1], [d, i + 1, j]].filter(([w]) => !w)
      const lowWall = blocked.every(([, bi, bj]) => low(bi, bj))
      if (a === c && b === d && a !== b) {
        // 斜めに向かい合う形。歩ける点どうしはつなげず、それぞれを囲む（当たり判定は上下左右でつながるため）
        if (a) {
          add(ab, ad, lowWall)
          add(bc, dc, lowWall)
        } else {
          add(ab, bc, lowWall)
          add(ad, dc, lowWall)
        }
        continue
      }
      const crossing = []
      if (a !== b) crossing.push(ab)
      if (b !== c) crossing.push(bc)
      if (d !== c) crossing.push(dc)
      if (a !== d) crossing.push(ad)
      add(crossing[0], crossing[1], lowWall)
    }
  }

  // 輪をたどり、同じ高さの壁が続く区間ごとに、線をなめらかにして（simplify）まとめる
  const used = new Uint8Array(segments.length)
  const walls = []
  const toWorld = (key) => {
    const [hx, hz] = halfUnits(key)
    return [x0 + (hx * cell) / 2, z0 + (hz * cell) / 2]
  }
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue
    // 輪の中点の並び（最初と最後は同じ点）と、各区間が低い壁か
    const loop = [segments[start][0]]
    const lows = []
    let s = start
    let at = segments[start][0]
    while (!used[s]) {
      used[s] = 1
      const [p, q, lowWall] = segments[s]
      at = at === p ? q : p
      loop.push(at)
      lows.push(lowWall)
      s = touching.get(at).find((other) => other !== s) ?? s
    }
    // 高さが変わる所で区切る。区切りがあれば、区切りから始まるように輪を回す
    const n = lows.length
    const firstBreak = lows.findIndex((low, k) => low !== lows[(k + n - 1) % n])
    const shift = Math.max(0, firstBreak)
    const ring = [...loop.slice(shift, n), ...loop.slice(0, shift + 1)].map(toWorld)
    const ringLows = [...lows.slice(shift), ...lows.slice(0, shift)]
    let u = 0
    let from = 0
    for (let k = 1; k <= n; k++) {
      if (k < n && ringLows[k] === ringLows[k - 1]) continue
      const chain = ring.slice(from, k + 1)
      let kept = simplify(chain, SMOOTHING)
      // 小さな柱を囲む輪は、なめらかにすると厚みのない板につぶれるので、元の形のままにする
      if (from === 0 && k === n && kept.length < 5) kept = chain
      for (let m = 1; m < kept.length; m++) {
        const [ax, az] = kept[m - 1]
        const [bx, bz] = kept[m]
        const length = Math.hypot(bx - ax, bz - az)
        walls.push({ ax, az, bx, bz, height: ringLows[from] ? LOW_WALL_HEIGHT : CEILING_HEIGHT, u0: u, u1: u + length })
        u += length
      }
      from = k
    }
  }
  return walls
}

function wallGeometry(walls, y) {
  const positions = []
  const uvs = []
  const indices = []
  for (const { ax, az, bx, bz, height, u0, u1 } of walls) {
    const base = positions.length / 3
    positions.push(ax, y, az, bx, y, bz, bx, y + height, bz, ax, y + height, az)
    const v = height / CEILING_HEIGHT
    uvs.push(u0, 0, u1, 0, u1, v, u0, v)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// 柱・壁の多角形 [[外側], [穴], ...]（点は [x, z]）を、床から天井までの立体にする
function pillarGeometry(polygon, y) {
  const toShapePoints = (list) => list.map(([x, z]) => new THREE.Vector2(x, -z))
  const shape = new THREE.Shape(toShapePoints(polygon[0]))
  for (const hole of polygon.slice(1)) shape.holes.push(new THREE.Path(toShapePoints(hole)))
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: CEILING_HEIGHT, bevelEnabled: false })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, y, 0)
  return geometry
}

/**
 * @param grids 階の ID → マス目（free-walk.js の area.grids）
 * @param shapes 階の ID → 元データの形（data.shapes。柱・壁 fixture を使う）
 * @param points 地点の一覧（data.points。出口・改札・階段などの頭上サインを置くのに使う）
 * @param floorY 階の ID から床の高さを返す関数
 * @param maxAnisotropy 斜めから見たタイルをぼやけさせないための設定（renderer から）
 */
export function createInterior({ grids, shapes, points = [], floorY, maxAnisotropy = 1 }) {
  // 別の階へつながる connector の番号（同じ階の中の数段の階段には頭上サインを出さないため）
  const connectorFloors = new Map()
  for (const p of points) {
    if (!p.connector) continue
    if (!connectorFloors.has(p.connector)) connectorFloors.set(p.connector, new Set())
    connectorFloors.get(p.connector).add(p.floor)
  }
  const group = new THREE.Group()
  group.visible = false
  const textures = makeTextures(maxAnisotropy)
  const materials = {
    floor: new THREE.MeshLambertMaterial({ map: textures.floor }),
    outdoorFloor: new THREE.MeshLambertMaterial({ map: textures.floor, color: COLORS.outdoorFloor }),
    ceiling: new THREE.MeshLambertMaterial({ map: textures.ceiling }),
    wall: new THREE.MeshLambertMaterial({ map: textures.wall, side: THREE.DoubleSide }),
    pillar: new THREE.MeshLambertMaterial({ map: textures.pillar }),
    hole: new THREE.MeshLambertMaterial({ map: textures.hole }),
    light: new THREE.MeshBasicMaterial({ color: COLORS.light }),
    signFrame: new THREE.MeshLambertMaterial({ color: '#1e293b' }),
    exitSign: new THREE.MeshLambertMaterial({ map: textures.exitSign, emissive: '#14532d', emissiveIntensity: 0.35 }),
    gateSign: new THREE.MeshLambertMaterial({ map: textures.gateSign, emissive: '#1e3a8a', emissiveIntensity: 0.35 }),
    stairsSign: new THREE.MeshLambertMaterial({ map: textures.stairsSign, emissive: '#7c2d12', emissiveIntensity: 0.35 }),
    escalatorSign: new THREE.MeshLambertMaterial({ map: textures.escalatorSign, emissive: '#713f12', emissiveIntensity: 0.35 }),
    elevatorSign: new THREE.MeshLambertMaterial({ map: textures.elevatorSign, emissive: '#701a75', emissiveIntensity: 0.35 }),
  }
  const built = new Map()
  const ceilings = [] // 天井と蛍光灯・頭上サイン（階の間を移動している間は隠す）

  function buildFloor(floorId) {
    const grid = grids.get(floorId)
    const y = floorY(floorId)
    const { rows, cols, cells } = grid
    const floorGroup = new THREE.Group()
    const count = rows * cols

    // 床：歩けるマスと穴のまわり1マスまで（壁の下まで床を敷く）。屋外は色を変える。穴は別の模様
    const shown = new Uint8Array(count)
    for (let k = 0; k < count; k++) shown[k] = cells[k] & (WALK | LOW | FIXTURE) ? 1 : 0
    const around = dilate(shown, rows, cols)
    const indoor = new Uint8Array(count)
    const outdoor = new Uint8Array(count)
    const hole = new Uint8Array(count)
    for (let k = 0; k < count; k++) {
      if (!around[k]) continue
      if (cells[k] & LOW) hole[k] = 1
      else if (cells[k] & OUTDOOR) outdoor[k] = 1
      else indoor[k] = 1
    }
    floorGroup.add(new THREE.Mesh(flatGeometry(rectangles(indoor, rows, cols), grid, y, true), materials.floor))
    floorGroup.add(new THREE.Mesh(flatGeometry(rectangles(outdoor, rows, cols), grid, y, true), materials.outdoorFloor))
    floorGroup.add(new THREE.Mesh(flatGeometry(rectangles(hole, rows, cols), grid, y - 0.02, true), materials.hole))

    // 天井：屋外でないところ
    const roof = new Uint8Array(count)
    for (let k = 0; k < count; k++) roof[k] = around[k] && !(cells[k] & OUTDOOR) ? 1 : 0
    const ceiling = new THREE.Mesh(flatGeometry(rectangles(roof, rows, cols), grid, y + CEILING_HEIGHT, false), materials.ceiling)
    floorGroup.add(ceiling)
    ceilings.push(ceiling)

    // 壁と、柱（元データの形）
    floorGroup.add(new THREE.Mesh(wallGeometry(wallSegments(grid), y), materials.wall))
    const fixtures = shapes[floorId]?.fixture ?? []
    if (fixtures.length) {
      const pieces = fixtures.map((polygon) => pillarGeometry(polygon, y))
      floorGroup.add(new THREE.Mesh(mergeGeometries(pieces), materials.pillar))
      for (const piece of pieces) piece.dispose()
    }

    // 蛍光灯：天井のある歩ける所に、決まった間隔で並べる（同じ形を1回でまとめて描く）
    const reach = Math.ceil(LIGHT_SIZE.along / 2 / grid.cell)
    const spots = []
    const canLight = (r, c) => {
      const v = cells[r * cols + c]
      return (v & WALK) !== 0 && !(v & OUTDOOR)
    }
    for (let i = reach; i < rows - reach; i += LIGHT_SPACING.x) {
      for (let j = reach; j < cols - reach; j += LIGHT_SPACING.z) {
        let fitsZ = true
        for (let dj = -reach; dj <= reach && fitsZ; dj++) fitsZ = canLight(i, j + dj)
        let fitsX = !fitsZ
        for (let di = -reach; di <= reach && fitsX; di++) fitsX = canLight(i + di, j)
        if (fitsZ || fitsX) {
          spots.push([grid.x0 + (i + 0.5) * grid.cell, grid.z0 + (j + 0.5) * grid.cell, !fitsZ])
        }
      }
    }
    if (spots.length) {
      const panel = new THREE.PlaneGeometry(LIGHT_SIZE.across, LIGHT_SIZE.along)
      panel.rotateX(Math.PI / 2) // 下向きの板。長い向きは Z（東西）。南北の通路では90度回して置く
      const lights = new THREE.InstancedMesh(panel, materials.light, spots.length)
      const matrix = new THREE.Matrix4()
      spots.forEach(([x, z, turn], n) => {
        if (turn) matrix.makeRotationY(Math.PI / 2)
        else matrix.identity()
        matrix.setPosition(x, y + CEILING_HEIGHT - 0.03, z)
        lights.setMatrixAt(n, matrix)
      })
      floorGroup.add(lights)
      ceilings.push(lights)
    }

    // 頭上の吊り下げ案内サイン（出口・改札・階段・エスカレーター・エレベーター）。
    // 1人称で遠くから見回したときに、どこに何があるか見つけやすくする。
    // 天井のない屋外と、同じ階の中の数段の階段には出さない
    const hasSign = (p) =>
      p.floor === floorId &&
      !(cellAt(grid, p.x, p.z) & OUTDOOR) &&
      (!p.connector || connectorFloors.get(p.connector).size > 1)
    const signDrop = 0.26
    const signGroups = [
      ['exit', materials.exitSign, 1.5, 0.36],
      ['gatepass', materials.gateSign, 1.7, 0.36],
      ['stairs', materials.stairsSign, 1.15, 0.3],
      ['escalator', materials.escalatorSign, 1.15, 0.3],
      ['elevator', materials.elevatorSign, 1.3, 0.34],
    ]
    const signMatrix = new THREE.Matrix4()
    const rodSpots = []
    for (const [type, mat, width, height] of signGroups) {
      const list = points.filter((p) => p.type === type && hasSign(p))
      if (!list.length) continue
      const box = new THREE.BoxGeometry(width, height, width)
      const faceMats = [mat, mat, materials.signFrame, materials.signFrame, mat, mat]
      const mesh = new THREE.InstancedMesh(box, faceMats, list.length)
      const signY = y + CEILING_HEIGHT - signDrop - height / 2
      list.forEach((p, n) => {
        mesh.setMatrixAt(n, signMatrix.makeTranslation(p.x, signY, p.z))
        const offset = width * 0.32
        rodSpots.push([p.x - offset, p.z], [p.x + offset, p.z])
      })
      floorGroup.add(mesh)
      ceilings.push(mesh)
    }
    if (rodSpots.length) {
      const rodGeom = new THREE.CylinderGeometry(0.02, 0.02, signDrop, 6)
      const rods = new THREE.InstancedMesh(rodGeom, materials.signFrame, rodSpots.length)
      const rodY = y + CEILING_HEIGHT - signDrop / 2
      rodSpots.forEach(([rx, rz], n) => rods.setMatrixAt(n, signMatrix.makeTranslation(rx, rodY, rz)))
      floorGroup.add(rods)
      ceilings.push(rods)
    }

    for (const mesh of floorGroup.children) mesh.matrixAutoUpdate = false
    group.add(floorGroup)
    return floorGroup
  }

  return {
    group,

    /** その階の形を作る（まだ作っていなければ）。1人称で初めてその階に入るときに呼ぶ */
    ensureFloor(floorId) {
      if (!built.has(floorId) && grids.has(floorId)) built.set(floorId, buildFloor(floorId))
    },

    /**
     * 天井を出すかどうか。階段やエスカレーターで階の間を移動している間は隠す
     * （表示の都合で階と階の間を広く空けているので、天井を下から突き抜けるように見えてしまうため）
     */
    showCeilings(visible) {
      for (const mesh of ceilings) mesh.visible = visible
    },
  }
}
