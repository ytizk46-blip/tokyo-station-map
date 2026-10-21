// 行き先の検索のテスト（実行: npm test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import station from '../src/data/tokyo.json' with { type: 'json' }
import data from '../src/data/tokyo-3d.json' with { type: 'json' }
import { listDestinations, searchDestinations } from '../src/places.js'

const destinations = listDestinations(station)

test('行き先は出口・入口と建物をすべて含み、どれも3Dデータの出口につながる', () => {
  assert.equal(destinations.length, station.exits.length + station.places.length)
  assert.equal(station.places.length, 15, '周辺の15ビルすべてが登録されている')
  for (const d of destinations) {
    assert.ok(data.destinations.includes(d.exitId), d.name)
    if (d.kind === 'place') {
      assert.ok(Array.isArray(d.exitIds) && d.exitIds.length >= 1, `${d.name} に exitIds がある`)
      for (const id of d.exitIds) assert.ok(data.destinations.includes(id), `${d.name}: ${id}`)
    }
  }
  assert.equal(new Set(destinations.map((d) => d.id)).size, destinations.length, 'id は重ならない')
})

test('ひらがな・カタカナ・全角の違いがあっても見つかり、出口が先に並ぶ', () => {
  assert.ok(searchDestinations(destinations, 'きって').some((d) => d.name === 'KITTE'))
  assert.ok(searchDestinations(destinations, 'キッテ').some((d) => d.name === 'KITTE'))
  assert.ok(searchDestinations(destinations, 'いーよ').some((d) => d.name === 'イーヨ'))
  assert.ok(searchDestinations(destinations, 'いとしあ').some((d) => d.name === '有楽町イトシア'))
  assert.ok(searchDestinations(destinations, 'てっこうびる').some((d) => d.name === '鉄鋼ビルディング'))
  assert.ok(searchDestinations(destinations, 'ぶりっくすくえあ').some((d) => d.name === '丸の内ブリックスクエア'))
  assert.ok(searchDestinations(destinations, 'ｍ７').some((d) => d.name.startsWith('M7出口')), '全角で入力しても見つかる')
  const kitte = searchDestinations(destinations, 'KITTE')
  assert.equal(kitte[0].kind, 'exit')
  assert.equal(kitte[kitte.length - 1].kind, 'place')

  // 「A1」で検索したとき、A10〜A14に埋もれず「A1出口」が先頭に出る
  const a1 = searchDestinations(destinations, 'A1')
  assert.ok(a1[0].name.startsWith('A1出口（'), `A1 の先頭: ${a1[0].name}`)

  // 入口が8件以上ある「丸ビル」「新丸ビル」でも、建物（place）自体が候補に含まれる
  const marubiru = searchDestinations(destinations, '丸ビル')
  assert.ok(marubiru.some((d) => d.kind === 'place' && d.name === '丸ビル'))
  const shinmaru = searchDestinations(destinations, '新丸ビル')
  assert.ok(shinmaru.some((d) => d.kind === 'place' && d.name === '新丸ビル'))

  assert.deepEqual(searchDestinations(destinations, '   '), [])
})
