// ===== チャート初期化 =====
var chart = klinecharts.init('chart', {
  styles: {
    candle: {
      bar: { upColor: '#26a69a', downColor: '#ef5350', upBorderColor: '#26a69a', downBorderColor: '#ef5350', upWickColor: '#26a69a', downWickColor: '#ef5350' },
      priceMark: { last: { show: false } },
      tooltip: { showRule: 'none' }
    },
    grid: { horizontal: { color: '#2a2a3a' }, vertical: { color: '#2a2a3a' } },
    crosshair: { show: true, text: { show: false }, horizontal: { show: true }, vertical: { show: true } },
    indicator: { tooltip: { showName: false, showParams: false } },
    xAxis: { tickText: { color: '#aaa' }, scrollZoomEnabled: true },
    yAxis: { tickText: { color: '#aaa' }, scrollZoomEnabled: true },
  }
});

// リサイズ対応
new ResizeObserver(() => chart.resize()).observe(document.getElementById('chart'));

// ===== データ読み込み =====
var bars1m   = [];  // 元の1分足（常に保持）
var curIdx1m = 200; // 常に bars1m のインデックス
var curTF    = 5;
var playing  = false;
var timer    = null;

// 1分足 → 任意時間足に集計
function aggregateBars(bars, tfMin) {
  if (tfMin === 1) return bars;
  const tfSec = tfMin * 60;
  const result = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / tfSec) * tfSec;
    if (!cur || cur.t !== bucket) {
      if (cur) result.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
    }
  }
  if (cur) result.push(cur);
  return result;
}

// 現在の1m位置から部分TFバーを返す
function getPartialBar(idx) {
  if (curTF === 1) return bars1m[idx];
  const tfSec = curTF * 60;
  const bucket = Math.floor(bars1m[idx].t / tfSec) * tfSec;
  let start = idx;
  while (start > 0 && Math.floor(bars1m[start-1].t / tfSec) * tfSec === bucket) start--;
  let bar = { t: bucket, o: bars1m[start].o, h: -Infinity, l: Infinity, c: bars1m[idx].c };
  for (let j = start; j <= idx; j++) {
    if (bars1m[j].h > bar.h) bar.h = bars1m[j].h;
    if (bars1m[j].l < bar.l) bar.l = bars1m[j].l;
  }
  return bar;
}

(async () => {
  await openDB();
  // キャッシュから読み込み、なければfetch→パース→キャッシュ
  let data = null;
  if (db && db.objectStoreNames.contains('dataCache')) {
    data = await new Promise(r => {
      const req = db.transaction('dataCache','readonly').objectStore('dataCache').get('bars1m');
      req.onsuccess = () => r(req.result?.data || null);
      req.onerror = () => r(null);
    });
  }
  if (!data) {
    const raw = await fetch('ohlc_1m.json.gz').then(r => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json());
    data = [];
    for (let i = 0; i < raw.length; i += 5) {
      data.push({ t: raw[i], o: raw[i+1], h: raw[i+2], l: raw[i+3], c: raw[i+4] });
    }
    if (db && db.objectStoreNames.contains('dataCache')) {
      try { db.transaction('dataCache','readwrite').objectStore('dataCache').put({ id: 'bars1m', data }); } catch(e) {}
    }
  }
  bars1m = data;
    // 各取引日のJST 9:00（UTC 0:00）以降の最初のバーを収集
    const dayStarts = [];
    let lastDate = '';
    for (let i = 0; i < bars1m.length; i++) {
      const d = new Date(bars1m[i].t * 1000);
      if (d.getUTCHours() < 0) continue; // UTC 0時未満はスキップ（ありえないが安全策）
      const dateStr = d.toISOString().slice(0, 10);
      if (dateStr !== lastDate && d.getUTCHours() >= 0 && d.getUTCHours() <= 2) {
        // UTC 0:00〜2:00（JST 9:00〜11:00）の範囲で日の最初のバー
        dayStarts.push(i);
        lastDate = dateStr;
      }
    }
    // 日足200MA用に過去約200営業日分さかのぼれるようにする
    const PAST_BARS = 220000;
    const candidates = dayStarts.filter(i => i >= PAST_BARS && i + 1440 < bars1m.length);
    // URLパラメータで復習モード対応
    const urlParams = new URLSearchParams(location.search);
    const reviewIdx = urlParams.get('startIdx');
    if (reviewIdx !== null) {
      curIdx1m = Math.min(parseInt(reviewIdx), bars1m.length - 1);
    } else if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      curIdx1m = pick;
    } else {
      curIdx1m = Math.min(PAST_BARS, bars1m.length - 1);
    }
    sessionStartIdx = curIdx1m;
    // セッション情報をDBに保存
    const startBar = bars1m[curIdx1m];
    const startDate = new Date(startBar.t * 1000).toISOString();
    dbPut('sessions', { id: sessionId, startIdx: curIdx1m, startDate, startPrice: startBar.c, playedAt: new Date().toISOString(), trades: 0, totalPnL: 0, memo: '' }).catch(() => {});

    // 復習モード: 前回の描画データを復元
    const reviewSession = urlParams.get('session');
    if (reviewSession && db) {
      try {
        // 描画データ復元
        const tx = db.transaction(['sessions', 'trades'], 'readonly');
        const sReq = tx.objectStore('sessions').get(parseInt(reviewSession));
        const tIdx = tx.objectStore('trades').index('sessionId');
        const tReq = tIdx.getAll(parseInt(reviewSession));
        let loaded = 0;
        function checkDone() { if (++loaded >= 2) renderBars(); }
        sReq.onsuccess = () => {
          const s = sReq.result;
          if (s && s.drawings) {
            fiboSaved = s.drawings.fibo || [];
            hlineSaved = s.drawings.hline || [];
            tlineSaved = s.drawings.tline || [];
          }
          checkDone();
        };
        tReq.onsuccess = () => {
          tradeHistory = tReq.result || [];
          checkDone();
        };
        sReq.onerror = () => checkDone();
        tReq.onerror = () => checkDone();
      } catch(e) { renderBars(); }
    } else {
      renderBars();
    }
})();

function toKLine(b) {
  return { timestamp: b.t * 1000, open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 };
}

function renderBars() {
  // MA200用に十分なバーを確保しつつ、表示量を制限
  const maBuffer = 200 * curTF; // MA200に必要な1m足数
  const displayBars = 2000;     // 画面表示用
  const startFrom = Math.max(0, curIdx1m - (maBuffer + displayBars));
  const visible = aggregateBars(bars1m.slice(startFrom, curIdx1m + 1), curTF).map(toKLine);
  chart.applyNewData(visible);
  scheduleYAxisManual();
  const bar = bars1m[curIdx1m];
  document.getElementById('cur-time').textContent =
    new Date(bar.t * 1000).toLocaleString('ja-JP', { timeZone:'UTC', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  livePrice = bar.c;
  document.getElementById('cur-price').textContent = bar.c.toFixed(3);
  updatePnL(bar.c);
}

// applyNewData後にY軸の自動スケールが走った後で無効化する
var _yManualTimer = null;
function scheduleYAxisManual() {
  clearTimeout(_yManualTimer);
  _yManualTimer = setTimeout(enableYAxisManualMode, 100);
}

// Y軸手動モードに切り替え（初回のみ）→ 縦パン有効化
function enableYAxisManualMode() {
  try {
    const pane = chart.getDrawPaneById('candle_pane');
    if (pane && pane._axis) pane._axis._autoCalcTickFlag = false;
  } catch(e) {}
}

// ===== 時間足切り替え =====
document.getElementById('tf-select').addEventListener('change', e => {
  const tf = parseInt(e.target.value);
  if (tf === curTF) return;
  stopPlay(); playing = false; btnPlay.textContent = '▶︎';
  curTF = tf;
  renderBars();
});

// ===== 再生制御 =====
var btnPlay = document.getElementById('btn-play');
var speedEl = document.getElementById('speed');

btnPlay.addEventListener('click', () => {
  playing = !playing;
  btnPlay.textContent = playing ? '⏸︎' : '▶︎';
  if (playing) startPlay(); else stopPlay();
});

// ===== 擬似ティック生成（ブラウン橋 + ボラクラスタリング）=====
// 両端固定のランダムウォーク。H/Lを必ず通りながらOHLC辻褄を合わせる
function brownBridge(from, to, steps, volatility) {
  // ブラウン橋: 各ステップで「終点への誘導」+「ランダムノイズ」
  const pts = [from];
  let cur = from;
  // ボラティリティクラスター: 連続する動きの大きさを変化させる
  let vol = volatility;
  let momentum = 0;
  for (let i = 1; i <= steps; i++) {
    const remaining = steps - i + 1;
    const drift = (to - cur) / remaining;          // 終点へ引力
    vol = vol * (0.85 + Math.random() * 0.3);      // ボラのクラスタリング
    vol = Math.max(volatility * 0.3, Math.min(volatility * 2.5, vol));
    momentum = momentum * 0.6 + (Math.random() - 0.5) * vol; // モメンタム
    cur = cur + drift + momentum;
    pts.push(cur);
  }
  pts[pts.length - 1] = to;
  return pts;
}

function generateTicks(bar, numTicks) {
  const { o, h, l, c } = bar;
  const range = Math.max(h - l, 0.001);
  const vol   = range * 0.08; // 1ティックあたりのボラ基準

  // H/Lをどのタイミングで出すか乱数で決定
  const goHighFirst = Math.random() < 0.5;
  const ext1 = goHighFirst ? h : l;
  const ext2 = goHighFirst ? l : h;

  // 各セグメントにticksを配分（乱数でランダムな比率に）
  const r1 = 0.15 + Math.random() * 0.25;
  const r2 = 0.25 + Math.random() * 0.30;
  const n1  = Math.max(2, Math.round(numTicks * r1));
  const n2  = Math.max(2, Math.round(numTicks * r2));
  const n3  = Math.max(2, numTicks - n1 - n2);

  const seg1 = brownBridge(o,    ext1, n1, vol);
  const seg2 = brownBridge(ext1, ext2, n2, vol);
  const seg3 = brownBridge(ext2, c,    n3, vol);

  // 結合してH/L内にクランプ
  const raw = [...seg1, ...seg2.slice(1), ...seg3.slice(1)];
  const clamped = raw.map((p, i) =>
    i === 0 ? o : i === raw.length - 1 ? c : Math.max(l, Math.min(h, p))
  );

  // 低速時に「静止区間」をランダム挿入（同値を数回繰り返す）
  const spd = parseInt(speedEl.value);
  if (spd <= 4) {
    const result = [];
    for (let i = 0; i < clamped.length; i++) {
      result.push(clamped[i]);
      // 20〜40%の確率で同値を1〜4回追加（速度が遅いほど多く）
      if (Math.random() < 0.3) {
        const repeats = Math.floor(Math.random() * (5 - spd)) + 1;
        for (let r = 0; r < repeats; r++) result.push(clamped[i]);
      }
    }
    return result;
  }
  return clamped;
}

var tickQueue  = []; // 現在バーの擬似ティックキュー
var tickTimer  = null;
var livePrice  = 0;  // ティック再生中のリアルタイム価格

function flushTicks() { clearInterval(tickTimer); tickTimer = null; tickQueue = []; }

function startTickPlay(bar, onDone) {
  const spd    = parseInt(speedEl.value);
  const nTicks = Math.max(4, Math.round(20 - (spd - 1) * 1.8));
  tickQueue    = generateTicks(bar, nTicks);
  const effectiveDelay = getBarDelay(spd);
  const tickMs = Math.max(8, Math.round(effectiveDelay / tickQueue.length));

  // 現在1m足より前のバーで確定している TFバーのベース（H/Lを先読みしない）
  const baseBar = (() => {
    if (curTF === 1) return { t: bar.t, o: bar.o, h: bar.o, l: bar.o, c: bar.o };
    const tfSec  = curTF * 60;
    const bucket = Math.floor(bar.t / tfSec) * tfSec;
    let b = { t: bucket, o: null, h: -Infinity, l: Infinity, c: bar.o };
    for (let j = curIdx1m - 1; j >= 0; j--) {
      if (Math.floor(bars1m[j].t / tfSec) * tfSec !== bucket) break;
      if (b.o === null) b.o = bars1m[j].o; // さらに左→上書き
      b.o = bars1m[j].o;
      if (bars1m[j].h > b.h) b.h = bars1m[j].h;
      if (bars1m[j].l < b.l) b.l = bars1m[j].l;
    }
    if (b.o === null) { b.o = bar.o; b.h = bar.o; b.l = bar.o; }
    return b;
  })();

  let tickH = baseBar.h, tickL = baseBar.l;
  let i = 0;
  tickTimer = setInterval(() => {
    if (i >= tickQueue.length) { flushTicks(); onDone(); return; }
    const price = tickQueue[i++];
    livePrice = price;
    if (price > tickH) tickH = price;
    if (price < tickL) tickL = price;
    const partial = { t: baseBar.t, o: baseBar.o, h: tickH, l: tickL, c: price };
    chart.updateData(toKLine(partial));
    document.getElementById('cur-price').textContent = price.toFixed(3);
    updatePnL(price);
  }, tickMs);
}

function getBarDelay(spd) {
  return [8000,5000,3000,1500,600,250,100,50,25,10][spd - 1];
}

function startPlay() {
  function tick() {
    if (curIdx1m + 1 >= bars1m.length - 1) { stopPlay(); playing = false; btnPlay.textContent = '▶︎'; return; }
    const spd = parseInt(speedEl.value);
    if (spd >= 7) {
      // 高速モード: ティックアニメーションなし
      curIdx1m++;
      const bar = bars1m[curIdx1m];
      livePrice = bar.c;
      updateTimeLabel(bar);
      chart.updateData(toKLine(getPartialBar(curIdx1m)));
      document.getElementById('cur-price').textContent = bar.c.toFixed(3);
      updatePnL(bar.c);
      if (playing) timer = setTimeout(tick, getBarDelay(spd));
    } else {
      curIdx1m++;
      const bar = bars1m[curIdx1m];
      updateTimeLabel(bar);
      startTickPlay(bar, () => { if (playing) timer = setTimeout(tick, 0); });
    }
  }
  timer = setTimeout(tick, 0);
}

function stopPlay() { clearTimeout(timer); timer = null; flushTicks(); }

speedEl.addEventListener('input', () => { if (playing) { stopPlay(); startPlay(); } });

function updateTimeLabel(bar) {
  document.getElementById('cur-time').textContent =
    new Date(bar.t * 1000).toLocaleString('ja-JP', { timeZone:'UTC', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function advance(n) {
  if (curIdx1m + n >= bars1m.length - 1) return false;
  flushTicks();
  curIdx1m += n;
  chart.updateData(toKLine(getPartialBar(curIdx1m)));
  const bar = bars1m[curIdx1m];
  updateTimeLabel(bar);
  document.getElementById('cur-price').textContent = bar.c.toFixed(3);
  updatePnL(bar.c);
  return true;
}
