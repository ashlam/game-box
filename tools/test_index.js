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

/* ================= 7) 单文件自包含 ================= */
section('7) 首页自身可离线');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链（http/https/协议相对）');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok(/<meta name="viewport"/.test(html), '有 viewport（手机上要能用）');
  ok(/href="\/"/.test(html) || cards.length > 0, '（首页本身就是站点根，不需要返回链接）');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
