#!/usr/bin/env node
/**
 * 首页（web/index.html）回归测试
 *
 * 为什么需要它：首页是所有游戏的入口，但它一直没人测。这次踩到的问题是
 * **两个游戏的图标一模一样**（记忆配对和记忆扑克都用了 🃏）——
 * 在卡片列表里根本分不出谁是谁。这种问题：
 *   · 单个游戏的测试抓不到（它们只管自己那个页面）
 *   · 也不会报错，只是「用起来别扭」
 * 所以专门给首页建一份，把「每个游戏必须能被区分开」变成硬约束。
 *
 * 覆盖：
 *   1) 每张卡片都有 href / 图标 / 名称 / 描述
 *   2) ★ 图标**互不重复**（这是本测试存在的主要理由）
 *   3) ★ 链接都指向真实存在的游戏目录，且那个目录里有 index.html
 *   4) 卡片数 = 实际游戏数（加了游戏忘了加卡片也抓得到）
 *   5) 图标是单字符（emoji），不是一串文字
 *   6) 样式内联、无外链（离线 APK 要能直接用）
 *   7) ★ 管理游戏（隐藏 / 显示入口）：每个游戏都有一张可管理的卡片 + 角标、
 *      隐藏状态只存在本机 localStorage、且**只写相对 / 无 href 的标记**
 *      （离线 APK 里任何 `href="/..."` 都会被 sync_assets 判成外链）
 *
 * 用法：node tools/test_index.js
 */
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const HTML_PATH = path.join(WEB, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* 抠出所有卡片：<a class="card" href="/xxx/">…</a> */
function parseCards(src){
  const out = [];
  const re = /<a\s+class="card"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while((m = re.exec(src)) !== null){
    const href = m[1];
    const body = m[2];
    const icon = /<div class="icon">([\s\S]*?)<\/div>/.exec(body);
    const name = /<div class="name">([\s\S]*?)<\/div>/.exec(body);
    const desc = /<div class="desc">([\s\S]*?)<\/div>/.exec(body);
    const tag  = /<span class="tag">([\s\S]*?)<\/span>/.exec(body);
    out.push({
      href,
      icon: icon ? icon[1].trim() : '',
      name: name ? name[1].replace(/<[^>]+>/g, '').trim() : '',
      desc: desc ? desc[1].replace(/<[^>]+>/g, '').trim() : '',
      tag: tag ? tag[1].trim() : '',
    });
  }
  return out;
}

const cards = parseCards(html);

/* ================= 1) 卡片完整性 ================= */
section('1) 每张卡片都完整');
{
  ok(cards.length > 0, '解析出卡片（' + cards.length + ' 张）');
  const badHref = cards.filter(c => !/^\/[a-z0-9_-]+\/$/.test(c.href));
  ok(badHref.length === 0, '★ 所有 href 都是 /<游戏名>/ 形式',
     badHref.map(c => c.href).join(','));
  const badIcon = cards.filter(c => !c.icon);
  ok(badIcon.length === 0, '每张卡都有图标', badIcon.map(c => c.name).join(','));
  const badName = cards.filter(c => !c.name);
  ok(badName.length === 0, '每张卡都有名称', badName.map(c => c.href).join(','));
  const badDesc = cards.filter(c => !c.desc);
  ok(badDesc.length === 0, '每张卡都有描述', badDesc.map(c => c.name).join(','));
}

/* ================= 2) ★ 图标不能重复 ================= */
section('2) ★ 图标互不重复（本测试存在的主要理由）');
{
  const seen = {};
  const dups = [];
  for(const c of cards){
    if(!c.icon) continue;
    if(seen[c.icon]) dups.push(c.icon + '（' + seen[c.icon] + ' / ' + c.name + '）');
    else seen[c.icon] = c.name;
  }
  ok(dups.length === 0,
     '★ 没有两个游戏用同一个图标',
     dups.length ? '重复：' + dups.join('、') : '');

  /* 名字也不能重复 —— 两个「记忆扑克」同样分不清 */
  const seenName = {};
  const dupName = [];
  for(const c of cards){
    if(seenName[c.name]) dupName.push(c.name);
    else seenName[c.name] = 1;
  }
  ok(dupName.length === 0, '★ 没有两个游戏同名', dupName.join('、'));
}

/* ================= 3) ★ 图标是单个字符 ================= */
section('3) ★ 图标是单个 emoji，不是一串字');
{
  const bad = [];
  for(const c of cards){
    /* 用 Array.from 按码位切，emoji 是代理对但也只算 1 个「字」；
       VS16（\uFE0F）和 ZWJ 也允许（🏎️ 这类需要变体选择符） */
    const chars = Array.from(c.icon.replace(/[\uFE0F\u200D]/g, ''));
    if(chars.length !== 1) bad.push(c.name + '：' + JSON.stringify(c.icon) + '（' + chars.length + ' 个字符）');
    /* 不能是汉字/字母 —— 那看起来就不像图标 */
    if(/[\u4e00-\u9fffA-Za-z]/.test(c.icon)) bad.push(c.name + ' 的图标含文字：' + c.icon);
  }
  ok(bad.length === 0, '★ 每个图标都是单个 emoji', bad.join('；'));
}

/* ================= 4) ★ 链接都指向真实存在的游戏 ================= */
section('4) ★ 每个链接都通');
{
  const missing = [];
  for(const c of cards){
    const dir = path.join(WEB, c.href.replace(/^\/|\/$/g, ''));
    if(!fs.existsSync(dir)) missing.push(c.name + ' → ' + c.href + '（目录不存在）');
    else if(!fs.existsSync(path.join(dir, 'index.html'))) missing.push(c.name + ' → ' + c.href + '（缺 index.html）');
  }
  ok(missing.length === 0, '★ 每张卡都指向真实存在的游戏页面', missing.join('；'));
}

/* ================= 5) 卡片数 = 实际游戏数 ================= */
section('5) 卡片数和实际游戏数对得上');
{
  const dirs = fs.readdirSync(WEB, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => fs.existsSync(path.join(WEB, n, 'index.html')))
    .sort();
  const linked = cards.map(c => c.href.replace(/^\/|\/$/g, '')).sort();

  const notLinked = dirs.filter(d => linked.indexOf(d) < 0);
  ok(notLinked.length === 0,
     '★ 每个游戏目录都在首页有卡片（加了游戏忘了加卡片会在这里红）',
     notLinked.length ? '漏了：' + notLinked.join(',') : '');
  ok(dirs.length === cards.length,
     '游戏目录数 = 卡片数（' + dirs.length + ' / ' + cards.length + '）',
     '目录：' + dirs.join(','));
}

/* ================= 6) 两个记忆游戏要能区分开 ================= */
section('6) ★ 两个扑克牌记忆游戏要能区分');
{
  const pairs = cards.find(c => c.href === '/pairs/');
  const mem = cards.find(c => c.href === '/memcards/');
  ok(!!pairs, '有记忆配对的卡片');
  ok(!!mem, '有记忆扑克的卡片');
  if(pairs && mem){
    ok(pairs.icon !== mem.icon,
       '★ 两个游戏的图标不同（' + pairs.icon + ' vs ' + mem.icon + '）');
    ok(pairs.name !== mem.name,
       '★ 两个游戏的名字不同（' + pairs.name + ' vs ' + mem.name + '）');
    /* 描述也不能一样 —— 光名字不同、描述雷同，还是分不清 */
    ok(pairs.desc !== mem.desc, '★ 两个游戏的描述不同');
    /* 描述里要能看出玩法差别：一个讲「配对」，一个讲「回答」 */
    ok(/配对/.test(pairs.desc), '记忆配对的描述里提到「配对」');
    ok(/回答|问题/.test(mem.desc), '记忆扑克的描述里提到「回答 / 问题」');
  }
}

/* ================= 6.5) ★ 管理游戏（隐藏 / 显示入口） ================= */
section('6.5) ★ 每个游戏都能被单独隐藏 / 恢复');
{
  /* 每张卡必须被 .cell[data-game] 包着，且 data-game 与 href 一致 ——
     对不上就会出现「点了隐藏 A，淡掉的却是 B」这种很难查的错位。 */
  const cellRe = /<div class="cell" data-game="([^"]+)">([\s\S]*?)<\/div>\s*(?=<div class="cell"|<div class="empty"|<div class="soon")/g;
  const cells = [];
  let cm;
  while((cm = cellRe.exec(html)) !== null){
    const body = cm[2];
    const href = /<a class="card" href="([^"]+)"/.exec(body);
    const pick = /<button class="pick"/.test(body);
    cells.push({ game: cm[1], href: href ? href[1] : '', pick });
  }
  ok(cells.length === cards.length,
     '★ 每张卡片都包在 .cell[data-game] 里（' + cells.length + ' / ' + cards.length + '）');
  ok(cells.every(c => c.pick), '★ 每个 .cell 里都有隐藏 / 显示角标按钮');
  const mismatch = cells.filter(c => c.href !== '/' + c.game + '/');
  ok(mismatch.length === 0, '★ data-game 与卡片 href 一一对应（错位就会藏错游戏）',
     mismatch.map(c => c.game + ' vs ' + c.href).join('；'));

  /* 角标在非管理模式下不能挡住点卡片：默认 display:none，只有 .managing 才显示 */
  ok(/\.pick\{[\s\S]*?display:none/.test(html), '角标默认不显示（平时不挡视线）');
  ok(/\.grid\.managing \.pick\{display:grid\}/.test(html),
     '★ 只有进入管理模式角标才出现');
  /* ★ 平时隐藏 = 真的不占位（主菜单要干净）；管理模式 = 全部露出来才好点回来 */
  ok(/\.grid:not\(\.managing\) \.cell\.hidden\{display:none\}/.test(html),
     '★ 平时被隐藏的游戏完全不占位（不是留一个灰块）');
  ok(/\.grid\.managing \.cell\.hidden \.card\{[\s\S]*?opacity/.test(html),
     '★ 管理模式里被隐藏的卡片仍然看得见（淡出样式，能点回来）');

  /* 存储键：改名会让玩家之前的选择全部丢失，所以锁死 */
  ok(/gbox_hidden_v1/.test(html), '★ 隐藏状态用固定键 gbox_hidden_v1 存本机');
  ok(/localStorage\.setItem\(\s*KEY/.test(html), '隐藏状态会写回 localStorage');
  ok(/localStorage\.getItem\(\s*KEY/.test(html), '打开首页会读回上次的隐藏状态');
  /* 读回来必须校验：存档被手改成垃圾（非数组 / 不存在的目录）不能让首页崩 */
  ok(/\[object Array\]/.test(html), '读存档时校验「必须是数组」');
  ok(/cells\.some/.test(html), '★ 只认确实存在的游戏目录（脏数据直接忽略）');
  /* 全部隐藏时要有空状态，否则玩家以为页面坏了 */
  ok(/id="empty"/.test(html) && /\.hidden\s*=\s*shown\s*>\s*0/.test(html),
     '★ 全部隐藏时给出空状态提示');
  /* ★ 有 display 的按钮必须显式处理 [hidden]：作者样式的 display:inline-flex
     会盖掉 UA 的 [hidden]{display:none}，按钮会一直显示在页面上（截图抓到过）。 */
  ok(/\.manage\[hidden\]\{display:none\}/.test(html),
     '★ 按钮带 display 时必须显式写 [hidden]{display:none}（否则藏不住）');
  ok(/id="showAllBtn"[^>]*hidden/.test(html),
     '「全部显示」初始是 hidden（没藏东西时不出现）');
  /* 管理模式外点卡片必须能正常进游戏 */
  ok(/if\(!managing\) return;/.test(html),
     '★ 非管理模式下点卡片照常进游戏（不会误吞点击）');
  /* 「全部显示」要有 —— 藏多了得能一键复原 */
  ok(/id="showAllBtn"/.test(html) && /hidden = \[\];/.test(html),
     '★ 有「全部显示」一键复原');
  /* 管理按钮要能再次点掉（进入 / 退出） */
  ok(/setManaging\(!managing\)/.test(html), '管理按钮可切换进出管理模式');
}

/* ================= 7) 单文件自包含 ================= */
section('7) 首页自身可离线');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链（http/https/协议相对）');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok(/<meta name="viewport"/.test(html), '有 viewport（手机上要能用）');
  ok(/href="\/"/.test(html) || cards.length > 0, '（首页本身就是站点根，不需要返回链接）');
  /* ★ 首页新加的按钮 / 空状态不能带 href：sync_assets.py 会把任何 href="/..." 判成外链
     直接让 APK 构建失败，而 `<a href="#">` 这类又会在 WebView 里跳走。 */
  ok(!/<button[^>]+href=/i.test(html), '按钮上没有 href（离线包会判成外链）');
  ok(!/href="#"/.test(html), '没有 href="#" 空链接');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
