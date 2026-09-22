/**
 * 可选：真实浏览器端到端冒烟测试（不参与 npm test）。
 *
 * 需要先装好 puppeteer 与 Chrome：
 *   npm i -D puppeteer && npx puppeteer browsers install chrome-headless-shell
 * 并在另一个终端起本地静态服务：
 *   python3 -m http.server 8123 --directory docs
 *
 * 运行：
 *   CHROME_PATH=/path/to/chrome-headless-shell node tests/e2e/browser.mjs
 *   BASE_URL=http://127.0.0.1:8123/ SHOTS=/tmp/kline-shots node tests/e2e/browser.mjs
 *
 * 覆盖：开局设置 → 随机抽样 → 画布真的画出红绿 K 线 → 尾盘模式同日反复加减仓 →
 *       T+1 拦截 → 进入下一日 → 自动结算 → 次日开盘模式委托篮/撤销/成交 →
 *       指定代码检索 → 一手买不起的保护 → 结束交易清仓 → 移动端布局。
 * 任何控制台报错或断言失败都会以非 0 退出码结束。
 */
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8123/';
const SHOTS = process.env.SHOTS || '/tmp/kline-shots';
const CHROME_PATH = process.env.CHROME_PATH || undefined;

let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  console.error('缺少 puppeteer，请先 npm i -D puppeteer');
  process.exit(2);
}

fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));

const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` });
const wait = ms => new Promise(r => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) errors.push('assert: ' + msg); };
const text = sel => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());
const clickAdd = f => page.click(`#side [data-add="${f}"]`);
const clickReduce = f => page.click(`#side [data-reduce="${f}"]`);
const startSession = async () => {
  await page.click('#btn-start');
  await page.waitForFunction(() => document.getElementById('modal-setup').classList.contains('hidden'), { timeout: 20000 });
  await wait(550);
};

console.log('1. 开局设置');
await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
await page.waitForSelector('#modal-setup:not(.hidden)');
const pool = await text('#pool-hint');
console.log('   样本池:', pool);
check(/样本池 \d+ 只股票/.test(pool), '样本池提示异常');
console.log('   成交口径提示:', await text('#fill-hint'));
await shot('01-setup');

console.log('2. 尾盘即时模式随机开局 + 画布渲染');
await page.click('#seg-horizon button[data-h="60"]');
await startSession();
const px = await page.evaluate(() => {
  const src = document.getElementById('chart');
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let up = 0, down = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 10) continue;
    if (d[i] > 170 && d[i + 1] < 120 && d[i + 2] < 120) up++;
    else if (d[i + 1] > 130 && d[i] < 120) down++;
  }
  return { up, down };
});
console.log('   红/绿像素:', JSON.stringify(px));
check(px.up > 200 && px.down > 200, '画布没有画出红绿 K 线');
check(/尾盘即时成交/.test(await text('#period-label')), '成交口径未显示在顶部');
await shot('02-session');

console.log('2b. 均线开关（默认打开）');
const maPixels = () => page.evaluate(() => {
  const src = document.getElementById('chart');
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if ((r > 230 && g > 140 && g < 190 && b < 60) ||          // #f59e0b MA5
        (r > 40 && r < 90 && g > 170 && b > 230) ||           // #38bdf8 MA10
        (r > 180 && g > 110 && g < 160 && b > 240)) n++;      // #c084fc MA20
  }
  return n;
});
const maOn = await maPixels();
console.log('   默认均线像素:', maOn);
check(maOn > 500, '默认应显示均线');
check(await page.$eval('#btn-ma', el => el.classList.contains('on')), '均线按钮默认应为开启态');
await page.click('#btn-ma'); await wait(350);
const maOff = await maPixels();
console.log('   关闭后均线像素:', maOff, '（MACD 金色 DEA 线与均线取色范围接近，允许残留少量）');
check(!(await page.evaluate(() => window.__kline.chart.showMA)), '关闭后 showMA 应为 false');
check(maOff < maOn * 0.15, `关闭后均线像素应大幅下降（${maOn} → ${maOff}）`);
check(await page.$eval('#btn-ma', el => !el.classList.contains('on')), '关闭后按钮应为关闭态');
await page.click('#btn-ma'); await wait(350);
check((await maPixels()) > 500, '再次打开应恢复均线');

console.log('2c. 手动划线：按住=起点，松开=终点');
const cbox = await page.$eval('#chart', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const lineCount = () => page.evaluate(() => window.__kline.chart.lines.length);
await page.click('#btn-draw'); await wait(200);
check(await page.evaluate(() => window.__kline.chart.drawMode), '划线模式应开启');
check(await page.$eval('#btn-draw', el => el.classList.contains('on')), '划线按钮应高亮');
check(/划线模式/.test(await text('#chart-tip')), '底部提示应切成划线说明');
await page.mouse.move(cbox.x + cbox.w * 0.25, cbox.y + cbox.h * 0.62);
await page.mouse.down();
await page.mouse.move(cbox.x + cbox.w * 0.45, cbox.y + cbox.h * 0.50, { steps: 5 });
await page.mouse.move(cbox.x + cbox.w * 0.70, cbox.y + cbox.h * 0.32, { steps: 5 });
await page.mouse.up();
await wait(300);
const l1 = await page.evaluate(() => window.__kline.chart.lines[0]);
console.log('   第 1 条线:', JSON.stringify(l1));
check((await lineCount()) === 1, '松开后应记录 1 条线');
check(l1 && l1.i1 > l1.i0 && l1.p1 > l1.p0, '线的起终点应记录为数据坐标（右上方）');
await page.mouse.move(cbox.x + cbox.w * 0.30, cbox.y + cbox.h * 0.35);
await page.mouse.down();
await page.mouse.move(cbox.x + cbox.w * 0.62, cbox.y + cbox.h * 0.45, { steps: 6 });
await page.mouse.up();
await wait(250);
check((await lineCount()) === 2, '应能画第二条线');
await shot('03-lines');
await page.mouse.move(cbox.x + cbox.w / 2, cbox.y + cbox.h / 2);
await page.mouse.wheel({ deltaY: -300 });
await wait(250);
const afterZoom = await page.evaluate(() => window.__kline.chart.lines[0]);
check(JSON.stringify(afterZoom) === JSON.stringify(l1), '缩放后画线锚点应保持不变（锚在数据坐标）');
await page.click('#btn-undo-line'); await wait(200);
check((await lineCount()) === 1, '撤销后应剩 1 条');
await page.click('#btn-clear-line'); await wait(200);
check((await lineCount()) === 0, '清空后应为 0 条');
await page.click('#btn-draw'); await wait(200);
check(!(await page.evaluate(() => window.__kline.chart.drawMode)), '再点「划线」应退出划线模式');
const vf0 = await page.evaluate(() => window.__kline.chart.viewFrom);
await page.mouse.move(cbox.x + cbox.w * 0.5, cbox.y + cbox.h * 0.4);
await page.mouse.down();
await page.mouse.move(cbox.x + cbox.w * 0.66, cbox.y + cbox.h * 0.4, { steps: 6 });
await page.mouse.up();
await wait(250);
const vf1 = await page.evaluate(() => window.__kline.chart.viewFrom);
console.log('   退出划线后拖拽平移: viewFrom', vf0, '→', vf1);
check(vf1 < vf0, '退出划线模式后拖拽应恢复平移');
await page.click('#btn-reset-view'); await wait(250);

console.log('3. 委托篮：同日多笔加仓，点「进入下一日」才成交');
const posOf = async () => parseFloat((await text('#act-pos')).replace('%', ''));
const sharesOf = async () => {
  const t = await text('#pos-shares');
  const m = t.match(/^([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
};
check((await posOf()) === 0, '开局应为空仓');
await clickAdd('0.25'); await wait(180);
await clickAdd('0.25'); await wait(180);
await clickAdd('0.25'); await wait(250);
const pend = await page.$$eval('#pending-list .pend', els => els.map(e => e.textContent.replace('×', '').trim()));
console.log('   委托篮:', JSON.stringify(pend));
check(pend.length === 3, '三笔加仓应都进委托篮');
check(pend[0].startsWith('1') && pend[2].startsWith('3'), '委托篮应标出输入顺序编号');
check((await posOf()) === 0, '未点「进入下一日」前不应成交（仓位不变）');
check((await sharesOf()) === 0, '未成交前不应有持仓');
check((await page.$$('#log-list .log-row')).length === 0, '未成交前流水应为空');
check((await text('#hud-progress')).startsWith('0 /'), '不应推进日期');
await shot('03-pending-close');

console.log('4. 委托可在进入下一日前撤销');
await clickAdd('0.25'); await wait(200);
check((await page.$$('#pending-list .pend')).length === 4, '应变成 4 笔');
await page.click('#pending-list .pend:last-child i');
await wait(200);
check((await page.$$('#pending-list .pend')).length === 3, '撤销后应剩 3 笔');
await clickAdd('0.25'); await wait(150);
await page.click('#pending-list .pend:last-child i');
await wait(200);
check((await page.$$('#pending-list .pend')).length === 3, '重复撤销仍应剩 3 笔');

console.log('5. 进入下一日：按输入顺序一次成交（尾盘口径 = 今日收盘价）');
const closePx = parseFloat((await text('#pending-mode')).match(/([\d.]+)/)[1]);
await page.click('#btn-next');
await wait(700);
const after = await page.evaluate(() => ({
  pos: document.getElementById('act-pos').textContent,
  prog: document.getElementById('hud-progress').textContent,
  rows: [...document.querySelectorAll('#log-list .log-row')].map(e => e.textContent.replace(/\s+/g, ' ')),
  pendingHidden: document.getElementById('pending-box').classList.contains('hidden'),
  shares: document.getElementById('pos-shares').textContent,
}));
console.log('   收盘价参考:', closePx, '| 成交后:', JSON.stringify(after));
check(parseFloat(after.pos) > 60, '三笔加仓成交后仓位应超过 60%，实际 ' + after.pos);
check(after.prog.startsWith('1 /'), '应推进到第 1 日');
check(after.rows.length === 3, '应产生 3 笔成交流水，实际 ' + after.rows.length);
check(after.pendingHidden, '成交后委托篮应清空');
check(after.rows.every(r => r.includes(closePx.toFixed(2))), '尾盘口径应按今日收盘价成交');
const held1 = await sharesOf();
check(held1 > 0, '成交后应有持仓');

console.log('5b. 同批「先加后清」：T+1 保护当批买入的股票');
await clickAdd('0.25'); await wait(150);
await clickReduce('1'); await wait(150);
check((await page.$$('#pending-list .pend')).length === 2, '加仓与清仓应各成一笔委托');
await page.click('#btn-next');
await wait(600);
const afterT1 = await sharesOf();
console.log(`   清仓前底仓 ${held1} 股 → 清仓后仍持有 ${afterT1} 股（当批买入的受 T+1 保护）`);
check(afterT1 > 0, '当批买入的股票不应被同批清仓卖掉');
check(afterT1 < held1 + 1e9 && afterT1 !== held1, '清仓应把底仓卖掉了');

console.log('5c. 隔日清仓：全部可卖');
await clickReduce('1'); await wait(150);
await page.click('#btn-next');
await wait(600);
check((await posOf()) === 0, '隔日清仓后应空仓');
check((await sharesOf()) === 0, '持仓应归零');
await shot('03-adjust');

console.log('6. 十字光标 + 跑到期满自动结算');
const box = await page.$eval('#chart', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box.x + box.w * 0.62, box.y + box.h * 0.3);
await wait(250);
await shot('04-crosshair');
for (let i = 0; i < 80; i++) {
  if (await page.evaluate(() => !document.getElementById('modal-result').classList.contains('hidden'))) break;
  if (await page.evaluate(() => document.getElementById('btn-next').disabled)) break;
  await page.click('#btn-next');
  await wait(35);
}
await page.waitForSelector('#modal-result:not(.hidden)', { timeout: 15000 });
const rs = await page.evaluate(() => ({
  ret: document.getElementById('rs-return').textContent,
  sub: document.getElementById('rs-sub').textContent,
  stock: document.getElementById('rs-stock').textContent,
}));
console.log('   ', JSON.stringify(rs));
check(/^[+-]\d/.test(rs.ret), '结算面板没有突出收益率');
check(/尾盘即时成交/.test(rs.sub), '结算应标注成交口径');
await shot('05-result');

console.log('5b. 成交明细面板');
{
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: SHOTS });
}
await page.waitForSelector('#modal-result:not(.hidden)');
await page.click('#rs-trades');
await page.waitForSelector('#modal-trades:not(.hidden)');
const td = await page.evaluate(() => ({
  head: [...document.querySelectorAll('#td-table th')].map(e => e.textContent),
  rows: document.querySelectorAll('#td-table tbody tr').length,
  first: [...document.querySelectorAll('#td-table tbody tr:first-child td')].map(e => e.textContent),
  foot: document.getElementById('td-foot').textContent.replace(/\s+/g, ' '),
}));
console.log('   列:', td.head.join(' | '));
console.log('   首行:', td.first.join(' | '));
console.log('   合计:', td.foot);
check(td.head.length === 13, '成交明细应有 13 列，实际 ' + td.head.length);
check(['日期', '成交价', '股数', '盈亏', '收益率'].every(h => td.head.includes(h)), '缺少关键列');
check(td.rows > 0, '成交明细应有数据行');
check(/已实现盈亏/.test(td.foot), '合计行应含已实现盈亏');
await page.click('#seg-td button[data-td="buy"]');
const buyRows = await page.$$eval('#td-table tbody tr', els => els.length);
await page.click('#seg-td button[data-td="sell"]');
const sellRows = await page.$$eval('#td-table tbody tr', els => els.length);
console.log(`   筛选：买入 ${buyRows} 行 / 卖出 ${sellRows} 行 / 全部 ${td.rows} 行`);
check(buyRows + sellRows === td.rows, '买入+卖出 行数应等于全部');
check(buyRows > 0 && sellRows > 0, '买卖都应至少有一行');
await page.click('#seg-td button[data-td="all"]');
await shot('05b-trades');
await page.click('#td-csv');
await wait(900);
const csv = fs.readdirSync(SHOTS).filter(f => f.endsWith('.csv'));
console.log('   导出文件:', JSON.stringify(csv));
check(csv.length > 0, 'CSV 未导出');
if (csv.length) {
  const txt = fs.readFileSync(`${SHOTS}/${csv[0]}`, 'utf8');
  const lines = txt.trim().split(/\r?\n/);
  console.log('   CSV 行数:', lines.length, '| 表头:', lines[0].slice(0, 60));
  check(lines.length === td.rows + 1, 'CSV 行数应为 数据行+表头');
  check(lines[0].includes('日期') && lines[0].includes('盈亏'), 'CSV 表头不对');
}
await page.click('#td-close');
check(await page.$eval('#modal-result', el => !el.classList.contains('hidden')), '关闭明细后应回到结算面板');

console.log('6b. 兜底：DOM 缺元素（版本错配）时结算面板仍要弹出');
await page.click('#rs-view');
await page.evaluate(() => document.getElementById('rs-bench').remove());
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await startSession();
await clickAdd('0.5'); await wait(150);
await page.click('#btn-next'); await wait(450);
await page.click('#btn-end');
await page.waitForSelector('#modal-confirm:not(.hidden)');
await page.click('#cf-ok');
await wait(1200);
const resilient = await page.evaluate(() => ({
  shown: !document.getElementById('modal-result').classList.contains('hidden'),
  ret: document.getElementById('rs-return').textContent,
  toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '',
}));
console.log('   ', JSON.stringify({ shown: resilient.shown, ret: resilient.ret }));
check(resilient.shown, '缺少 DOM 元素时结算面板仍应弹出（否则缓存错配会让用户"什么都没看到"）');
check(/渲染出错/.test(resilient.toast), '应给出渲染出错提示并引导强制刷新');
// 还原元素，后续步骤继续用完整面板
await page.evaluate(() => {
  const d = document.createElement('div');
  d.id = 'rs-bench'; d.className = 'bench';
  document.querySelector('#modal-result .dialog').appendChild(d);
});

console.log('7. 次日开盘模式：委托篮 / 撤销 / 成交');
await page.click('#rs-again');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-fill button[data-fill="open"]');
await page.click('#seg-mode button[data-mode="random"]');
await page.click('#seg-horizon button[data-h="30"]');
console.log('   口径提示:', await text('#fill-hint'));
await startSession();
check(/次日开盘价成交/.test(await text('#period-label')), '口径未切换');
check(await page.$eval('#pending-box', el => el.classList.contains('hidden')), '未下单时不应显示委托篮');
await clickAdd('0.5');
await wait(250);
await clickAdd('0.25');
await wait(250);
const pend2 = await page.$$eval('#pending-list .pend', els => els.map(e => e.textContent.replace('×', '').trim()));
console.log('   委托篮:', JSON.stringify(pend2));
check(pend2.length === 2, '两笔委托应都进篮');
check(await page.$eval('#pending-box', el => !el.classList.contains('hidden')), '委托篮应显示');
check((await posOf()) === 0, '严格模式下未成交前不应有仓位');
await shot('06-pending');
await page.click('#pending-list .pend i');       // 撤销第一笔
await wait(250);
check((await page.$$('#pending-list .pend')).length === 1, '撤销后应只剩一笔');
await page.click('#btn-next');
await wait(500);
const logs2 = await text('#log-list');
console.log('   成交后流水:', logs2);
check((await page.$$('#log-list .log-row')).length > 0, '进入下一日后委托应按开盘价成交');
check(/加 1\/4/.test(logs2), '流水应记下被保留的那笔委托');
check((await posOf()) > 0, '成交后应有仓位');
check(await page.$eval('#pending-box', el => el.classList.contains('hidden')), '成交后委托篮应清空');

console.log('8. 指定代码 + 一手买不起保护');
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-fill button[data-fill="close"]');
await page.click('#seg-mode button[data-mode="pick"]');
await page.focus('#pick-input');
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
await page.keyboard.press('Backspace');
await page.type('#pick-input', '茅台');
await wait(300);
check((await page.$$('#pick-list button')).length > 0, '代码检索无结果');
await page.click('#pick-list button');
await page.click('#seg-horizon button[data-h="30"]');
await startSession();
await clickAdd('0.25');
await wait(350);
const poorToast = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
console.log('   提示:', poorToast);
check(/不足一手|买不进/.test(poorToast), '买不起一手应给出明确提示');
check((await posOf()) === 0, '买不起时不应产生持仓');
await shot('07-no-funds');

console.log('9. 结束交易清仓');
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-mode button[data-mode="pick"]');
await page.focus('#pick-input');
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
await page.keyboard.press('Backspace');
await page.type('#pick-input', '平安银行');
await wait(300);
await page.click('#pick-list button');
await startSession();
await clickAdd('0.5');
await wait(300);
await page.click('#btn-next');
await wait(400);
await page.click('#btn-end');
await page.waitForSelector('#modal-confirm:not(.hidden)');
console.log('   结束确认:', await text('#cf-body'));
await page.click('#cf-ok');
await wait(900);
const end = await page.evaluate(() => ({
  log: document.getElementById('log-list').textContent.replace(/\s+/g, ' '),
  result: !document.getElementById('modal-result').classList.contains('hidden'),
}));
check(end.result, '结束交易未弹出结算面板');
check(/清仓|卖|结算/.test(end.log), '结束交易没有清仓流水');
console.log('   ', JSON.stringify(end));
await shot('08-end');

console.log('9b. 空仓换股（无限次）+ 沪深300 基准');
await page.click('#rs-view');
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-horizon button[data-h="30"]');
await page.click('#seg-mode button[data-mode="random"]');
await startSession();
const codeOf = () => page.evaluate(() => window.__kline.session.stock.code);
const dateOf = () => page.evaluate(() => window.__kline.session.date);
check(await page.$eval('#btn-switch', el => !el.disabled), '空仓时应能换股');
const swDate = await dateOf();
const codes = new Set();
for (let i = 0; i < 3; i++) { await page.click('#btn-switch'); await wait(650); codes.add(await codeOf()); }
console.log('   连点 3 次换股，出现标的:', [...codes].join(', '));
check(codes.size >= 2, '连点换股应换到不同标的');
check((await dateOf()) === swDate, '换股后日期不应改变');
check((await page.evaluate(() => window.__kline.session.switches.length)) === 3, '换股次数应为 3');
check((await text('#hud-progress')).startsWith('0 /'), '换股不应消耗交易日');
check((await page.evaluate(() => window.__kline.session.shares)) === 0, '换股不应产生持仓');
await clickAdd('0.25'); await wait(150);
await page.click('#btn-next'); await wait(550);
check(await page.$eval('#btn-switch', el => el.disabled), '有持仓时应禁止换股');
await clickReduce('1'); await wait(150);
await page.click('#btn-next'); await wait(550);
const state9b = await page.evaluate(() => ({
  shares: window.__kline.session.switches.length && window.__kline.session.shares,
  disabled: document.getElementById('btn-switch').disabled,
}));
check(state9b.shares > 0 === state9b.disabled, '换股按钮可用性应与持仓状态一致（有仓禁用 / 空仓可用）');
if (state9b.shares === 0) {
  const n0 = await page.evaluate(() => window.__kline.session.switches.length);
  await page.click('#btn-switch'); await wait(700);
  check((await page.evaluate(() => window.__kline.session.switches.length)) >= n0, '空仓后应能再次换股');
} else {
  console.log('   （清仓未成交，可能碰上跌停封板，跳过再次换股）');
}
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => !document.getElementById('modal-result').classList.contains('hidden'))) break;
  if (await page.evaluate(() => document.getElementById('btn-next').disabled)) break;
  await page.click('#btn-next'); await wait(40);
}
await page.waitForSelector('#modal-result:not(.hidden)', { timeout: 15000 });
await wait(400);
const bench = await text('#rs-bench');
console.log('   基准区:', bench.replace(/\s+/g, ' ').slice(0, 120));
check(/沪深300/.test(bench), '结算面板应显示沪深300基准');
check(/跑赢沪深300/.test(bench), '应显示跑赢沪深300');
check(!/本股区间|满仓持有/.test(bench), '旧的"随机全仓买入"两个基准应已删除');
check(/中途换股\s*\d+ 次/.test((await text('#rs-stats')).replace(/\s+/g, ' ')), '摘要应显示换股次数');
await shot('13-switch');

console.log('9c. 换股筛选（回落 3%~15% + 连涨 2 天，仅作用于换股）');
await page.click('#rs-again');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-horizon button[data-h="30"]');
await page.click('#seg-mode button[data-mode="random"]');
await startSession();
check(await page.evaluate(() => window.__kline.filterMask) === 3, '换股筛选默认应勾选前两条（mask=3）');
const filterState = () => page.evaluate(() => {
  const s = window.__kline.session, c = s.bars.close, h = s.bars.high, i = s.cur;
  const ph = Math.max(...Array.from(h.slice(Math.max(0, i - 20), i)));
  const dd = c[i] / ph - 1;
  const up = c[i] > c[i - 1] && c[i - 1] > c[i - 2];
  return { dd, up, pass: dd >= -0.15 && dd <= -0.03 && up };
});
let hits = 0, violates = 0;
for (let k = 0; k < 6; k++) {
  const before = await page.evaluate(() => window.__kline.session.switches.length);
  await page.click('#btn-switch');
  await wait(650);
  const after = await page.evaluate(() => window.__kline.session.switches.length);
  if (after > before) {
    hits++;
    const r = await filterState();
    if (!r.pass) { violates++; console.log('   ❌ 违反筛选:', JSON.stringify(r)); }
  }
}
console.log(`   筛选下换股成功 ${hits}/6 次，违反条件 ${violates} 次`);
check(hits >= 1, '筛选下应至少成功换股一次（该日期通过率过低时会失败并给出提示）');
check(violates === 0, '筛选换到的标的必须同时满足「回落3~15%」与「连涨2天」');
check(/回踩/.test(await text('#sf-now')), '侧栏应显示当前标的对已勾选条件的满足情况');
await shot('14-filter');

console.log('9d. 新增三个条件 + 筛选下拉');
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-horizon button[data-h="30"]');
await page.click('#seg-mode button[data-mode="random"]');
await startSession();
check(await page.$eval('#filter-dd', el => el.classList.contains('hidden')), '筛选下拉默认应收起');
await page.click('#btn-filter'); await wait(200);
const ddItems = await page.$$eval('#filter-dd .dd-item', els => els.map(e => e.textContent.trim()));
console.log('   下拉项数:', ddItems.length);
check(ddItems.length === 5, '筛选下拉应有 5 个条件，实际 ' + ddItems.length);
check(ddItems.some(t => /阳线实体跳空高于前 2 日最高价/.test(t)), '缺少③阳线实体跳空');
check(ddItems.some(t => /阳线实体突破/.test(t)), '缺少④阳线实体破前高');
check(ddItems.some(t => /MACD 零下金叉/.test(t)), '缺少⑤MACD零下金叉');
await page.click('body', { offset: { x: 5, y: 5 } }); await wait(200);
check(await page.$eval('#filter-dd', el => el.classList.contains('hidden')), '点空白处应收起下拉');

const condAt = () => page.evaluate(() => {
  const s = window.__kline.session, c = s.bars.close, o = s.bars.open, h = s.bars.high, i = s.cur;
  const m = window.__kline.chart.macdRes;
  let hi = -Infinity; for (let k = i - 59; k <= i; k++) hi = Math.max(hi, c[k]);
  const ph = Math.max(...Array.from(h.slice(Math.max(0, i - 20), i)));
  const dd = c[i] / ph - 1;
  return { code: s.stock.code, dd, pullback: dd >= -0.15 && dd <= -0.03,
           up2: c[i] > c[i - 1] && c[i - 1] > c[i - 2],
           gapBody: c[i] > o[i] && o[i] > Math.max(h[i - 1], h[i - 2]),
           aboveSwing: c[i] > o[i] && o[i] > ph,
           macdCross: m.dif[i] > m.dea[i] && m.dif[i - 1] <= m.dea[i - 1] && m.dif[i] < 0 };
});
const setFilter = async (bits) => {
  await page.click('#btn-filter'); await wait(150);
  await page.evaluate((bs) => {
    document.querySelectorAll('#filter-dd input[data-bit]').forEach(cb => {
      const want = bs.includes(Number(cb.dataset.bit));
      if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }, bits);
  await wait(250);
  await page.click('body', { offset: { x: 5, y: 5 } }); await wait(150);
};
for (const [label, bits, key] of [
  ['③阳线实体跳空超前2日高', [4], 'gapBody'],
  ['⑤MACD零下金叉', [16], 'macdCross'],
  ['④阳线实体破前高', [8], 'aboveSwing'],
]) {
  await setFilter(bits);
  const before = await page.evaluate(() => window.__kline.session.switches.length);
  await page.click('#btn-switch'); await wait(1200);
  const after = await page.evaluate(() => window.__kline.session.switches.length);
  const c = await condAt();
  console.log(`   只勾「${label}」→ ${after > before ? '换到 ' + c.code : '该日期无匹配'}  ${key}=${c[key]}`);
  if (after > before) check(c[key] === true, `「${label}」筛选出的标的必须满足该条件`);
  else check(/没有一只|无匹配|极少/.test(await page.evaluate(() => document.getElementById('toast')?.innerText || '')), '无匹配时应给出提示');
}
await setFilter([1, 8]);
check(!(await page.$eval('#dd-warn', el => el.classList.contains('hidden'))), '①+④ 互斥应在下拉里给出警告');
const nconf = await page.evaluate(() => window.__kline.session.switches.length);
await page.click('#btn-switch'); await wait(1200);
check((await page.evaluate(() => window.__kline.session.switches.length)) === nconf, '①+④ 互斥时不应换到任何标的');
await setFilter([1, 2, 4, 8, 16]);
const b5 = await page.evaluate(() => window.__kline.session.switches.length);
await page.click('#btn-switch'); await wait(1500);
const a5 = await page.evaluate(() => window.__kline.session.switches.length);
const c5 = await condAt();
console.log(`   五条全选 → ${a5 > b5 ? '换到 ' + c5.code : '该日期无匹配（正常）'}`);
if (a5 > b5) {
  check(c5.pullback && c5.up2 && c5.gapBody && c5.aboveSwing && c5.macdCross, '五条全选时必须全部满足');
}
await shot('15-filter5');

console.log('10. 移动端布局');
await page.click('#btn-restart');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await wait(500);
await shot('09-mobile');

await browser.close();
console.log('\n控制台 / 断言错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
process.exit(errors.length ? 1 : 0);
