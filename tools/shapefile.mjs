// Shapefile（.shp と .dbf）を読むだけの小さな部品。
// 東京駅のデータで使っている形（点・線・面）だけに対応する。
import { readFileSync } from 'node:fs'

// 文字は UTF-8 で入っている（.cpg ファイルは無い）
const utf8 = new TextDecoder('utf-8')

// .shp を読んで、図形の配列を返す。
// 点は [x, y]、線と面は「部品（点の並び）の配列」[[[x, y], ...], ...]
function readShp(path) {
  const buf = readFileSync(path)
  const shapes = []
  let pos = 100 // 最初の100バイトはファイル全体の情報
  while (pos < buf.length) {
    const length = buf.readInt32BE(pos + 4) * 2 // レコードの長さ（2バイト単位で入っている）
    const body = pos + 8
    const type = buf.readInt32LE(body)
    if (type === 0) {
      shapes.push(null)
    } else if (type === 1 || type === 11 || type === 21) {
      shapes.push([buf.readDoubleLE(body + 4), buf.readDoubleLE(body + 12)])
    } else if ([3, 5, 13, 15, 23, 25].includes(type)) {
      const numParts = buf.readInt32LE(body + 36)
      const numPoints = buf.readInt32LE(body + 40)
      const partsAt = body + 44
      const pointsAt = partsAt + numParts * 4
      const starts = []
      for (let i = 0; i < numParts; i++) starts.push(buf.readInt32LE(partsAt + i * 4))
      starts.push(numPoints)
      const parts = []
      for (let i = 0; i < numParts; i++) {
        const part = []
        for (let j = starts[i]; j < starts[i + 1]; j++) {
          part.push([buf.readDoubleLE(pointsAt + j * 16), buf.readDoubleLE(pointsAt + j * 16 + 8)])
        }
        parts.push(part)
      }
      shapes.push(parts)
    } else {
      throw new Error(`${path}: 対応していない図形の種類 ${type}`)
    }
    pos = body + length
  }
  return shapes
}

// .dbf を読んで、属性（項目名 → 値）の配列を返す
function readDbf(path) {
  const buf = readFileSync(path)
  const count = buf.readUInt32LE(4)
  const headerLength = buf.readUInt16LE(8)
  const recordLength = buf.readUInt16LE(10)
  const fields = []
  for (let at = 32; buf[at] !== 0x0d; at += 32) {
    const name = buf.toString('latin1', at, at + 11).replace(/\0.*$/, '')
    fields.push({ name, type: String.fromCharCode(buf[at + 11]), length: buf[at + 16] })
  }
  const rows = []
  for (let r = 0; r < count; r++) {
    let at = headerLength + r * recordLength + 1 // 先頭の1バイトは削除の印
    const row = {}
    for (const f of fields) {
      const text = utf8.decode(buf.subarray(at, at + f.length)).trim()
      at += f.length
      row[f.name] = f.type === 'N' || f.type === 'F' ? (text === '' ? null : Number(text)) : text
    }
    rows.push(row)
  }
  return rows
}

// 拡張子なしのパスを渡すと [{ geometry, properties }, ...] を返す
export function readShapefile(basePath) {
  const shapes = readShp(basePath + '.shp')
  const rows = readDbf(basePath + '.dbf')
  return shapes.map((geometry, i) => ({ geometry, properties: rows[i] }))
}
