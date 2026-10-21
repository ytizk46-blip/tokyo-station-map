// 一人称ウォークスルーの動き（カメラの移動）のテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { byId, data, originNamed, pointNamed } from './helpers.mjs'
import { describeRoute, findRoute } from '../src/route-finder.js'
import { createWalkthrough } from '../src/walkthrough.js'

const floorY = (id) => data.floors.find((f) => f.id === id).level * data.floorGap

// 改札の名前と行き先の名前（どちらも先頭の部分）からルートを作る
function setup(originName, destinationName) {
  const origin = originNamed(originName)
  const route = describeRoute(data, findRoute(data, origin.point, pointNamed(destinationName).id), origin)
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000)
  const states = []
  const walkthrough = createWalkthrough({
    camera,
    nodes: route.path.map((id) => ({ position: new THREE.Vector3(byId[id].x, floorY(byId[id].floor), byId[id].z), floor: byId[id].floor })),
    stepNodes: route.steps.map((s) => route.path.indexOf(s.point)),
    onUpdate: (state) => states.push(state),
  })
  return { route, camera, states, walkthrough }
}

// time 秒ぶん、30コマ/秒で進める
function run(walkthrough, time) {
  for (let t = 0; t < time; t += 1 / 30) walkthrough.update(1 / 30)
}

test('最後まで歩くと目的地に着いて止まり、ステップは順に進む', () => {
  const { route, states, walkthrough } = setup('JR 丸の内地下中央口', 'KITTEの入口（JR東京駅）')
  walkthrough.start(0)
  run(walkthrough, 300)
  const last = states[states.length - 1]
  assert.equal(last.finished, true)
  assert.equal(last.playing, false)
  assert.equal(last.step, route.steps.length - 1)

  const steps = states.filter((s) => !s.progressOnly).map((s) => s.step)
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'ステップは戻らない')
})

test('一時停止中は進まない', () => {
  const { camera, walkthrough } = setup('JR 丸の内地下中央口', 'KITTEの入口（JR東京駅）')
  walkthrough.start(0)
  run(walkthrough, 3)
  walkthrough.togglePlay()
  const before = camera.position.clone()
  run(walkthrough, 5)
  assert.ok(camera.position.distanceTo(before) < 1e-6)
})

test('終了すると視野角が元に戻る', () => {
  const { camera, walkthrough } = setup('JR 八重洲北口', '丸ビルの入口（大名小路東京駅側）')
  const fov = camera.fov
  walkthrough.start(0)
  assert.notEqual(camera.fov, fov)
  walkthrough.stop()
  assert.equal(camera.fov, fov)
  assert.equal(walkthrough.active, false)
})

test('ステップを選ぶとその地点へ移動する', () => {
  const { route, camera, walkthrough } = setup('JR 八重洲地下中央口', 'M7出口')
  walkthrough.start(0)
  const index = route.steps.length - 1
  walkthrough.jumpToStep(index)
  const point = byId[route.steps[index].point]
  assert.ok(Math.hypot(camera.position.x - point.x, camera.position.z - point.z) < 1e-6)
})

test('終点で「もう一度」を押すと、見回しを戻して最初のステップで少し止まってから歩き出す', () => {
  const { route, camera, states, walkthrough } = setup('JR 丸の内地下中央口', 'KITTEの入口（JR東京駅）')
  walkthrough.start(0)
  run(walkthrough, 300)
  assert.equal(states[states.length - 1].finished, true)

  // 見回してカメラの角度を変える
  walkthrough.look(Math.PI / 4, 0.2)
  walkthrough.update(0)
  const lookQuaternion = camera.quaternion.clone()

  // 終点で「もう一度」（togglePlay）を押す
  walkthrough.togglePlay()
  const restarted = states[states.length - 1]
  assert.equal(restarted.playing, true)
  assert.equal(restarted.finished, false)
  assert.equal(restarted.step, 0)

  // 視線が進行方向へリセットされていること
  assert.ok(camera.quaternion.angleTo(lookQuaternion) > 0.01)

  const startPoint = byId[route.path[0]]
  assert.ok(Math.hypot(camera.position.x - startPoint.x, camera.position.z - startPoint.z) < 1e-6)
  // 最初の 0.5 秒はまだ出発地点で立ち止まっている
  walkthrough.update(0.5)
  assert.ok(Math.hypot(camera.position.x - startPoint.x, camera.position.z - startPoint.z) < 1e-6)
})
