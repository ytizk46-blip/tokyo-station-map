import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// 駅の構造（床・部屋・柱や壁・階段など）を、データから立体にする。
// 形は国土交通省の屋内地図オープンデータの面（多角形）を、階ごとに押し出して作る
// （参考：「Three.jsで新宿駅構内図を3Dで可視化してみる」@satoshi7190、Qiita）

// 階と階の間隔の初期値。データに floorGap があればそちらを使う
export const FLOOR_GAP = 30

const FLOOR_THICKNESS = 0.4
const UP = new THREE.Vector3(0, 1, 0)

// 部屋・空間の見た目（グループは tools/build-tokyo-3d.mjs の spaceStyleOf で決めている）。
// height は押し出す高さ（m）。お店などは半透明の箱にして、中の通路が見えるようにする
const SPACE_STYLES = {
  walkway: { color: '#ffffff', height: 0.15, opacity: 0.85 },
  shop: { color: '#fb7185', height: 3, opacity: 0.32, edges: true },
  toilet: { color: '#3b82f6', height: 3, opacity: 0.5, edges: true },
  service: { color: '#8b5cf6', height: 3, opacity: 0.4, edges: true },
  other: { color: '#94a3b8', height: 3, opacity: 0.3, edges: true },
  stairs: { color: '#f97316', height: 1.2, opacity: 0.85 },
  escalator: { color: '#eab308', height: 1.2, opacity: 0.85 },
  elevator: { color: '#d946ef', height: 3, opacity: 0.7, edges: true },
  slope: { color: '#22c55e', height: 0.4, opacity: 0.85 },
}
const FIXTURE = { color: '#475569', height: 3.2, opacity: 0.75 } // 柱・壁
// 階をまたぐつながりの線の色
const CONNECTOR_COLORS = { stairs: '#ea580c', escalator: '#ca8a04', elevator: '#c026d3', slope: '#16a34a' }
const EXIT_COLOR = '#16a34a' // 出口の目印（駅の案内の緑）
const GATE_COLOR = '#1d4ed8' // 改札の目印

// 階の色を白に近づけた、床の色
function floorTint(floor) {
  return `#${new THREE.Color(floor.color).lerp(new THREE.Color('#ffffff'), 0.7).getHexString()}`
}

// from から to へ向いた向きを作る（箱の長さ方向 = from→to、上 = なるべく真上）
export function orientationAlong(from, to) {
  const forward = to.clone().sub(from).normalize()
  const side = new THREE.Vector3().crossVectors(forward, UP).normalize()
  const up = new THREE.Vector3().crossVectors(side, forward)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(forward, up, side))
}

// from と to を結ぶ箱。height は上下の厚み、width は横幅
export function boxBetween(from, to, height, width, material) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(from.distanceTo(to), height, width),
    material,
  )
  mesh.position.copy(from).add(to).multiplyScalar(0.5)
  mesh.quaternion.copy(orientationAlong(from, to))
  return mesh
}

// 多角形 [[外側], [穴], ...]（点は [x, z]）を、bottomY から height の厚みで立体にする
function prismGeometry(polygon, bottomY, height) {
  // Shape は x-y 平面なので、z を -y として描き、あとで寝かせる
  const toShapePoints = (list) => list.map(([x, z]) => new THREE.Vector2(x, -z))
  const shape = new THREE.Shape(toShapePoints(polygon[0]))
  for (const hole of polygon.slice(1)) shape.holes.push(new THREE.Path(toShapePoints(hole)))
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, bottomY, 0)
  geometry.deleteAttribute('uv') // 使わない（まとめるときに項目をそろえるため）
  return geometry
}

// たくさんの多角形を押し出して、1つの形にまとめる（部品ごとに描くとスマホで重いため）
function mergedPrisms(polygons, bottomY, height) {
  const geometries = polygons.map((polygon) => prismGeometry(polygon, bottomY, height))
  const merged = mergeGeometries(geometries)
  for (const g of geometries) g.dispose()
  return merged
}

/**
 * @param data 駅データ（floors, points, shapes）
 * @param floorY 階のIDから高さを返す関数
 * @param pointPosition 地点のIDから3D座標を返す関数
 * @param register (material, floorIds) を受け取り、階の強調で透明度を変える対象として登録する関数
 */
export function buildStation(data, { floorY, pointPosition, register }) {
  const station = new THREE.Group()
  const markers = new THREE.Group() // 出口と改札の目印。1人称の見た目（interior.js）でも出す
  const plates = []

  function material(floorIds, color, options = {}) {
    return register(new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, ...options }), floorIds)
  }
  function lineMaterial(floorIds, color, opacity = 1) {
    return register(new THREE.LineBasicMaterial({ color, opacity, transparent: true }), floorIds)
  }

  for (const floor of data.floors) {
    const shape = data.shapes[floor.id]
    if (!shape) continue
    const ids = [floor.id]
    const y = floorY(floor.id)

    // 床：うすい板。輪郭線を付けて、どこまでがその階かわかるようにする
    if (shape.floor.length) {
      const geometry = mergedPrisms(shape.floor, y - FLOOR_THICKNESS, FLOOR_THICKNESS)
      station.add(new THREE.Mesh(geometry, material(ids, floorTint(floor), { opacity: 0.55, depthWrite: false })))
      station.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), lineMaterial(ids, floor.color, 0.45)))

      // 階の名前を置く位置（床の手前の角）
      geometry.computeBoundingBox()
      const box = geometry.boundingBox
      plates.push({ floor, corner: new THREE.Vector3(box.min.x, y, box.max.z) })
    }

    // 部屋・空間：種類ごとに色と高さを変えて押し出す
    for (const [styleName, polygons] of Object.entries(shape.spaces)) {
      const style = SPACE_STYLES[styleName] ?? SPACE_STYLES.other
      const geometry = mergedPrisms(polygons, y, style.height)
      const opaque = style.opacity >= 0.8
      station.add(new THREE.Mesh(geometry, material(ids, style.color, { opacity: style.opacity, depthWrite: opaque })))
      if (style.edges) {
        station.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), lineMaterial(ids, style.color, 0.7)))
      }
    }

    // 柱・壁
    if (shape.fixture.length) {
      const geometry = mergedPrisms(shape.fixture, y, FIXTURE.height)
      station.add(new THREE.Mesh(geometry, material(ids, FIXTURE.color, { opacity: FIXTURE.opacity })))
    }
  }

  // ---- 階をまたぐつながり（階段・エスカレーター・エレベーター）を線で描く ----
  // 押し出しただけの形では、どこで上下の階がつながっているかわからないため
  const connectorLines = new Map() // 種類と階の組 → 線の座標
  const ends = new Map()
  for (const point of data.points) {
    if (!point.connector) continue
    if (!ends.has(point.connector)) ends.set(point.connector, [])
    ends.get(point.connector).push(point)
  }
  for (const [a, b] of ends.values()) {
    if (!b || a.floor === b.floor) continue
    const key = `${a.type}|${[a.floor, b.floor].sort().join(',')}`
    if (!connectorLines.has(key)) connectorLines.set(key, { type: a.type, floorIds: [a.floor, b.floor], positions: [] })
    const [pa, pb] = [pointPosition(a.id), pointPosition(b.id)]
    connectorLines.get(key).positions.push(pa.x, pa.y + 0.3, pa.z, pb.x, pb.y + 0.3, pb.z)
  }
  for (const { type, floorIds, positions } of connectorLines.values()) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    station.add(new THREE.LineSegments(geometry, lineMaterial(floorIds, CONNECTOR_COLORS[type] ?? '#64748b', 0.8)))
  }

  // ---- 出口と改札の目印（床の上の丸い板） ----
  // 1人称では目印の地点から歩き始めるので、視界をふさがないよう平らにする
  const disc = new THREE.CylinderGeometry(1.6, 1.6, 0.12, 20)
  disc.translate(0, 0.2, 0)
  for (const floor of data.floors) {
    for (const [type, color] of [['exit', EXIT_COLOR], ['gatepass', GATE_COLOR]]) {
      const list = data.points.filter((p) => p.type === type && p.floor === floor.id)
      if (!list.length) continue
      const geometries = list.map((p) => disc.clone().translate(p.x, floorY(floor.id), p.z))
      markers.add(new THREE.Mesh(mergeGeometries(geometries), material([floor.id], color, { opacity: 0.95 })))
      for (const g of geometries) g.dispose()
    }
  }
  disc.dispose()

  return { station, markers, plates }
}
