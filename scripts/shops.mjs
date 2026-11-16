const ID = 'pf2e-sandpoint-shops';
const ROOT = `modules/${ID}`;
const VERSION = '0.1.4';
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
  data._id = foundry.utils.randomID();
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
    data.flags[ID].stockKey = `item:${row.slug}`;
    if (shop.renames?.[row.slug]) data.name = shop.renames[row.slug];
    if (shop.id === '17' && data.system.traits.value.includes('alchemical')) {
      data.flags[ID].faultyShop = true;
      data.system.description.gm = `${data.system.description.gm ?? ''}<p>«Решения в склянках»: при использовании ведущий тайно совершает чистую проверку СЛ 2. При провале предмет не оказывает значимого эффекта. Проверка выполняется вручную с учётом поддержки лавки.</p>`;
    }
    rows.push(data);
  }
  for (const slug of shop.secretStock ?? []) {
    const data = stockCopy(await get(slug), 2);
    data.flags[ID].stockKey = `item:${slug}`;
    data.flags['item-piles'] = {item: {hidden: true, notForSale: true}};
    rows.push(data);
  }
  for (const custom of shop.custom) {
    const data = stockCopy(await get(custom.base), custom.quantity);
    data.flags[ID].stockKey = `custom:${custom.name}`;
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
    data.flags[ID].stockKey = `weapon:${slug}:potency:1`;
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
    data.flags[ID].stockKey = `scroll:${scroll.slug}:${scroll.rank}`;
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

async function prepareDescriptions(shops) {
  const guide = game.journal.get('pf2ap20016player')
    ?? game.journal.find(journal => journal.pages.has('16exploringthe00'));
  const page = guide?.pages.get('16exploringthe00');
  if (!page) throw new Error('В мире не найдено руководство игрока. Импортируйте его из Seven Dooms for Sandpoint.');
  const document = new DOMParser().parseFromString(page.text.content, 'text/html');
  const descriptions = new Map();
  for (const shop of shops) {
    const section = document.querySelector(`section.action[data-scroll="${shop.id.padStart(2, '0')}"]`);
    const paragraphs = section ? [...section.querySelectorAll(':scope > p')] : [];
    if (paragraphs.length < 3) throw new Error(`В руководстве игрока не найдено описание: ${shop.name}`);
    let portrait = section.querySelector('img');
    // Портрет настоятеля находится в разделе о фракциях руководства игрока.
    if (shop.id === '1') {
      const factions = guide.pages.get('16sandpointfac00');
      const images = new DOMParser().parseFromString(factions?.text.content ?? '', 'text/html');
      portrait = images.querySelector('img[src$="PZO90200 ABSTALAR ZANTUS.webp"]');
    }
    const seller = paragraphs.slice(2).flatMap(p => [...p.querySelectorAll('strong')])[0]?.textContent.trim() ?? '';
    const source = portrait?.getAttribute('src');
    const image = source?.startsWith('modules/pf2e-ap200-seven-dooms-for-sandpoint/assets/art/')
      ? `<figure style="margin:0 0 12px;text-align:center"><img src="${escape(source)}" alt="${escape(seller)}" style="width:160px;max-width:100%;height:auto;border:0">${seller ? `<figcaption><strong>${escape(seller)}</strong></figcaption>` : ''}</figure>`
      : '';
    descriptions.set(shop.id, image + paragraphs.map(p => p.outerHTML).join(''));
  }
  return descriptions;
}

function existingShops(shops, scene) {
  return new Map(shops.flatMap(shop => {
    const linked = scene.tokens.find(t => t.flags.world?.sandpointShop?.id === shop.id
      && !t.flags.world.sandpointShop.duplicateHidden && game.actors.has(t.actorId));
    const actor = linked ? game.actors.get(linked.actorId) : game.actors.find(a =>
      a.flags.world?.sandpointShop?.id === shop.id && !a.flags.world.sandpointShop.archived);
    return actor ? [[shop.id, actor]] : [];
  }));
}

async function applyDescriptions(actors, descriptions) {
  const actorUpdates = [];
  const tokenUpdates = new Map();
  const before = {actors: [], scenes: []};
  for (const [id, actor] of actors) {
    const html = descriptions.get(id);
    if (actor.system.details.description !== html || actor.flags['item-piles']?.data?.description !== html) {
      before.actors.push({_id: actor.id, 'system.details.description': actor.system.details.description,
        'flags.item-piles.data.description': actor.flags['item-piles']?.data?.description ?? ''});
      actorUpdates.push({_id: actor.id, 'system.details.description': html,
        'flags.item-piles.data.description': html, 'flags.world.sandpointShop.descriptionVersion': VERSION});
    }
    for (const scene of game.scenes) {
      for (const token of scene.tokens.filter(t => t.actorId === actor.id && t.flags.world?.sandpointShop?.id === id)) {
        if (token.flags['item-piles']?.data?.description === html) continue;
        if (!tokenUpdates.has(scene.id)) tokenUpdates.set(scene.id, []);
        tokenUpdates.get(scene.id).push({_id: token.id, 'flags.item-piles.data.description': html});
      }
    }
  }
  for (const [id, updates] of tokenUpdates) before.scenes.push({id, tokens: updates.map(update => ({
    _id: update._id, 'flags.item-piles.data.description': game.scenes.get(id).tokens.get(update._id).flags['item-piles']?.data?.description ?? ''
  }))});
  if (actorUpdates.length || tokenUpdates.size) await saveReport(`descriptions-before-${Date.now()}.json`, before);
  if (actorUpdates.length) await Actor.updateDocuments(actorUpdates);
  for (const [id, updates] of tokenUpdates) await game.scenes.get(id).updateEmbeddedDocuments('Token', updates);
  return {shops: actors.size, portraits: [...actors.keys()].filter(id => descriptions.get(id).includes('<figure')).length};
}

export async function updateDescriptions(scene = canvas.scene) {
  if (!game.user.isGM) throw new Error('Обновлять описания может ведущий.');
  if (!scene) throw new Error('Откройте городскую карту Сэндпойнта.');
  const response = await fetch(`${ROOT}/data/shops.json`);
  if (!response.ok) throw new Error('Не удалось прочитать список магазинов.');
  const {shops} = await response.json();
  const descriptions = await prepareDescriptions(shops);
  const actors = existingShops(shops, scene);
  if (actors.size !== shops.length) throw new Error('Сначала разместите все магазины на городской карте.');
  const report = await applyDescriptions(actors, descriptions);
  ui.notifications.info(`Обновлены описания ${report.shops} торговых точек. Портретов из руководства игрока: ${report.portraits}.`);
  return report;
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

function sameStockItem(item, row) {
  if (item.flags[ID]?.stockKey) return item.flags[ID].stockKey === row.flags[ID].stockKey;
  const sameSource = item.flags[ID]?.source === row.flags[ID].source;
  if (!sameSource) return false;
  if (row.system.spell) {
    return item.system.spell?.system.slug === row.system.spell.system.slug
      && item.system.spell?.system.location?.heightenedLevel === row.system.spell.system.location.heightenedLevel;
  }
  if (row.flags[ID].stockKey.startsWith('weapon:')) return item.system.runes?.potency === row.system.runes.potency;
  if (row.flags[ID].stockKey.startsWith('custom:')) return item.name === row.name;
  return true;
}

async function synchronizeStock(actor, rows) {
  const installedKeys = new Set(actor.flags.world?.sandpointShop?.catalogKeys ?? []);
  const updates = [];
  const missing = [];
  for (const row of rows) {
    const key = row.flags[ID].stockKey;
    const existing = actor.items.find(item => sameStockItem(item, row));
    if (existing) {
      if (existing.flags[ID]?.stockKey !== key) updates.push({_id: existing.id, [`flags.${ID}.stockKey`]: key});
    } else if (!installedKeys.has(key)) missing.push(row);
    installedKeys.add(key);
  }
  if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
  if (missing.length) {
    const created = await actor.createEmbeddedDocuments('Item', missing);
    if (created.length !== missing.length) throw new Error(`Не все товары добавлены в магазин «${actor.name}». Повторите размещение.`);
  }
  await actor.update({
    'flags.world.sandpointShop.stockInitialized': true,
    'flags.world.sandpointShop.catalogKeys': [...installedKeys],
    'flags.world.sandpointShop.version': VERSION
  });
}

export async function install(scene = canvas.scene) {
  const module = game.modules.get(ID);
  module.api ??= {};
  if (module.api.installation) return ui.notifications.warn('Размещение магазинов уже выполняется. Дождитесь завершения.');
  module.api.installation = performInstall(scene);
  try { return await module.api.installation; }
  finally { delete module.api.installation; }
}

async function performInstall(scene) {
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
  const existing = existingShops(shops, scene);
  const descriptions = await prepareDescriptions(shops);
  const anchors = new Map();
  const prepared = new Map();
  ui.notifications.info('Подготавливаю магазины Сэндпойнта…');
  // Сначала проверяем все данные. Ошибка предмета не оставит половину магазинов.
  for (const shop of shops) {
    const anchor = scene.notes.get(shop.anchor) ?? scene.notes.find(n => n.text.toLowerCase() === shop.name.toLowerCase());
    if (!anchor) throw new Error(`На карте не найдена отметка: ${shop.name}`);
    anchors.set(shop.id, anchor);
    prepared.set(shop.id, await prepareStock(shop, equipment, spellIndex, spellPack));
  }
  if (!scene.getFlag('world', 'sandpointShops')) await saveReport(`scene-before-${scene.id}.json`, scene.toObject());
  if (shops.some(s => !existing.get(s.id)?.flags.world?.sandpointShop?.catalogKeys)) {
    await saveReport(`stock-before-${Date.now()}.json`, {
      scene: scene.toObject(),
      actors: game.actors.filter(a => a.flags.world?.sandpointShop).map(a => a.toObject())
    });
  }
  for (const shop of shops) {
    const token = tokenData(shop, scene, anchors.get(shop.id));
    let actor = existing.get(shop.id);
    if (!actor) {
      const html = descriptions.get(shop.id);
      await game.itempiles.API.createItemPile({
        sceneId: scene.id, createActor: true,
        folders: ['Магазины Сэндпойнта'],
        actorOverrides: {
          name: shop.name, type: 'loot', img: token.texture.src,
          system: {lootSheetType: 'Merchant', details: {description: html}},
          ownership: {default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED},
          prototypeToken: COPY(token), flags: {world: {sandpointShop: {id: shop.id, version: VERSION}}}
        },
        tokenOverrides: token,
        itemPileFlags: {
          enabled: true, type: 'merchant', description: html, distance: 0,
          infiniteQuantity: false, infiniteCurrencies: true, purchaseOnly: true,
          buyPriceModifier: shop.discount, sellPriceModifier: 0.5,
          displayQuantity: 'yes', hideItemsWithZeroCost: true, keepZeroQuantity: true,
          merchantImage: token.texture.src, openTimes: {enabled: false, status: 'open'}
        },
        // Предметы добавляются штатным способом PF2e после создания торговца.
        items: false
      });
      actor = game.actors.find(a => a.flags.world?.sandpointShop?.id === shop.id);
      if (!actor) throw new Error(`Не удалось создать магазин: ${shop.name}`);
      existing.set(shop.id, actor);
    }
    await synchronizeStock(actor, prepared.get(shop.id));
    if (!scene.tokens.some(t => t.flags.world?.sandpointShop?.id === shop.id)) {
      const document = await actor.getTokenDocument(token);
      await scene.createEmbeddedDocuments('Token', [document.toObject()]);
    }
  }
  await applyDescriptions(existing, descriptions);
  await scene.setFlag('world', 'sandpointShops', {version: VERSION, shops: shops.length});
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
    module.api = {install, updateDescriptions};
    if (!game.user.isGM || game.macros.some(m => m.getFlag(ID, 'installer'))) return;
    await Macro.create({name:'Магазины Сэндпойнта — разместить на карте',type:'script',img:`${ROOT}/icons/shop-26.svg`,
      command:`await (await import('/${ROOT}/scripts/shops.mjs')).install();`,flags:{[ID]:{installer:true}}});
});
