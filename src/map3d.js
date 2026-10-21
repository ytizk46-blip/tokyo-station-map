import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { boxBetween, buildStation, FLOOR_GAP, orientationAlong } from './station-model.js'
import { createWalkthrough } from './walkthrough.js'
import { createFreeWalkArea } from './free-walk.js'
import { createInterior } from './interior.js'
import { cellAt, OUTDOOR } from './walk-grid.js'

// 3Dマップ。画面の部品（ボタンや道順の文章）は持たず、各画面から関数を呼んで操作する。
// 見え方は3つ：
//   overview … 3人称。駅を斜め上から見る（指で回転・拡大）
//   free     … 1人称。移動スティックで自由に歩く（トップ画面）
//   route    … 1人称。ルートに沿って自動で歩く（検索結果画面）

const ROUTE_COLOR = '#dc2626'
const MOVE_COLOR = '#9333ea' // 階をまたぐ移動（階段など）の色
const SELF_COLOR = '#2563eb' // 自分の位置の目印

// 案内中ではない階の濃さ（元の濃さに対する割合）
const DIMMED = { mesh: 0.1, label: 0.15 }

// 名前を表示する地点の種類（出口・建物の入口と改札）
const LABELED_TYPES = ['gatepass', 'exit']
// 全体表示でも名前を出す種類。それ以外は、その階を案内しているときだけ出す（文字が重ならないように）
const OVERVIEW_LABEL_TYPES = ['exit', 'gatepass']
// 駅の範囲が約2kmと広く、出口が百か所以上あるので、地点の名前はカメラから近い物だけ出す（m）。
// 1人称では壁の向こうの名前まで見えてしまうので、もっと近い物だけにする
const LABEL_DISTANCE = { overview: 260, firstPerson: 45 }

// 全体を見るときのカメラの向き（斜め上から）。
// 横長の画面では東側から見る（駅の長い方向が画面の横、北が右）。
// 縦長の画面では南側から見る（駅の長い方向が画面の縦、北が上・東が右）
const OVERVIEW_DIRECTION = {
  landscape: new THREE.Vector3(10, 26, 40).normalize(),
  portrait: new THREE.Vector3(-40, 30, 6).normalize(),
}
const FOCUS_DISTANCE = 80 // 地点に寄るときの距離
const ROUTE_MARGIN = 30 // ルートの全体を見るとき、ルートのまわりに空ける幅（m）
const MIN_DISTANCE = 15 // 拡大の限度

// 自由に歩くとき
const EYE_HEIGHT = 1.6
const FREE_SPEED = 3 // スティックをいっぱいに倒したときの速さ（m/秒）
const RIDE_SPEED = 4 // 階段・エスカレーターで移動する速さ（m/秒）
const WALK_FOV = 70
const FOV_RANGE = [35, 90] // 1人称で拡大・縮小できる視野角
const MAX_PITCH = THREE.MathUtils.degToRad(60)

// 1人称のときの背景と霧（遠くを暗くして、地下の通路らしくする）。屋外に立っているときは空の色にする
const WALK_BACKGROUND = '#2b2a28'
const SKY_COLOR = '#a9b8c8'
const WALK_FOG = { near: 20, far: 140 }
// カメラに近すぎて描かれない距離。1人称では壁に近づくので小さくする
const NEAR = { overview: 0.5, firstPerson: 0.1 }

// 端末で「視差効果を減らす」が設定されていたら、カメラの移動をアニメーションさせない
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * @param container 3Dマップを描く要素
 * @param data 駅データ（src/data/tokyo-3d.json）
 * @param onRouteWalk ルートに沿って歩いている間、状態が変わるたびに呼ばれる関数
 * @param onFreeWalk 自由に歩いている間、今いる階や近くの階段が変わるたびに呼ばれる関数
 */
export function createMap({
  container,
  data,
  onRouteWalk = () => {},
  onFreeWalk = () => {},
  onSelectPoint = () => {},
  onCameraChange = () => {},
}) {
  const floorById = Object.fromEntries(data.floors.map((f) => [f.id, f]))
  const pointById = Object.fromEntries(data.points.map((p) => [p.id, p]))
  const area = createFreeWalkArea(data)

  const floorGap = data.floorGap ?? FLOOR_GAP
  const floorY = (floorId) => floorById[floorId].level * floorGap

  // 地点の3D座標（階の高さ + 平面上の位置）
  function pointPosition(id) {
    const point = pointById[id]
    return new THREE.Vector3(point.x, floorY(point.floor), point.z)
  }

  // ---- 基本のセットアップ ----
  const scene = new THREE.Scene()
  const overviewBackground = new THREE.Color('#eef2f6')
  const walkBackground = new THREE.Color(WALK_BACKGROUND)
  const skyColor = new THREE.Color(SKY_COLOR)
  const walkFog = new THREE.Fog(WALK_BACKGROUND, WALK_FOG.near, WALK_FOG.far)
  scene.background = overviewBackground

  const camera = new THREE.PerspectiveCamera(45, 1, NEAR.overview, 5000)
  const overviewFov = camera.fov

  // WebGL が使えない端末では例外になる。呼び出し側でメッセージを出す
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.appendChild(renderer.domElement)

  // 日本語の文字はHTMLで表示する（3D空間の位置に合わせて動く）
  const labelRenderer = new CSS2DRenderer()
  labelRenderer.domElement.className = 'map-labels'
  container.appendChild(labelRenderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  // ホイールを押したままドラッグすると地図を平行移動する（拡大・縮小はホイールの回転で行う）
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
  // ホイールクリックで出るブラウザの自動スクロールを止める
  renderer.domElement.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault()
  })

  scene.add(new THREE.HemisphereLight('#ffffff', '#9aa3ad', 1.6))
  const light = new THREE.DirectionalLight('#ffffff', 1.8)
  light.position.set(20, 40, 30)
  scene.add(light)

  // ---- 描き直しが必要かどうか ----
  // 何も動いていないときは描かない（スマホの電池と発熱を抑えるため）
  let needsRender = true
  const requestRender = () => {
    needsRender = true
  }
  controls.addEventListener('change', requestRender)

  // ほかの画面で隠れているときは描かない
  let paused = false

  // ---- 階の強調のための登録 ----
  // 案内中の階だけ濃く表示するため、材質と文字を「どの階のものか」と一緒に覚えておく
  const fadeMaterials = []
  const fadeLabels = []

  function register(material, floorIds) {
    material.transparent = true
    fadeMaterials.push({
      material,
      floorIds,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
    })
    return material
  }

  // 3D空間に文字を置き、その CSS2DObject を返す（文字の要素は .element）。
  // floorIds を渡すと階の強調の対象になる。detail が true の文字は全体表示では出さない
  function makeLabel(text, className, position, floorIds, detail = false, options = {}) {
    const element = document.createElement('div')
    element.className = className
    element.textContent = text
    const label = new CSS2DObject(element)
    label.position.copy(position)
    scene.add(label)
    // near が true の文字は、カメラから近いときだけ出す（地点や通路の案内看板）
    if (floorIds) {
      fadeLabels.push({
        element,
        label,
        floorIds,
        detail,
        near: options.near ?? false,
        nearDistance: options.nearDistance ?? LABEL_DISTANCE,
        firstPersonOnly: options.firstPersonOnly ?? false,
        overviewY: position.y,
        firstPersonY: options.firstPersonY ?? position.y,
        point: options.point ?? null,
        shown: true,
      })
    }
    return label
  }

  // ---- 駅の構造 ----
  const { station, markers, plates } = buildStation(data, { floorY, pointPosition, register })
  scene.add(station, markers)

  // 1人称のときの駅の中（床・天井・壁・頭上サイン）。形は、その階に初めて入るときに作る
  const interior = createInterior({
    grids: area.grids,
    shapes: data.shapes,
    points: data.points,
    floorY,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
  })
  scene.add(interior.group)

  for (const { floor, corner } of plates) {
    const label = makeLabel(floor.name, 'floor-label', corner, [floor.id])
    label.element.style.background = floor.color
  }

  // 出口・建物の入口と改札の看板（1人称では天井 3m より下の吊り下げ位置に合わせる）
  for (const point of data.points) {
    if (!LABELED_TYPES.includes(point.type)) continue
    const height = point.type === 'exit' ? 3.8 : 2.2 // 3人称では出口を看板の上に出す
    const position = pointPosition(point.id).add(new THREE.Vector3(0, height, 0))
    const detail = !OVERVIEW_LABEL_TYPES.includes(point.type)
    makeLabel(point.name, `point-label point-label--${point.type}`, position, [point.floor], detail, {
      near: true,
      firstPersonY: floorY(point.floor) + 2.25,
      point,
    })
  }

  // 階段・エスカレーター・エレベーターの案内看板（「階段 ↑地上・1階」など）
  const connectorNames = { stairs: '階段', escalator: 'エスカレーター', elevator: 'エレベーター' }
  const connectorEnds = new Map()
  for (const point of data.points) {
    if (!point.connector) continue
    if (!connectorEnds.has(point.connector)) connectorEnds.set(point.connector, [])
    connectorEnds.get(point.connector).push(point)
  }
  for (const [a, b] of connectorEnds.values()) {
    if (!b || a.floor === b.floor) continue
    for (const [here, there] of [[a, b], [b, a]]) {
      const kind = connectorNames[here.type]
      if (!kind) continue
      const toFloor = floorById[there.floor]
      const arrow = toFloor.level > floorById[here.floor].level ? '↑' : '↓'
      const pos = pointPosition(here.id).add(new THREE.Vector3(0, 1.8, 0))
      makeLabel(
        `${kind} ${arrow}${toFloor.name}`,
        `point-label point-label--connector point-label--${here.type}`,
        pos,
        [here.floor],
        true,
        {
          near: true,
          nearDistance: { overview: 85, firstPerson: 28 },
          firstPersonY: floorY(here.floor) + 2.2,
        },
      )
    }
  }

  // 地下街・主な通路・建物のエリア案内看板（「八重洲地下街」「行幸通り地下通路」「丸ビル」など）
  const passageNodes = new Map()
  for (const point of data.points) {
    if (point.type !== 'node' || !point.passage || point.passage === '地下通路') continue
    const key = `${point.floor}:${point.passage}`
    if (!passageNodes.has(key)) passageNodes.set(key, [])
    passageNodes.get(key).push(point)
  }
  for (const nodes of passageNodes.values()) {
    if (nodes.length < 4) continue
    const floorId = nodes[0].floor
    const title = nodes[0].passage.replace(/の中$/, '')
    const cx = nodes.reduce((s, p) => s + p.x, 0) / nodes.length
    const cz = nodes.reduce((s, p) => s + p.z, 0) / nodes.length
    const center = nodes.reduce((best, p) =>
      Math.hypot(p.x - cx, p.z - cz) < Math.hypot(best.x - cx, best.z - cz) ? p : best)
    const y = floorY(floorId)
    makeLabel(title, 'passage-label', new THREE.Vector3(center.x, y + 4.6, center.z), [floorId], false, {
      near: true,
      nearDistance: { overview: 420, firstPerson: 55 },
      firstPersonY: y + 2.38,
    })
    // 長い地下街や連絡通路では、1人称で歩いている途中にも頭上看板を出す
    const picked = [center]
    for (const node of nodes) {
      if (picked.every((o) => Math.hypot(o.x - node.x, o.z - node.z) >= 85)) {
        picked.push(node)
        makeLabel(title, 'passage-label', new THREE.Vector3(node.x, y + 2.38, node.z), [floorId], true, {
          near: true,
          nearDistance: { overview: 0, firstPerson: 48 },
          firstPersonOnly: true,
          firstPersonY: y + 2.38,
        })
      }
    }
  }

  // ---- 経路 ----
  // 上から見るときの経路（太い線）と、一人称で歩くときの足元の経路（床の線と矢印）。
  // 上から見る線は、画面上の太さ（ピクセル）で描き、ほかの物に隠れないよう一番手前に出す
  // （駅が約2kmと広いので、メートルで太さを決めると全体を見たときに細すぎて見えないため）
  const routeTubes = new THREE.Group()
  const floorGuide = new THREE.Group()
  floorGuide.visible = false
  scene.add(routeTubes, floorGuide)

  const routeLineMaterial = new LineMaterial({ vertexColors: true, linewidth: 6, depthTest: false, transparent: true })
  const routeLine = { positions: [], colors: [] }
  const lineColor = new THREE.Color()

  function makeSegment(from, to, color) {
    routeLine.positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
    lineColor.set(color)
    routeLine.colors.push(lineColor.r, lineColor.g, lineColor.b, lineColor.r, lineColor.g, lineColor.b)
  }

  function finishRouteLine() {
    if (routeLine.positions.length === 0) return
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(routeLine.positions)
    geometry.setColors(routeLine.colors)
    const line = new LineSegments2(geometry, routeLineMaterial)
    line.renderOrder = 10 // 半透明の床や部屋より後に描く
    routeTubes.add(line)
    routeLine.positions = []
    routeLine.colors = []
  }

  // 床に引く経路の線と、進む向きの矢印（4mごと）
  const guideMaterial = new THREE.MeshBasicMaterial({ color: ROUTE_COLOR })
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })
  const arrowGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0.35, 0, 0), new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(-0.25, 0, 0.25),
  ])
  arrowGeometry.setIndex([0, 1, 2])

  function makeFloorGuide(from, to) {
    floorGuide.add(boxBetween(from, to, 0.04, 0.6, guideMaterial))
    const length = from.distanceTo(to)
    const rotation = orientationAlong(from, to)
    for (let d = 2; d < length; d += 4) {
      const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial)
      arrow.position.copy(from).lerp(to, d / length).add(new THREE.Vector3(0, 0.03, 0))
      arrow.quaternion.copy(rotation)
      floorGuide.add(arrow)
    }
  }

  const lift = new THREE.Vector3(0, 1.2, 0) // 床や階段の段に埋もれないよう浮かせる
  let moveLabels = [] // 「↓ 地下1階へ」の文字（描き直すときに消す）

  function drawRoute(path) {
    requestRender()
    // 前のルートを消す（形のデータも解放する。矢印の形は使い回しているので残す）
    for (const group of [routeTubes, floorGuide]) {
      for (const child of group.children) {
        if (child.geometry !== arrowGeometry) child.geometry.dispose()
      }
      group.clear()
    }
    for (const label of moveLabels) scene.remove(label)
    moveLabels = []

    const routePoints = path.map((id) => pointById[id])
    for (let i = 0; i < routePoints.length - 1; i++) {
      const from = routePoints[i]
      const to = routePoints[i + 1]
      const a = pointPosition(from.id).add(lift)
      const b = pointPosition(to.id).add(lift)

      // 足元の線。階段では段の角に埋もれないよう少し浮かせる
      const guideLift = new THREE.Vector3(0, from.floor === to.floor ? 0.06 : 0.45, 0)
      makeFloorGuide(pointPosition(from.id).add(guideLift), pointPosition(to.id).add(guideLift))

      if (from.floor === to.floor) {
        makeSegment(a, b, ROUTE_COLOR)
      } else {
        // 階をまたぐ移動は色を変え、「↑ 1階へ」のように表示する
        makeSegment(a, b, MOVE_COLOR)
        const toFloor = floorById[to.floor]
        const arrow = toFloor.level > floorById[from.floor].level ? '↑' : '↓'
        const middle = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 1.5, 0))
        moveLabels.push(makeLabel(`${arrow} ${toFloor.name}へ`, 'move-label', middle))
      }
    }
    finishRouteLine()
  }

  // 今どのステップにいるかを示す目印
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(2, 24, 24),
    new THREE.MeshStandardMaterial({ color: '#facc15', emissive: '#a16207' }),
  )
  marker.visible = false
  scene.add(marker)

  // 自分の位置の目印（人の形：胴体と頭＋向いている方向の矢印）。3人称のときだけ出す
  const selfMaterial = new THREE.MeshStandardMaterial({ color: SELF_COLOR, emissive: '#1e3a8a' })
  const selfMarker = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 3, 16), selfMaterial)
  body.position.y = 1.5
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 16), selfMaterial)
  head.position.y = 3.8
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 12), selfMaterial)
  nose.rotation.x = -Math.PI / 2 // -Z（前）へ向ける
  nose.position.set(0, 1.8, -1.8)
  selfMarker.add(body, head, nose)
  scene.add(selfMarker)
  const selfLabel = makeLabel('自分', 'self-label', new THREE.Vector3())
  selfLabel.position.set(0, 6, 0)
  selfMarker.add(selfLabel)

  // ---- 階の強調 ----
  let floorFilter = null // 3人称で選んでいる階（null なら全階）

  // activeFloor が null のときは全部の階を濃く表示する
  function highlightFloor(activeFloor) {
    requestRender()
    const isActive = (floorIds) => !activeFloor || floorIds.includes(activeFloor)

    for (const item of fadeMaterials) {
      const active = isActive(item.floorIds)
      item.material.opacity = item.opacity * (active ? 1 : DIMMED.mesh)
      // 薄くした物が手前の物を隠さないよう、奥行きの書き込みをやめる
      item.material.depthWrite = active && item.depthWrite
    }
    for (const item of fadeLabels) {
      if (!activeFloor) {
        // 全体表示：細かい文字は隠し、出口と階の名前だけ出す
        item.shown = !item.detail
        item.element.style.opacity = 1
      } else {
        // 案内中の階の文字はすべて出し、ほかの階の細かい文字は隠す
        const active = isActive(item.floorIds)
        item.shown = active || !item.detail
        item.element.style.opacity = active ? 1 : DIMMED.label
      }
    }
  }

  // 文字を出すかどうかを、カメラからの距離も入れて決める（描くたびに呼ぶ）
  const labelPosition = new THREE.Vector3()
  function updateLabelVisibility() {
    for (const item of fadeLabels) {
      // 1人称で歩いているときだけの看板は、3人称では出さない
      let visible = item.shown && !(item.firstPersonOnly && mode === 'overview')
      if (visible && item.near) {
        item.label.getWorldPosition(labelPosition)
        const limit = mode === 'overview' ? item.nearDistance.overview : item.nearDistance.firstPerson
        visible = labelPosition.distanceTo(camera.position) < limit
      }
      item.label.visible = visible
    }
  }

  // ---- 3人称のカメラ ----
  // 全体表示で画面に入れる範囲。ふだんは駅全体、ルートを表示しているときはルートのまわり
  const stationBounds = new THREE.Box3().setFromObject(station)
  let bounds = stationBounds
  const overviewTarget = bounds.getCenter(new THREE.Vector3())
  let overviewDistance = 60

  function setOverviewBounds(box) {
    bounds = box
    bounds.getCenter(overviewTarget)
    overviewDistance = fitDistance()
  }
  let focused = false // 地点に寄っているか（false なら全体表示）

  function overviewDirection() {
    return camera.aspect < 1 ? OVERVIEW_DIRECTION.portrait : OVERVIEW_DIRECTION.landscape
  }

  // 画面の縦横比に合わせて、駅全体を囲む箱の角がすべて画面に入る距離を求める
  function fitDistance() {
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const tanHorizontal = tanVertical * camera.aspect

    // 全体表示のときのカメラの向き（前・右・上）
    const forward = overviewDirection().clone().negate()
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
    const up = new THREE.Vector3().crossVectors(right, forward)

    let distance = 0
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const corner = new THREE.Vector3(x, y, z).sub(overviewTarget)
          const depth = corner.dot(forward) // 中心より奥ならプラス
          distance = Math.max(
            distance,
            Math.abs(corner.dot(right)) / tanHorizontal - depth,
            Math.abs(corner.dot(up)) / tanVertical - depth,
          )
        }
      }
    }
    return distance * 1.05 // 端がぴったりにならないよう少し余白をとる
  }

  // カメラの移動先。null のときは利用者の操作に任せる
  let cameraGoal = null

  // direction を渡すと、カメラの向きもその方向へ戻す（省略すると今の向きのまま）
  function moveCameraTo(target, distance, direction = null) {
    cameraGoal = { target: target.clone(), distance, direction }
    requestRender()
  }

  // 利用者が操作し始めたら、自動の移動はやめる
  controls.addEventListener('start', () => {
    cameraGoal = null
  })

  function showOverview() {
    focused = false
    marker.visible = false
    highlightFloor(floorFilter)
    // 1人称で歩いている間に画面の大きさが変わっていることがあるので、ここで測り直す
    overviewDistance = fitDistance()
    moveCameraTo(overviewTarget, overviewDistance, overviewDirection())
  }

  // 地点に寄って、その階を強調する
  function focusOn(position, floor, showMarker) {
    focused = true
    highlightFloor(floor)
    marker.position.copy(position).add(new THREE.Vector3(0, 3, 0))
    marker.visible = showMarker
    moveCameraTo(position, FOCUS_DISTANCE)
  }

  // ---- 見え方の切り替え ----
  let mode = 'overview'
  let route = null // 表示しているルート（describeRoute の結果）
  let walkthrough = null

  // 自分の位置（自由に歩くとき・3人称の目印）
  const self = { x: 0, z: 0, floor: data.floors[0].id, yaw: null, pitch: 0 }
  let ride = null // 階段・エスカレーターで移動している最中 { from, to, t, length }
  let joystick = { x: 0, y: 0 }
  let lastConnectorLabel = null

  function placeSelfMarker() {
    selfMarker.position.set(self.x, floorY(self.floor), self.z)
    const along = self.yaw === null ? area.directionAt(self) : null
    selfMarker.rotation.y = self.yaw ?? Math.atan2(-along.x, -along.z)
    requestRender()
  }

  function setMode(next) {
    if (mode === 'route' && next !== 'route') walkthrough?.stop()
    mode = next
    const firstPerson = mode !== 'overview'
    controls.enabled = !firstPerson
    selfMarker.visible = mode === 'overview'
    routeTubes.visible = mode !== 'route'
    floorGuide.visible = mode === 'route'
    marker.visible = false
    container.classList.toggle('is-first-person', firstPerson)
    // 1人称では、上から見るための半透明の模型を隠し、駅の中の見た目にする
    station.visible = !firstPerson
    interior.group.visible = firstPerson
    scene.background = firstPerson ? walkBackground : overviewBackground
    scene.fog = firstPerson ? walkFog : null
    camera.near = firstPerson ? NEAR.firstPerson : NEAR.overview
    camera.fov = firstPerson ? WALK_FOV : overviewFov
    camera.updateProjectionMatrix()
    // 文字の高さを切り替える（1人称では天井 3m より下に下ろす）
    for (const item of fadeLabels) item.label.position.y = firstPerson ? item.firstPersonY : item.overviewY
    requestRender()
  }

  function backToOverview() {
    // 1人称から戻ったら、見ていた所の少し先を回転の中心にして、全体表示へ戻る
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    controls.target.copy(camera.position).add(forward.multiplyScalar(10))
    setMode('overview')
    showOverview()
  }

  // 自由に歩くときのカメラ
  function placeFreeCamera() {
    let position
    if (ride) {
      position = ride.fromPos.clone().lerp(ride.toPos, ride.t)
    } else {
      position = new THREE.Vector3(self.x, floorY(self.floor), self.z)
    }
    camera.position.copy(position).add(new THREE.Vector3(0, EYE_HEIGHT, 0))
    camera.quaternion.setFromEuler(new THREE.Euler(self.pitch, self.yaw, 0, 'YXZ'))
    selfMarker.position.set(self.x, floorY(self.floor), self.z)
    selfMarker.rotation.y = self.yaw ?? 0
    requestRender()
  }

  function notifyFreeWalk(force = false) {
    const connector = ride ? null : area.nearbyConnector(self)
    const label = connector?.label ?? null
    if (!force && label === lastConnectorLabel) return
    lastConnectorLabel = label
    onFreeWalk({ floor: floorById[self.floor], connector: label })
  }

  function updateFreeWalk(delta) {
    if (ride) {
      ride.t = Math.min(1, ride.t + (RIDE_SPEED * delta) / ride.length)
      if (ride.t >= 1) {
        // 着いた所が壁ぎわのときは、少し離れた歩ける所に立つ
        Object.assign(self, area.settle({ x: ride.to.x, z: ride.to.z, floor: ride.to.floor }))
        ride = null
        highlightFloor(self.floor)
        notifyFreeWalk(true)
      }
      placeFreeCamera()
      return
    }
    if (joystick.x === 0 && joystick.y === 0) return
    // スティックの上が前、右が右。向いている方向に合わせて動かす
    const forward = { x: -Math.sin(self.yaw), z: -Math.cos(self.yaw) }
    const right = { x: Math.cos(self.yaw), z: -Math.sin(self.yaw) }
    const step = FREE_SPEED * delta
    const dx = (forward.x * joystick.y + right.x * joystick.x) * step
    const dz = (forward.z * joystick.y + right.z * joystick.x) * step
    Object.assign(self, area.move(self, dx, dz))
    placeFreeCamera()
    notifyFreeWalk()
  }

  // ---- 1人称のときは、ドラッグで見回す（地図を回す OrbitControls は止めている） ----
  let lookPointer = null
  let tapStart = null
  renderer.domElement.addEventListener('pointerdown', (event) => {
    tapStart = { id: event.pointerId, x: event.clientX, y: event.clientY }
    if (mode === 'overview') return
    lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
    renderer.domElement.setPointerCapture(event.pointerId)
  })
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!lookPointer || event.pointerId !== lookPointer.id) return
    // 画面の高さぶんドラッグすると、視野角（縦）ぶん向きが変わる。景色が指についてくる動きになる
    const perPixel = THREE.MathUtils.degToRad(camera.fov) / container.clientHeight
    const dYaw = (event.clientX - lookPointer.x) * perPixel
    const dPitch = (event.clientY - lookPointer.y) * perPixel
    if (mode === 'route') {
      walkthrough?.look(dYaw, dPitch)
    } else {
      self.yaw += dYaw
      self.pitch = THREE.MathUtils.clamp(self.pitch + dPitch, -MAX_PITCH, MAX_PITCH)
      placeFreeCamera()
    }
    lookPointer.x = event.clientX
    lookPointer.y = event.clientY
  })
  const endLook = (event) => {
    if (tapStart && event.pointerId === tapStart.id) {
      const moved = Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y)
      tapStart = null
      // ドラッグではなくタップ（移動が 6px 未満）のとき、押した位置にある地点ラベルを選ぶ
      if (moved < 6 && event.type === 'pointerup') {
        let hit = null
        for (const item of fadeLabels) {
          if (!item.point || !item.label.visible || Number(item.element.style.opacity) < 0.5) continue
          const r = item.element.getBoundingClientRect()
          if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
            const d = Math.hypot(event.clientX - (r.left + r.width / 2), event.clientY - (r.top + r.height / 2))
            if (!hit || d < hit.d) hit = { point: item.point, d }
          }
        }
        if (hit) onSelectPoint(hit.point)
      }
    }
    if (!lookPointer || event.pointerId !== lookPointer.id) return
    lookPointer = null
    if (mode === 'route') walkthrough?.endLook()
  }
  renderer.domElement.addEventListener('pointerup', endLook)
  renderer.domElement.addEventListener('pointercancel', endLook)

  // ---- 画面サイズへの対応と描画 ----
  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (width === 0 || height === 0) return
    renderer.setSize(width, height)
    labelRenderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    requestRender()

    if (mode !== 'overview') return
    overviewDistance = fitDistance()
    if (!focused) moveCameraTo(overviewTarget, overviewDistance, overviewDirection())
  }
  new ResizeObserver(resize).observe(container)
  resize()

  // 経過時間を測る。タブが裏に回っている間の時間は数えない（戻ったときにカメラが飛ばないように）
  const timer = new THREE.Timer()
  timer.connect(document)

  function animate(timestamp) {
    timer.update(timestamp)
    // 経過時間で進めるので、画面の更新速度が違う端末でも同じ速さで動く
    const delta = Math.min(timer.getDelta(), 0.1)
    if (paused) return
    if (mode === 'route') {
      // ルートに沿って歩いている間は、カメラは walkthrough が動かす
      walkthrough?.update(delta)
      render()
      return
    }
    if (mode === 'free') {
      updateFreeWalk(delta)
      if (needsRender) render()
      return
    }
    if (cameraGoal) {
      // 注目点と距離を少しずつ目標へ近づけ、なめらかに移動させる
      const amount = reduceMotion.matches ? 1 : 1 - Math.exp(-delta * 5)
      const offset = camera.position.clone().sub(controls.target)
      controls.target.lerp(cameraGoal.target, amount)
      const distance = THREE.MathUtils.lerp(offset.length(), cameraGoal.distance, amount)
      const direction = offset.normalize()
      if (cameraGoal.direction) direction.lerp(cameraGoal.direction, amount).normalize()
      camera.position.copy(controls.target).add(direction.clone().multiplyScalar(distance))

      const arrived =
        controls.target.distanceTo(cameraGoal.target) < 0.01 &&
        Math.abs(distance - cameraGoal.distance) < 0.01 &&
        (!cameraGoal.direction || direction.distanceTo(cameraGoal.direction) < 0.001)
      if (arrived) cameraGoal = null
      needsRender = true
    }
    // 指を離したあとの慣性で動いている間も、update が true を返す
    if (controls.update()) needsRender = true
    if (needsRender) render()
  }
  renderer.setAnimationLoop(animate)

  const cameraForward = new THREE.Vector3()
  function render() {
    needsRender = false
    if (mode !== 'overview') {
      // 目の高さがどの階にもないとき（階の間を移動している間）は天井を隠す
      const { x, y, z } = camera.position
      const floor = data.floors.find((f) => Math.abs(y - EYE_HEIGHT - floorY(f.id)) < 0.5)
      interior.showCeilings(Boolean(floor))
      const outdoor = floor && cellAt(area.grids.get(floor.id), x, z) & OUTDOOR
      scene.background = outdoor ? skyColor : walkBackground
      walkFog.color.copy(scene.background)
    }
    updateLabelVisibility()
    renderer.render(scene, camera)
    labelRenderer.render(scene, camera)

    // カメラが向いている方角から、画面上で北（+X）がどの角度になるかを知らせる（コンパス表示用）
    cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion)
    if (Math.hypot(cameraForward.x, cameraForward.z) > 1e-4) {
      onCameraChange((-Math.atan2(cameraForward.z, cameraForward.x) * 180) / Math.PI)
    }
  }

  // 最初はアニメーションせず、全体が見える位置にすぐ置く
  highlightFloor(null)
  controls.target.copy(overviewTarget)
  camera.position.copy(overviewTarget).add(overviewDirection().clone().multiplyScalar(overviewDistance))

  // 開発中だけ、ブラウザのコンソールから中身を見られるようにする（動作確認用）
  if (import.meta.env.DEV) {
    // animate(時刻) を呼ぶと1コマ進む（タブが裏にあって描画が止まっているときの確認用）
    window.__map = {
      THREE, scene, camera, controls, renderer, animate, render, interior, area,
      get bounds() { return bounds },
      get overviewDistance() { return overviewDistance },
    }
  }

  // ---- 画面から使う関数 ----
  return {
    get mode() {
      return mode
    },

    /** ほかの画面で隠れている間は描かない */
    setPaused(value) {
      paused = value
      if (!value) {
        resize()
        requestRender()
      }
    },

    /** 自分の位置を地点に置く（出発地点を選んだときなど） */
    placeSelfAt(pointId) {
      Object.assign(self, area.startAt(pointId), { yaw: null, pitch: 0 })
      placeSelfMarker()
    },

    get selfFloor() {
      return floorById[self.floor]
    },

    /** 3人称で強調する階を切り替える（null なら全階） */
    setFloorFilter(floorId) {
      floorFilter = floorId || null
      if (mode === 'overview') highlightFloor(floorFilter)
    },

    get floorFilter() {
      return floorFilter
    },

    /** 3人称で指定した地点に寄る */
    focusPoint(pointId) {
      const point = pointById[pointId]
      if (!point) return
      if (mode !== 'overview') setMode('overview')
      focusOn(pointPosition(pointId), point.floor, true)
    },

    /** 北が上になる向きへカメラを戻す */
    resetNorth() {
      if (mode === 'overview') {
        const distance = camera.position.distanceTo(controls.target)
        moveCameraTo(controls.target, distance, new THREE.Vector3(-40, 30, 0).normalize())
      } else if (mode === 'free') {
        self.yaw = -Math.PI / 2
        self.pitch = 0
        placeFreeCamera()
      }
    },

    /** 3人称の全体表示 */
    showOverview() {
      if (mode !== 'overview') backToOverview()
      else showOverview()
    },


    /** 3人称で、ルートの index 番目のステップの地点に寄る */
    focusStep(index) {
      if (!route) return
      if (mode !== 'overview') setMode('overview')
      const id = route.steps[index].point
      focusOn(pointPosition(id), pointById[id].floor, true)
    },

    /** 拡大（factor < 1）・縮小（factor > 1） */
    zoom(factor) {
      if (mode === 'overview') {
        cameraGoal = null
        const offset = camera.position.clone().sub(controls.target)
        const distance = THREE.MathUtils.clamp(offset.length() * factor, MIN_DISTANCE, overviewDistance * 1.5)
        moveCameraTo(controls.target, distance)
      } else {
        camera.fov = THREE.MathUtils.clamp(camera.fov * factor, ...FOV_RANGE)
        camera.updateProjectionMatrix()
        requestRender()
      }
    },

    // ---- 自由に歩く（トップ画面の1人称） ----
    startFreeWalk() {
      interior.ensureFloor(self.floor)
      setMode('free')
      ride = null
      // まだ向きを決めていないときは、近くの通路がのびる方向を向いて始める
      if (self.yaw === null) {
        const along = area.directionAt(self)
        self.yaw = Math.atan2(-along.x, -along.z)
        self.pitch = 0
      }
      highlightFloor(self.floor)
      placeFreeCamera()
      notifyFreeWalk(true)
    },

    /** スティックの傾き（x: 右がプラス、y: 上がプラス。どちらも -1〜1） */
    setJoystick(x, y) {
      joystick = { x, y }
    },

    /** 近くの階段・エスカレーターで、別の階へ移動する */
    rideConnector() {
      const connector = area.nearbyConnector(self)
      if (!connector || ride) return
      const fromPos = pointPosition(connector.from.id)
      const toPos = pointPosition(connector.to.id)
      interior.ensureFloor(connector.to.floor)
      ride = { to: connector.to, fromPos, toPos, t: 0, length: Math.max(1, fromPos.distanceTo(toPos)) }
      // 進む方向を向く（エレベーターは真上・真下に動くので、向きはそのまま）
      if (Math.hypot(toPos.x - fromPos.x, toPos.z - fromPos.z) > 0.1) {
        self.yaw = Math.atan2(-(toPos.x - fromPos.x), -(toPos.z - fromPos.z))
      }
      self.pitch = 0
      notifyFreeWalk(true)
    },

    // ---- ルート ----
    /** ルート（describeRoute の結果）を表示する。null なら消す */
    setRoute(nextRoute) {
      if (mode === 'route') backToOverview()
      route = nextRoute
      drawRoute(route ? route.path : [])
      // 「全体を見る」では、ルートのまわりだけを映す（駅全体だと広すぎてルートが見えないため）
      if (route) {
        floorFilter = null
        const box = new THREE.Box3()
        for (const id of route.path) box.expandByPoint(pointPosition(id))
        box.expandByVector(new THREE.Vector3(ROUTE_MARGIN, 5, ROUTE_MARGIN))
        setOverviewBounds(box)
      } else {
        setOverviewBounds(stationBounds)
      }
      walkthrough = route
        ? createWalkthrough({
            camera,
            nodes: route.path.map((id) => ({ position: pointPosition(id), floor: pointById[id].floor })),
            stepNodes: route.steps.map((step) => Math.max(0, route.path.indexOf(step.point))),
            onUpdate: (state) => {
              if (state.active && !state.progressOnly) highlightFloor(state.floor)
              onRouteWalk(state)
            },
          })
        : null
    },

    /** ルートに沿って1人称で歩く（stepIndex 番目のステップから） */
    startRouteWalk(stepIndex = 0) {
      if (!walkthrough) return
      cameraGoal = null
      for (const id of route.path) interior.ensureFloor(pointById[id].floor)
      setMode('route')
      walkthrough.start(stepIndex)
    },

    get walkthrough() {
      return walkthrough
    },
  }
}
