// 1人称で歩ける場所を表すマス目（0.5m 四方）。画面や Three.js には依存しない。
// マス目は tools/build-tokyo-3d.mjs が床・部屋・柱の形とルートの線から作り、data.walkGrid に入れる。
//
// マスの値はビットの組み合わせ：
//   WALK    … 歩ける
//   LOW     … 階段・エスカレーターの穴（歩けない。まわりの壁を低い手すりにする）
//   OUTDOOR … 屋外（天井を付けない）
//   FIXTURE … 柱・壁（歩けない。見た目は元データの形で描くので、マス目からは壁を作らない）
// 番号の付け方：i は X（北）の向き、j は Z（東）の向き。マス (i, j) の中心は (x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell)

export const WALK = 1
export const LOW = 2
export const OUTDOOR = 4
export const FIXTURE = 8

/**
 * マスの値の並び（Uint8Array）を、ファイルを小さくするため「値・続く数」の組の並びにして base64 にする。
 * 続く数は 7ビットずつに分けて書く（最上位ビットが 1 なら次のバイトに続く）。
 * build スクリプト（Node.js）で使う（Buffer は Node.js にしかないため）
 */
export function encodeCells(cells) {
  const bytes = []
  for (let k = 0; k < cells.length;) {
    const value = cells[k]
    let run = 1
    while (k + run < cells.length && cells[k + run] === value) run++
    bytes.push(value)
    let n = run
    while (n >= 0x80) {
      bytes.push((n & 0x7f) | 0x80)
      n >>>= 7
    }
    bytes.push(n)
    k += run
  }
  return Buffer.from(bytes).toString('base64')
}

function decodeCells(text, length) {
  const binary = atob(text)
  const cells = new Uint8Array(length)
  let k = 0
  for (let p = 0; p < binary.length;) {
    const value = binary.charCodeAt(p++)
    let run = 0
    for (let shift = 0; ; shift += 7) {
      const byte = binary.charCodeAt(p++)
      run += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) break
    }
    cells.fill(value, k, k + run)
    k += run
  }
  return cells
}

/** data.walkGrid を、階の ID → マス目 { x0, z0, rows, cols, cell, cells } にする */
export function decodeWalkGrid(walkGrid) {
  const grids = new Map()
  for (const [floor, g] of Object.entries(walkGrid.floors)) {
    grids.set(floor, { ...g, cell: walkGrid.cell, cells: decodeCells(g.runs, g.rows * g.cols) })
  }
  return grids
}

/** 位置 (x, z) のマスの値（マス目の外は 0） */
export function cellAt(grid, x, z) {
  const i = Math.floor((x - grid.x0) / grid.cell)
  const j = Math.floor((z - grid.z0) / grid.cell)
  if (i < 0 || j < 0 || i >= grid.rows || j >= grid.cols) return 0
  return grid.cells[i * grid.cols + j]
}

/**
 * (x, z) からいちばん近い、歩けるマスの中心。maxDistance（m）以内になければ null。
 * accept(x, z) を渡すと、それが true になるマスだけを選ぶ（体がおさまるかを調べるときなど）
 */
export function nearestWalkable(grid, x, z, maxDistance = 10, accept = () => true) {
  const i0 = Math.floor((x - grid.x0) / grid.cell)
  const j0 = Math.floor((z - grid.z0) / grid.cell)
  const reach = Math.ceil(maxDistance / grid.cell)
  let best = null
  // 近い輪から順に調べる。見つかった輪の次の輪までは、もっと近いマスがあるかもしれないので調べる
  for (let r = 0; r <= reach; r++) {
    if (best && r > best.ring + 1) break
    for (let i = i0 - r; i <= i0 + r; i++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue
        if (i < 0 || j < 0 || i >= grid.rows || j >= grid.cols) continue
        if (!(grid.cells[i * grid.cols + j] & WALK)) continue
        const cx = grid.x0 + (i + 0.5) * grid.cell
        const cz = grid.z0 + (j + 0.5) * grid.cell
        const d = Math.hypot(cx - x, cz - z)
        if ((!best || d < best.d) && accept(cx, cz)) best = { x: cx, z: cz, d, ring: r }
      }
    }
  }
  return best && best.d <= maxDistance ? { x: best.x, z: best.z } : null
}
