// ===== カスタムMA（SMA/EMA混在対応）=====
var _maTypes = ['SMA','SMA','SMA']; // applyMAから更新される

klinecharts.registerIndicator({
  name: 'CustomMA',
  shortName: 'MA',
  calcParams: [20, 50, 200],
  figures: [],
  regenerateFigures: (params) => params.map((_, i) => ({
    key: `ma${i}`, title: `${(_maTypes[i]||'SMA')==='EMA'?'EMA':'MA'}${params[i]}: `, type: 'line'
  })),
  calc: (dataList, { calcParams }) => {
    const result = [];
    const emaMultipliers = calcParams.map(p => 2 / (p + 1));
    const emaPrev = new Array(calcParams.length).fill(null);

    for (let i = 0; i < dataList.length; i++) {
      const item = {};
      for (let j = 0; j < calcParams.length; j++) {
        const period = calcParams[j];
        const type = _maTypes[j] || 'SMA';
        if (type === 'EMA') {
          if (emaPrev[j] === null) {
            if (i >= period - 1) {
              let sum = 0;
              for (let k = i - period + 1; k <= i; k++) sum += dataList[k].close;
              emaPrev[j] = sum / period;
            }
          } else {
            emaPrev[j] = (dataList[i].close - emaPrev[j]) * emaMultipliers[j] + emaPrev[j];
          }
          item[`ma${j}`] = emaPrev[j];
        } else {
          if (i >= period - 1) {
            let sum = 0;
            for (let k = i - period + 1; k <= i; k++) sum += dataList[k].close;
            item[`ma${j}`] = sum / period;
          }
        }
      }
      result.push(item);
    }
    return result;
  }
});

// ===== FVG（Fair Value Gap）=====
var fvgEnabled = JSON.parse(localStorage.getItem('fvgEnabled') || 'false');
var fvgCache = []; // { top, bottom, startTs, bullish }
var fvgCacheIdx = -1;
var fvgCacheTF = -1;

function detectFVGs() {
  if (fvgCacheIdx === curIdx1m && fvgCacheTF === curTF) return;
  fvgCacheIdx = curIdx1m; fvgCacheTF = curTF;
  fvgCache = [];
  if (!fvgEnabled) return;

  const tfBars = aggregateBars(bars1m.slice(0, curIdx1m + 1), curTF);

  // 最小ギャップサイズ: 直近50本のATR的な平均レンジの30%
  const recentBars = tfBars.slice(-50);
  const avgRange = recentBars.reduce((s, b) => s + (b.h - b.l), 0) / recentBars.length;
  const minGap = avgRange * 0.3;

  const lastPrice = tfBars[tfBars.length - 1]?.c || 0;

  for (let i = 2; i < tfBars.length; i++) {
    const prev = tfBars[i - 2];
    const curr = tfBars[i - 1];
    const next = tfBars[i];

    let top, bottom, bullish;
    // Bullish FVG
    if (prev.h < next.l) {
      top = next.l; bottom = prev.h; bullish = true;
    }
    // Bearish FVG
    else if (prev.l > next.h) {
      top = prev.l; bottom = next.h; bullish = false;
    }
    else continue;

    const gap = top - bottom;
    // フィルタ: 小さいギャップを除外
    if (gap < minGap) continue;

    // 埋められたFVGを除外（その後の価格がゾーンを完全に通過）
    let mitigated = false;
    for (let j = i + 1; j < tfBars.length; j++) {
      if (bullish && tfBars[j].l <= bottom) { mitigated = true; break; }
      if (!bullish && tfBars[j].h >= top) { mitigated = true; break; }
    }
    if (mitigated) continue;

    fvgCache.push({
      top, bottom,
      startTs: curr.t * 1000,
      endTs: next.t * 1000,
      bullish
    });
  }
  // 直近50個に制限
  if (fvgCache.length > 50) fvgCache = fvgCache.slice(-50);
}

function drawFVGs() {
  if (!fvgEnabled || fvgCache.length === 0) return;
  const w = chartDiv.clientWidth;
  fvgCache.forEach(fvg => {
    const x1 = timeToX(fvg.startTs);
    const yTop = priceToY(fvg.top);
    const yBot = priceToY(fvg.bottom);
    if (x1 === null || yTop === null || yBot === null) return;
    if (yTop > chartDiv.clientHeight || yBot < 0) return;

    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = fvg.bullish ? '#26a69a' : '#ef5350';
    ctx.fillRect(x1, yTop, w - x1, yBot - yTop);
    // 上下の境界線のみ
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = fvg.bullish ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, yTop); ctx.lineTo(w, yTop);
    ctx.moveTo(x1, yBot); ctx.lineTo(w, yBot);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });
}

// ===== BOS / CHoCH =====
var bosEnabled = JSON.parse(localStorage.getItem('bosEnabled') || 'false');
var bosCache = []; // { type:'BOS'|'CHoCH', bullish, price, ts, swingPrice }
var bosCacheIdx = -1;
var bosCacheTF = -1;

// スイングポイント検出（N本lookback）
function findSwings(bars, lookback) {
  const swings = []; // { type:'H'|'L', price, idx, ts }
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].h <= bars[i-j].h || bars[i].h <= bars[i+j].h) isHigh = false;
      if (bars[i].l >= bars[i-j].l || bars[i].l >= bars[i+j].l) isLow = false;
    }
    if (isHigh) swings.push({ type: 'H', price: bars[i].h, idx: i, ts: bars[i].t * 1000 });
    if (isLow) swings.push({ type: 'L', price: bars[i].l, idx: i, ts: bars[i].t * 1000 });
  }
  return swings;
}

function detectBOS() {
  if (bosCacheIdx === curIdx1m && bosCacheTF === curTF) return;
  bosCacheIdx = curIdx1m; bosCacheTF = curTF;
  bosCache = [];
  if (!bosEnabled) return;

  const tfBars = aggregateBars(bars1m.slice(0, curIdx1m + 1), curTF);
  if (tfBars.length < 20) return;

  // 時間足に応じたlookback（約3時間分）
  const lookback = 5;
  const swings = findSwings(tfBars, lookback);
  if (swings.length < 3) return;

  // トレンド追跡
  let lastHH = null, lastLL = null, lastHL = null, lastLH = null;
  let trend = 0; // 1=up, -1=down, 0=unknown

  for (let i = 0; i < swings.length; i++) {
    const sw = swings[i];
    if (sw.type === 'H') {
      if (lastHH !== null) {
        // 前回のスイングHighを上抜け → BOS(上) or CHoCH
        for (let j = sw.idx; j < Math.min(sw.idx + 5, tfBars.length); j++) {
          if (tfBars[j].h > lastHH.price) {
            const isBOS = trend >= 0;
            bosCache.push({
              type: isBOS ? 'BOS' : 'CHoCH',
              bullish: true,
              price: lastHH.price,
              ts: tfBars[j].t * 1000,
              startTs: lastHH.ts,
              swingIdx: lastHH.idx
            });
            trend = 1;
            break;
          }
        }
      }
      lastHH = sw;
      lastLH = sw;
    } else {
      if (lastLL !== null) {
        // 前回のスイングLowを下抜け → BOS(下) or CHoCH
        for (let j = sw.idx; j < Math.min(sw.idx + 5, tfBars.length); j++) {
          if (tfBars[j].l < lastLL.price) {
            const isBOS = trend <= 0;
            bosCache.push({
              type: isBOS ? 'BOS' : 'CHoCH',
              bullish: false,
              price: lastLL.price,
              ts: tfBars[j].t * 1000,
              startTs: lastLL.ts,
              swingIdx: lastLL.idx
            });
            trend = -1;
            break;
          }
        }
      }
      lastLL = sw;
      lastHL = sw;
    }
  }
  // 直近100個に制限
  if (bosCache.length > 30) bosCache = bosCache.slice(-30);
}

function drawBOS() {
  if (!bosEnabled || bosCache.length === 0) return;
  const w = chartDiv.clientWidth;
  bosCache.forEach(b => {
    const x = timeToX(b.ts);
    const y = priceToY(b.price);
    const xStart = timeToX(b.startTs);
    if (x === null || y === null) return;

    ctx.save();
    // 水平線（ブレイクされたスイングレベル）
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = b.bullish ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    if (xStart !== null) { ctx.moveTo(xStart, y); } else { ctx.moveTo(0, y); }
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // ラベル
    ctx.globalAlpha = 0.9;
    ctx.font = 'bold 10px monospace';
    const label = b.type;
    const color = b.type === 'CHoCH' ? '#ffeb3b' : (b.bullish ? '#26a69a' : '#ef5350');
    ctx.fillStyle = color;
    const labelY = b.bullish ? y - 5 : y + 12;
    ctx.fillText(label, x + 3, labelY);
    ctx.restore();
  });
}

// ===== Order Block =====
var obEnabled = JSON.parse(localStorage.getItem('obEnabled') || 'false');
var obCache = []; // { top, bottom, ts, bullish, mitigated }
var obCacheIdx = -1;
var obCacheTF = -1;

function detectOB() {
  if (obCacheIdx === curIdx1m && obCacheTF === curTF) return;
  obCacheIdx = curIdx1m; obCacheTF = curTF;
  obCache = [];
  if (!obEnabled) return;

  const tfBars = aggregateBars(bars1m.slice(0, curIdx1m + 1), curTF);
  if (tfBars.length < 20) return;

  // BOSが検出済みであることが前提
  if (bosCache.length === 0) { detectBOS(); }

  // 直近20個のBOSからOBを検出（古いものはほぼ mitigated）
  const recentBOS = bosCache.slice(-20);
  recentBOS.forEach(bos => {
    const targetIdx = bos.swingIdx;
    if (targetIdx === undefined || targetIdx < 1) return;

    // Bullish BOS → スイング安値付近の最後の陰線がOB
    // Bearish BOS → スイング高値付近の最後の陽線がOB
    for (let j = targetIdx; j >= Math.max(0, targetIdx - 10); j--) {
      const bar = tfBars[j];
      if (bos.bullish && bar.c < bar.o) {
        const ob = { top: Math.max(bar.o, bar.h), bottom: Math.min(bar.c, bar.l), ts: bar.t * 1000, bullish: true };
        // 完全貫通でmitigated（終値がゾーンを超えた場合）
        let mitigated = false;
        for (let k = j + 1; k < tfBars.length; k++) {
          if (tfBars[k].c <= ob.bottom) { mitigated = true; break; }
        }
        if (!mitigated) obCache.push(ob);
        break;
      }
      if (!bos.bullish && bar.c > bar.o) {
        const ob = { top: Math.max(bar.c, bar.h), bottom: Math.min(bar.o, bar.l), ts: bar.t * 1000, bullish: false };
        let mitigated = false;
        for (let k = j + 1; k < tfBars.length; k++) {
          if (tfBars[k].c >= ob.top) { mitigated = true; break; }
        }
        if (!mitigated) obCache.push(ob);
        break;
      }
    }
  });
  // 直近50個に制限
  if (obCache.length > 50) obCache = obCache.slice(-50);
}

function drawOB() {
  if (!obEnabled || obCache.length === 0) return;
  const w = chartDiv.clientWidth;
  obCache.forEach(ob => {
    const x = timeToX(ob.ts);
    const yTop = priceToY(ob.top);
    const yBot = priceToY(ob.bottom);
    if (x === null || yTop === null || yBot === null) return;
    if (yTop > chartDiv.clientHeight || yBot < 0) return;

    ctx.save();
    // ゾーン（左端に太い縦線 + 薄い背景）
    const color = ob.bullish ? '#ff9800' : '#ab47bc';
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.fillRect(x, yTop, w - x, yBot - yTop);
    // 左端の太い縦バー
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = color;
    ctx.fillRect(x, yTop, 3, yBot - yTop);
    // 上下ライン（実線）
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yTop); ctx.lineTo(w, yTop);
    ctx.moveTo(x, yBot); ctx.lineTo(w, yBot);
    ctx.stroke();
    // ラベル
    ctx.globalAlpha = 0.8;
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = color;
    ctx.fillText('OB', x + 6, yTop + 10);
    ctx.restore();
  });
}

// ===== 時間帯レンジ =====
var rangeEnabled = JSON.parse(localStorage.getItem('rangeEnabled') || 'false');
var rangeSetting = JSON.parse(localStorage.getItem('rangeSetting') || '{"from":"07:00","to":"09:00","end":"05:00"}');
var rangeCache = []; // { high, low, drawStartTs, drawEndTs }
var rangeCacheIdx = -1;
var rangeCacheTF = -1;

function jstHourMin(ts) {
  const d = new Date(ts * 1000);
  return (d.getUTCHours() + 9) % 24 * 60 + d.getUTCMinutes();
}
function parseHM(s) { const [h,m] = s.split(':').map(Number); return h * 60 + m; }

function detectRanges() {
  if (rangeCacheIdx === curIdx1m && rangeCacheTF === curTF) return;
  rangeCacheIdx = curIdx1m; rangeCacheTF = curTF;
  rangeCache = [];
  if (!rangeEnabled) return;

  const fromMin = parseHM(rangeSetting.from); // JST分
  const toMin = parseHM(rangeSetting.to);
  const endMin = parseHM(rangeSetting.end);

  // 1分足でスキャン（表示中のバーのみ）
  const visibleBars = bars1m.slice(0, curIdx1m + 1);
  let currentRange = null; // { high, low, rangeEndTs }
  let drawing = null; // { high, low, drawStartTs }

  for (let i = 0; i < visibleBars.length; i++) {
    const b = visibleBars[i];
    const hm = jstHourMin(b.t);

    // レンジ時間帯内
    if (hm >= fromMin && hm < toMin) {
      if (!currentRange) {
        currentRange = { high: b.h, low: b.l };
      } else {
        if (b.h > currentRange.high) currentRange.high = b.h;
        if (b.l < currentRange.low) currentRange.low = b.l;
      }
    }
    // レンジ時間帯終了 → 描画開始
    else if (currentRange && hm >= toMin) {
      if (!drawing) {
        drawing = { high: currentRange.high, low: currentRange.low, drawStartTs: b.t * 1000 };
      }
    }
    // 終了時間到達 → 確定
    if (drawing && ((endMin < toMin && hm >= endMin && hm < fromMin) || (endMin >= toMin && hm >= endMin))) {
      rangeCache.push({ ...drawing, drawEndTs: b.t * 1000 });
      drawing = null;
      currentRange = null;
    }
    // 次のレンジ開始 → 前の描画を確定
    if (drawing && hm >= fromMin && hm < toMin) {
      rangeCache.push({ ...drawing, drawEndTs: b.t * 1000 });
      drawing = null;
      currentRange = { high: b.h, low: b.l };
    }
  }
  // 未確定の描画中レンジ → 右端まで延長
  if (drawing) {
    // 終了時間のTSを計算（当日のJST endMin）
    const lastBar = visibleBars[visibleBars.length - 1];
    const lastD = new Date(lastBar.t * 1000);
    const endH = Math.floor(endMin / 60);
    const endM = endMin % 60;
    // JST→UTC: JST endHour - 9
    let endUTC = new Date(lastD);
    endUTC.setUTCHours(((endH - 9) + 24) % 24, endM, 0, 0);
    // endが翌日の場合（例: JST 5:00 = UTC 20:00 前日）
    if (endUTC.getTime() <= drawing.drawStartTs) {
      endUTC.setUTCDate(endUTC.getUTCDate() + 1);
    }
    rangeCache.push({ ...drawing, drawEndTs: endUTC.getTime() });
  }
  // 直近20個に制限
  if (rangeCache.length > 20) rangeCache = rangeCache.slice(-20);
}

function drawRanges() {
  if (!rangeEnabled || rangeCache.length === 0) return;
  rangeCache.forEach(r => {
    const x1 = timeToX(r.drawStartTs);
    const x2 = timeToX(r.drawEndTs);
    const yH = priceToY(r.high);
    const yL = priceToY(r.low);
    if (x1 === null || x2 === null || yH === null || yL === null) return;

    ctx.save();
    // ゾーン背景
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ff9800';
    ctx.fillRect(x1, yH, x2 - x1, yL - yH);
    // 高値ライン
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, yH); ctx.lineTo(x2, yH);
    ctx.stroke();
    // 安値ライン
    ctx.beginPath();
    ctx.moveTo(x1, yL); ctx.lineTo(x2, yL);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });
}
