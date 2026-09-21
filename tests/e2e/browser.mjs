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
 * 覆盖：开局设置 → 随机抽样 → 画布真的画出红绿 K 线 → 观望 → 买入确认 →
 *       十字光标 → 自动结算 → 指定代码检索 → 一手买不起的保护 → 结束交易清仓 → 移动端布局。
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

console.log('1. 开局设置');
await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
await page.waitForSelector('#modal-setup:not(.hidden)');
const pool = await page.$eval('#pool-hint', el => el.textContent);
console.log('   样本池:', pool);
check(/样本池 \d+ 只股票/.test(pool), '样本池提示异常');
await shot('01-setup');

console.log('2. 随机开局 + 画布渲染');
await page.click('#seg-horizon button[data-h="60"]');
await page.click('#seg-pos button[data-pos="0.5"]');
await page.click('#btn-start');
await page.waitForFunction(() => document.getElementById('modal-setup').classList.contains('hidden'), { timeout: 20000 });
await wait(600);
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
check(!(await page.$eval('#btn-buy', el => el.disabled)), '买入按钮应可用');
await shot('02-session');

console.log('3. 观望 + 买入');
for (let i = 0; i < 3; i++) { await page.click('#btn-hold'); await wait(80); }
check(await page.$eval('#hud-progress', el => el.textContent.startsWith('3 /')), '观望 3 日进度异常');
await page.click('#btn-buy');
await page.waitForSelector('#modal-confirm:not(.hidden)');
check(/开盘价/.test(await page.$eval('#cf-body', el => el.textContent)), '确认框未提示次日开盘价');
await page.click('#cf-ok');
await wait(700);
const held = await page.evaluate(() => ({
  shares: document.getElementById('pos-shares').textContent,
  log: document.getElementById('log-list').textContent.replace(/\s+/g, ' '),
}));
console.log('   ', JSON.stringify(held));
check(/股/.test(held.shares), '买入后没有持仓');
check(/买/.test(held.log), '成交流水没有买入记录');
await shot('03-after-buy');

console.log('4. 十字光标');
const box = await page.$eval('#chart', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.3);
await wait(250);
await shot('04-crosshair');

console.log('5. 跑到期满自动结算');
for (let i = 0; i < 80; i++) {
  if (await page.evaluate(() => !document.getElementById('modal-result').classList.contains('hidden'))) break;
  if (await page.evaluate(() => document.getElementById('btn-hold').disabled)) break;
  await page.click('#btn-hold');
  await wait(40);
}
await page.waitForSelector('#modal-result:not(.hidden)', { timeout: 15000 });
const rs = await page.evaluate(() => ({
  ret: document.getElementById('rs-return').textContent,
  sub: document.getElementById('rs-sub').textContent,
  stock: document.getElementById('rs-stock').textContent,
}));
console.log('   ', JSON.stringify(rs));
check(/^[+-]\d/.test(rs.ret), '结算面板没有突出收益率');
await shot('05-result');

console.log('6. 指定代码 + 一手买不起保护');
await page.click('#rs-again');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.click('#seg-mode button[data-mode="pick"]');
await page.type('#pick-input', '茅台');
await wait(300);
check((await page.$$('#pick-list button')).length > 0, '代码检索无结果');
await page.click('#pick-list button');
await page.click('#seg-horizon button[data-h="30"]');
await page.click('#btn-start');
await page.waitForFunction(() => document.getElementById('modal-setup').classList.contains('hidden'), { timeout: 20000 });
await wait(500);
await page.click('#btn-buy');
await page.waitForSelector('#modal-confirm:not(.hidden)');
check(await page.$eval('#cf-ok', el => el.disabled), '买不起一手时确定按钮应禁用');
console.log('   ', await page.$eval('#cf-body', el => el.textContent.replace(/\s+/g, ' ')));
await shot('06-no-funds');
await page.click('#cf-cancel');

console.log('7. 结束交易清仓');
await page.click('#btn-restart');
await page.waitForSelector('#modal-setup:not(.hidden)');
await page.focus('#pick-input');
await page.keyboard.down('Control');
await page.keyboard.press('KeyA');
await page.keyboard.up('Control');
await page.keyboard.press('Backspace');
await page.type('#pick-input', '平安银行');
await wait(300);
await page.click('#pick-list button');
await page.click('#btn-start');
await page.waitForFunction(() => document.getElementById('modal-setup').classList.contains('hidden'), { timeout: 20000 });
await wait(500);
await page.click('#btn-buy');
await page.waitForSelector('#modal-confirm:not(.hidden)');
await page.click('#cf-ok');
await wait(700);
await page.click('#btn-end');
await page.waitForSelector('#modal-confirm:not(.hidden)');
console.log('   ', await page.$eval('#cf-body', el => el.textContent.replace(/\s+/g, ' ')));
await page.click('#cf-ok');
await wait(900);
const end = await page.evaluate(() => ({
  log: document.getElementById('log-list').textContent.replace(/\s+/g, ' '),
  result: !document.getElementById('modal-result').classList.contains('hidden'),
}));
check(end.result, '结束交易未弹出结算面板');
check(/卖/.test(end.log), '结束交易没有清仓流水');
console.log('   ', JSON.stringify(end));
await shot('07-end');

console.log('8. 移动端布局');
await page.click('#rs-view');
await page.click('#btn-restart');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await wait(500);
await shot('08-mobile');

await browser.close();
console.log('\n控制台 / 断言错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
process.exit(errors.length ? 1 : 0);
