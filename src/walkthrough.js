import * as THREE from 'three'

// 一人称視点で、ルートに沿って歩く

const EYE_HEIGHT = 1.6 // 目の高さ（m）
const WALK_FOV = 70 // 一人称のときの視野角（人の見え方に近づけて広めにする）
const LOOK_AHEAD = 8 // この距離だけ先の経路を見ながら歩く（m）
const BASE_SPEED = 4 // 歩く速さ（m/秒）。実際（約1.3m/秒）より速めにしている
export const SPEEDS = [1, 2, 4] // 速さの倍率
const STEP_PAUSE = 1.2 // 道順の各ステップで立ち止まる時間（秒）
const UP = new THREE.Vector3(0, 1, 0)

// 見回し（ドラッグで視線を動かす）
const MAX_PITCH = THREE.MathUtils.degToRad(60) // 上下に向けられる角度の限度
const LOOK_RETURN_DELAY = 1.5 // 指を離してから、進行方向へ視線を戻し始めるまでの時間（秒）
const LOOK_RETURN_SPEED = 2 // 視線を戻す速さ（大きいほど速く戻る）

/**
 * @param camera 動かすカメラ
 * @param nodes ルートの地点の並び [{ position: Vector3（床の高さ）, floor }]
 * @param stepNodes 道順の各ステップが、nodes の何番目にあたるか
 * @param onUpdate 状態が変わるたびに呼ばれる関数
 */
export function createWalkthrough({ camera, nodes, stepNodes, onUpdate }) {
  // 各地点までの、出発地点からの道のり
  const eyes = nodes.map((node) => node.position.clone().add(new THREE.Vector3(0, EYE_HEIGHT, 0)))
  const distances = [0]
  for (let i = 1; i < eyes.length; i++) distances.push(distances[i - 1] + eyes[i - 1].distanceTo(eyes[i]))
  const total = distances[distances.length - 1]
  const stepDistances = stepNodes.map((i) => distances[i])

  const state = {
    active: false,
    playing: false,
    speedIndex: 0,
    distance: 0,
    pauseLeft: 0, // ステップで立ち止まっている残り時間
    savedFov: camera.fov,
    // 進行方向の向き（曲がるときになめらかに変わる）
    heading: new THREE.Quaternion(),
    // 見回しの角度（進行方向からのずれ）。yaw は左右（左がプラス）、pitch は上下（上がプラス）
    yaw: 0,
    pitch: 0,
    looking: false, // 指で見回している最中か
    lookIdle: 0, // 指を離してからの時間
  }

  // 道のり distance の位置にある区間の番号と、区間内の割合
  function segmentAt(distance) {
    let i = 0
    while (i < distances.length - 2 && distances[i + 1] < distance) i++
    const length = distances[i + 1] - distances[i]
    const t = length > 0 ? THREE.MathUtils.clamp((distance - distances[i]) / length, 0, 1) : 0
    return { i, t }
  }

  function positionAt(distance) {
    const { i, t } = segmentAt(distance)
    return eyes[i].clone().lerp(eyes[i + 1], t)
  }

  // 今いる階。階段の途中では、半分を過ぎたら行き先の階にする
  function floorAt(distance) {
    const { i, t } = segmentAt(distance)
    return t < 0.5 ? nodes[i].floor : nodes[i + 1].floor
  }

  // 今どのステップにいるか（通り過ぎた最後のステップ）
  function stepAt(distance) {
    let index = 0
    stepDistances.forEach((d, i) => {
      if (d <= distance + 0.01) index = i
    })
    return index
  }

  // 進む方向を見る向き
  function lookRotation(distance) {
    const position = positionAt(distance)
    let target = positionAt(Math.min(distance + LOOK_AHEAD, total))
    if (target.distanceTo(position) < 0.5) {
      // 終点では、最後の区間の向きのまま前を見る
      const last = eyes[eyes.length - 1].clone().sub(eyes[eyes.length - 2]).normalize()
      target = position.clone().add(last)
    }
    // 階段では足元に引っぱられすぎないよう、上下の向きは半分にする
    target.y = position.y + (target.y - position.y) * 0.5
    // エレベーターで真上・真下に動いている間は、向きを変えない
    if (Math.hypot(target.x - position.x, target.z - position.z) < 0.5) return null
    const matrix = new THREE.Matrix4().lookAt(position, target, UP)
    return new THREE.Quaternion().setFromRotationMatrix(matrix)
  }

  function notify(extra = {}) {
    onUpdate({
      active: state.active,
      playing: state.playing,
      speed: SPEEDS[state.speedIndex],
      progress: total > 0 ? state.distance / total : 1,
      step: stepAt(state.distance),
      floor: floorAt(state.distance),
      finished: state.distance >= total,
      ...extra,
    })
  }

  function placeCamera(instant, delta = 0) {
    camera.position.copy(positionAt(state.distance))
    const rotation = lookRotation(state.distance)
    // 向きが決まらない所（エレベーターの中）では、今の向きのまま
    if (rotation && instant) state.heading.copy(rotation)
    else if (rotation) state.heading.slerp(rotation, 1 - Math.exp(-delta * 4)) // 曲がるときもなめらかに向きを変える

    // 指を離して少したったら、見回した視線を進行方向へ戻す（迷わないように）
    if (!state.looking) {
      state.lookIdle += delta
      if (state.lookIdle > LOOK_RETURN_DELAY) {
        const keep = Math.exp(-delta * LOOK_RETURN_SPEED)
        state.yaw *= keep
        state.pitch *= keep
      }
    }

    // 進行方向の向きに、見回しの角度を足す
    const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'))
    camera.quaternion.copy(state.heading).multiply(look)
  }

  // 見回しの角度をなくして、進行方向を向く
  function resetLook() {
    state.yaw = 0
    state.pitch = 0
    state.looking = false
  }

  return {
    get active() {
      return state.active
    },

    start(stepIndex = 0) {
      state.active = true
      state.playing = true
      state.distance = stepDistances[stepIndex] ?? 0
      state.pauseLeft = STEP_PAUSE
      state.savedFov = camera.fov
      camera.fov = WALK_FOV
      camera.updateProjectionMatrix()
      resetLook()
      placeCamera(true)
      notify()
    },

    stop() {
      if (!state.active) return
      state.active = false
      state.playing = false
      camera.fov = state.savedFov
      camera.updateProjectionMatrix()
      notify()
    },

    togglePlay() {
      // 終点で再生したら、最初からやり直す
      if (state.distance >= total) {
        state.distance = 0
        state.pauseLeft = STEP_PAUSE
        resetLook()
        placeCamera(true)
      }
      state.playing = !state.playing
      notify()
    },

    nextSpeed() {
      state.speedIndex = (state.speedIndex + 1) % SPEEDS.length
      notify()
    },

    jumpToStep(stepIndex) {
      state.distance = stepDistances[stepIndex]
      state.pauseLeft = STEP_PAUSE
      resetLook()
      placeCamera(true)
      notify()
    },

    // 見回す。dYaw・dPitch は角度（ラジアン）の変化。左・上がプラス
    look(dYaw, dPitch) {
      if (!state.active) return
      state.looking = true
      state.lookIdle = 0
      // 左右は半周まで（それ以上は反対側から回したのと同じなので、戻るときに遠回りしないように）
      state.yaw = THREE.MathUtils.euclideanModulo(state.yaw + dYaw + Math.PI, Math.PI * 2) - Math.PI
      state.pitch = THREE.MathUtils.clamp(state.pitch + dPitch, -MAX_PITCH, MAX_PITCH)
    },

    // 指を離した
    endLook() {
      state.looking = false
      state.lookIdle = 0
    },

    // 毎フレーム呼ぶ
    update(delta) {
      if (!state.active) return
      if (state.playing) {
        if (state.pauseLeft > 0) {
          state.pauseLeft -= delta
        } else {
          const before = state.distance
          state.distance = Math.min(state.distance + BASE_SPEED * SPEEDS[state.speedIndex] * delta, total)

          // 次のステップの地点に着いたら、少し立ち止まる
          const reached = stepDistances.find((d) => before < d && d <= state.distance)
          if (reached !== undefined) {
            state.distance = reached
            state.pauseLeft = STEP_PAUSE
          }
          if (state.distance >= total) state.playing = false

          const stepChanged = stepAt(before) !== stepAt(state.distance)
          const floorChanged = floorAt(before) !== floorAt(state.distance)
          if (stepChanged || floorChanged || !state.playing) notify()
          else notify({ progressOnly: true })
        }
      }
      placeCamera(false, delta)
    },
  }
}
