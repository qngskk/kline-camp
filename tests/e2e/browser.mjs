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

console.log('3. 同一天反复加仓（尾盘即时成交）');
const posOf = async () => parseFloat((await text('#act-pos')).replace('%', ''));
const p0 = await posOf();
await clickAdd('0.25');
await wait(250);
const p1 = await posOf();
await clickAdd('0.25');
await wait(250);
const p2 = await posOf();
await clickAdd('0.25');
await wait(250);
const p3 = await posOf();
console.log(`   仓位: ${p0}% → ${p1}% → ${p2}% → ${p3}%`);
check(p0 === 0, '开局应为空仓');
check(p1 > 1 && p2 > p1 && p3 > p2, '同一天连续加仓应让仓位逐步抬高');
check((await text('#hud-progress')).startsWith('0 /'), '尾盘模式当日操作不应推进日期');
const rows1 = await page.$$eval('#log-list .log-row', els => els.length);
console.log('   当日流水条数:', rows1);
check(rows1 >= 3, '同一天应产生 3 笔买入流水');

console.log('4. T+1：当日买入当日不能卖');
await clickReduce('0.5');
await wait(300);
const toastTxt = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
console.log('   提示:', toastTxt);
check(/T\+1/.test(toastTxt), '当日买入后减仓应提示 T+1');

console.log('5. 进入下一日后可以减仓');
await page.click('#btn-next');
await wait(400);
check((await text('#hud-progress')).startsWith('1 /'), '进入下一日后进度应为 1');
const beforeReduce = await posOf();
await clickReduce('0.5');
await wait(300);
const afterReduce = await posOf();
console.log(`   仓位: ${beforeReduce}% → ${afterReduce}%`);
check(afterReduce < beforeReduce, '减仓后仓位应下降');
check(afterReduce > 0, '减半后仍有持仓');
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
const pend = await page.$$eval('#pending-list .pend', els => els.map(e => e.textContent.replace('×', '')));
console.log('   委托篮:', JSON.stringify(pend));
check(pend.length === 2, '两笔委托应都进篮');
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

console.log('10. 移动端布局');
await page.click('#rs-view');
await page.click('#btn-restart');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await wait(500);
await shot('09-mobile');

await browser.close();
console.log('\n控制台 / 断言错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
process.exit(errors.length ? 1 : 0);
