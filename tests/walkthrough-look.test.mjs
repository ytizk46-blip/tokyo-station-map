// 一人称ウォークスルーの「見回し」のテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createWalkthrough } from '../src/walkthrough.js'

// 北（+X）へまっすぐ進むだけのルート
function setup() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000)
  const walkthrough = createWalkthrough({
    camera,
    nodes: [
      { position: new THREE.Vector3(0, 0, 0), floor: '1F' },
      { position: new THREE.Vector3(100, 0, 0), floor: '1F' },
    ],
    stepNodes: [0, 1],
    onUpdate: () => {},
  })
  walkthrough.start(0)
  return { camera, walkthrough }
}

// カメラが向いている方向
const forwardOf = (camera) => new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)

test('見回していないときは進行方向を向く', () => {
  const { camera } = setup()
  assert.ok(forwardOf(camera).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6)
})

test('左へ90度見回すと西（-Z）を向き、上へ見回すと上を向く', () => {
  const { camera, walkthrough } = setup()
  walkthrough.look(Math.PI / 2, 0)
  walkthrough.update(1 / 30)
  assert.ok(forwardOf(camera).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6)

  walkthrough.look(0, 0.3)
  walkthrough.update(1 / 30)
  assert.ok(forwardOf(camera).y > 0.2)
})

test('上下は60度までしか向けない', () => {
  const { camera, walkthrough } = setup()
  walkthrough.look(0, 10)
  walkthrough.update(1 / 30)
  assert.ok(Math.abs(Math.asin(forwardOf(camera).y) - THREE.MathUtils.degToRad(60)) < 1e-6)
})

test('指を離して少したつと、進行方向へ視線が戻る', () => {
  const { camera, walkthrough } = setup()
  walkthrough.togglePlay() // 一時停止（止まっていても戻る）
  walkthrough.look(1, 0.5)
  walkthrough.update(1 / 30)
  walkthrough.endLook()

  for (let t = 0; t < 1; t += 1 / 30) walkthrough.update(1 / 30)
  assert.ok(forwardOf(camera).x < 0.9, '1秒後はまだ見回したまま')

  for (let t = 0; t < 6; t += 1 / 30) walkthrough.update(1 / 30)
  assert.ok(forwardOf(camera).x > 0.999, '数秒後には進行方向に戻る')
})

test('指で触れている間は、視線を戻さない', () => {
  const { camera, walkthrough } = setup()
  walkthrough.look(1, 0)
  for (let t = 0; t < 6; t += 1 / 30) walkthrough.update(1 / 30)
  assert.ok(forwardOf(camera).x < 0.6)
})
