const ID = 'pf2e-sandpoint-shops';
const ROOT = `modules/${ID}`;
const COPY = value => foundry.utils.deepClone(value);
const escape = value => foundry.utils.escapeHTML(String(value));

async function saveReport(name, data) {
  const picker = foundry.applications.apps.FilePicker.implementation;
  const target = `worlds/${game.world.id}/sandpoint-shops`;
  try {
    await picker.browse('data', target);
  } catch {
    await picker.createDirectory('data', target);
  }
  return picker.upload('data', target,
    new File([JSON.stringify(data, null, 2)], name, {type: 'application/json'}), {}, {notify: false});
}

function stockCopy(document, quantity = 1) {
  const data = document.toObject();
  delete data._id;
  data.system.quantity = quantity;
  data.system.containerId = null;
  data.system.equipped = {carryType: 'worn', invested: false};
  data.flags ??= {};
  data.flags[ID] = {source: document.uuid};
  return data;
}

async function prepareStock(shop, equipment, spellIndex, spellPack) {
  const rows = [];
  const get = async slug => {
    const entry = equipment.index.find(i => i.system?.slug === slug);
    if (!entry) throw new Error(`Предмет не найден: ${slug}`);
    const doc = await equipment.getDocument(entry._id);
    if (doc.level > 4 || doc.system.traits.rarity !== 'common') throw new Error(`Недоступный товар: ${doc.name}`);
    return doc;
  };
  for (const row of shop.stock) {
    const source = await get(row.slug);
    const data = stockCopy(source, row.quantity);
    if (shop.renames?.[row.slug]) data.name = shop.renames[row.slug];
    if (shop.id === '17' && data.system.traits.value.includes('alchemical')) {
      data.flags[ID].faultyShop = true;
      data.system.description.gm = `${data.system.description.gm ?? ''}<p>«Решения в склянках»: при использовании ведущий тайно совершает чистую проверку СЛ 2. При провале предмет не оказывает значимого эффекта. Проверка выполняется вручную с учётом поддержки лавки.</p>`;
    }
    rows.push(data);
  }
  for (const slug of shop.secretStock ?? []) {
    const data = stockCopy(await get(slug), 2);
    data.flags['item-piles'] = {item: {hidden: true, notForSale: true}};
    rows.push(data);
  }
  for (const custom of shop.custom) {
    const data = stockCopy(await get(custom.base), custom.quantity);
    data.name = custom.name;
    data.system.slug = null;
    data.system.price = {value: custom.price, per: 1};
    data.system.description.value = `<p>${escape(custom.description)}</p>`;
    data.system.rules = [];
    delete data._stats?.compendiumSource;
    rows.push(data);
  }
  for (const slug of shop.enchantedWeapons ?? []) {
    const source = await get(slug);
    const data = stockCopy(source);
    data.name = `${source.name} +1`;
    data.system.runes.potency = 1;
    data.system.level.value = 2;
    data.system.traits.value = [...new Set([...data.system.traits.value, 'magical'])];
    data.system.price = {value: {cp: source.price.copperValue + 3500}, per: 1};
    rows.push(data);
  }
  for (const scroll of shop.scrolls) {
    const entry = spellIndex.find(i => i.system?.slug === scroll.slug);
    if (!entry) throw new Error(`Заклинание не найдено: ${scroll.slug}`);
    const spell = await spellPack.getDocument(entry._id);
    if (spell.system.traits.rarity !== 'common' || spell.baseRank > scroll.rank) throw new Error(`Неверный свиток: ${spell.name}`);
    const base = await get(`scroll-of-${scroll.rank === 1 ? '1st' : '2nd'}-rank-spell`);
    const data = stockCopy(base, scroll.quantity);
    data.name = `Свиток: ${spell.name} (${scroll.rank}-й ранг)`;
    data.system.spell = spell.toObject();
    data.system.spell._id = foundry.utils.randomID();
    data.system.spell.system.location = {value: null, heightenedLevel: scroll.rank};
    data.system.traits.value = [...new Set([...data.system.traits.value, ...spell.system.traits.value])].sort();
    if (data.system.traits.value.some(t => ['arcane','divine','occult','primal'].includes(t))) data.system.traits.value = data.system.traits.value.filter(t => t !== 'magical');
    data.system.description.value = `<p>@UUID[${spell.uuid}]{${escape(spell.name)}}</p><hr>${data.system.description.value}`;
    rows.push(data);
  }
  return rows;
}

function description(shop) {
  return `<h2>${shop.id}. ${escape(shop.name)}</h2><p>${escape(shop.description)}</p>`
    + (shop.service ? '<p>Здесь оказывают услуги. Для оформления заказа обратитесь к ведущему.</p>'
      : '<p>Выберите своего персонажа в окне торговли. Покупка автоматически переносит вещь, списывает деньги и уменьшает остаток товара.</p>')
    + '<p>Сэндпойнт — поселение 4-го уровня. Ассортимент подготовлен для игры по описанию города; точное количество вещей определено ведущим.</p>';
}

function tokenData(shop, scene, anchor) {
  const size = scene.grid.size * 0.5;
  return {
    name: shop.name, actorLink: true, width: 0.5, height: 0.5,
    x: anchor.x - size / 2, y: anchor.y + 30,
    texture: {src: `${ROOT}/icons/shop-${shop.id}.svg`, scaleX: 1, scaleY: 1},
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL, hidden: false,
    sight: {enabled: false},
    flags: {world: {sandpointShop: {id: shop.id}}, pf2e: {linkToActorSize: false, autoscale: false}}
  };
}

export async function install(scene = canvas.scene) {
  if (!game.user.isGM) return ui.notifications.warn('Размещать магазины может ведущий.');
  if (!scene || !/sandpoint|с[эа]ндп[оой]/i.test(scene.name)) throw new Error('Откройте городскую карту Сэндпойнта.');
  if (!game.modules.get('item-piles')?.active || !game.modules.get('itempiles-pf2e')?.active || !game.itempiles?.API) throw new Error('Включите Item Piles и Item Piles: PF2e.');
  const response = await fetch(`${ROOT}/data/shops.json`);
  if (!response.ok) throw new Error('Не удалось прочитать ассортимент магазинов.');
  const {shops} = await response.json();
  const equipment = game.packs.get('pf2e.equipment-srd');
  const spellPack = game.packs.get('pf2e.spells-srd');
  await equipment.getIndex({fields: ['system.slug']});
  const spellIndex = await spellPack.getIndex({fields: ['system.slug']});
  const existing = new Map(game.actors.filter(a => a.flags.world?.sandpointShop?.id).map(a => [a.flags.world?.sandpointShop?.id, a]));
  const anchors = new Map();
  const prepared = new Map();
  ui.notifications.info('Подготавливаю магазины Сэндпойнта…');
  // Сначала проверяем все данные. Ошибка предмета не оставит половину магазинов.
  for (const shop of shops) {
    const anchor = scene.notes.get(shop.anchor) ?? scene.notes.find(n => n.text.toLowerCase() === shop.name.toLowerCase());
    if (!anchor) throw new Error(`На карте не найдена отметка: ${shop.name}`);
    anchors.set(shop.id, anchor);
    if (!existing.get(shop.id)?.flags.world?.sandpointShop?.stockInitialized) prepared.set(shop.id, await prepareStock(shop, equipment, spellIndex, spellPack));
  }
  if (!scene.getFlag('world', 'sandpointShops')) await saveReport(`scene-before-${scene.id}.json`, scene.toObject());
  for (const shop of shops) {
    const token = tokenData(shop, scene, anchors.get(shop.id));
    let actor = existing.get(shop.id);
    if (!actor) {
      const html = description(shop);
      await game.itempiles.API.createItemPile({
        sceneId: scene.id, createActor: true,
        folders: ['Магазины Сэндпойнта'],
        actorOverrides: {
          name: shop.name, type: 'loot', img: token.texture.src,
          system: {lootSheetType: 'Merchant', details: {description: html}},
          ownership: {default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED},
          prototypeToken: COPY(token), flags: {world: {sandpointShop: {id: shop.id, version: '0.1.2'}}}
        },
        tokenOverrides: token,
        itemPileFlags: {
          enabled: true, type: 'merchant', description: html, distance: 0,
          infiniteQuantity: false, infiniteCurrencies: true, purchaseOnly: true,
          buyPriceModifier: shop.discount, sellPriceModifier: 0.5,
          displayQuantity: 'yes', hideItemsWithZeroCost: true, keepZeroQuantity: true,
          merchantImage: token.texture.src, openTimes: {enabled: false, status: 'open'}
        },
        items: prepared.get(shop.id)
      });
      actor = game.actors.find(a => a.flags.world?.sandpointShop?.id === shop.id);
      if (!actor) throw new Error(`Не удалось создать магазин: ${shop.name}`);
      existing.set(shop.id, actor);
    }
    if (!actor.flags.world?.sandpointShop?.stockInitialized) {
      if (!actor.items.size && prepared.get(shop.id)?.length) await actor.createEmbeddedDocuments('Item', prepared.get(shop.id));
      await actor.update({'flags.world.sandpointShop.stockInitialized': true});
    }
    if (!scene.tokens.some(t => t.flags.world?.sandpointShop?.id === shop.id)) {
      const document = await actor.getTokenDocument(token);
      await scene.createEmbeddedDocuments('Token', [document.toObject()]);
    }
  }
  await scene.setFlag('world', 'sandpointShops', {version: '0.1.2', shops: shops.length});
  await scene.update({navigation: true});
  const report = shops.map(s => {
    const a = existing.get(s.id);
    return {id:s.id,name:s.name,actorId:a.id,items:a.items.size,tokenId:scene.tokens.find(t=>t.flags.world?.sandpointShop?.id===s.id)?.id};
  });
  await saveReport('install-report.json', {world:game.world.id,scene:scene.id,shops:report});
  ui.notifications.info(`На карте размещено ${report.length} торговых точек. Остатки существующих магазинов сохранены.`);
  return report;
}

Hooks.once('ready', async () => {
    const module = game.modules.get(ID);
    if (!module?.active) return;
    module.api = {install};
    if (!game.user.isGM || game.macros.some(m => m.getFlag(ID, 'installer'))) return;
    await Macro.create({name:'Магазины Сэндпойнта — разместить на карте',type:'script',img:`${ROOT}/icons/shop-26.svg`,
      command:`await (await import('/${ROOT}/scripts/shops.mjs')).install();`,flags:{[ID]:{installer:true}}});
});
