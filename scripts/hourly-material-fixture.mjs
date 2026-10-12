import { lexicalTokens, SmallWordModel } from '../apps/desktop/core/hourly-language.mjs';
import { materialUnits, trainMaterials } from '../apps/desktop/core/hourly-materials.mjs';
export const hourlySourceMessages = [
  '夜空の星は古い望遠鏡を照らす。',
  '静かな森では小さな鳥が歌を覚える。',
  '青い時計は遠い砂漠を眺める。',
  '暖かい料理は大きな船を運ぶ。',
  '白い雲が珍しい音楽を集める。',
  '明るい太陽は不思議な野菜を作る。',
  '美しい花が図書館の秘密を調べる。',
  '丸い月は駅前の看板を描く。',
  '赤い自転車が銀色の橋を見つける。',
  '優しい猫は机の上の手紙を食べる。',
  '大きな山が緑の海を眺める。',
  '窓辺の犬は新しい写真を覚える。',
];
export function hourlySourceModel(analyzer, random = Math.random) {
  const model = new SmallWordModel(random);
  hourlySourceMessages.forEach((text, i) => { model.train(lexicalTokens(text, analyzer), String(i + 1)); trainMaterials(model, materialUnits(text, analyzer), String(i + 1)); });
  return model;
}
