// ===== フィボナッチ（Canvasドラッグ方式）=====
const FIBO_LEVELS  = [0, 1.0, 1.236, 1.382, 1.618, 1.764, 2.0, 2.618];

// Canvas オーバーレイを chart div の上に重ねる
var chartDiv = document.getElementById('chart');
var fiboCanvas = document.createElement('canvas');
Object.assign(fiboCanvas.style, {
  position: 'absolute', top: '0', left: '0',
  pointerEvents: 'none', zIndex: '10', touchAction: 'none'
});
chartDiv.style.position = 'relative';
chartDiv.appendChild(fiboCanvas);
var ctx = fiboCanvas.getContext('2d');

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  fiboCanvas.width  = chartDiv.clientWidth  * dpr;
  fiboCanvas.height = chartDiv.clientHeight * dpr;
  fiboCanvas.style.width  = chartDiv.clientWidth  + 'px';
  fiboCanvas.style.height = chartDiv.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawFibo();
}
new ResizeObserver(resizeCanvas).observe(chartDiv);

// 保存済み描画オブジェクト
var fiboSaved  = []; // { p1, p2, t1, t2 }
var hlineSaved = []; // { price }
var tlineSaved = []; // { p1, p2, t1, t2 }
var fiboDrag   = null;
var tlineDrag  = null;
var curTool    = ''; // 'fibo' | 'hline' | 'tline' | ''
var editMode   = false; // 編集モード
var editTarget = null;  // { type, idx } 編集対象（nullなら全表示）

// 価格 → Y座標（KLineChart convertToPixel API）
function priceToY(price) {
  try {
    const r = chart.convertToPixel({ value: price }, { paneId: 'candle_pane', absolute: true });
    return r ? r.y : null;
  } catch(e) { return null; }
}

// 中央2点でms/pxを計算するヘルパー
function getMsPerPx() {
  const cx = fiboCanvas.width;
  const ra = chart.convertFromPixel({ x: cx * 0.3, y: 100 }, { paneId: 'candle_pane', absolute: true });
  const rb = chart.convertFromPixel({ x: cx * 0.7, y: 100 }, { paneId: 'candle_pane', absolute: true });
  if (ra?.timestamp && rb?.timestamp && rb.timestamp !== ra.timestamp) {
    return { msPerPx: (rb.timestamp - ra.timestamp) / (cx * 0.4), refX: cx * 0.7, refTs: rb.timestamp };
  }
  return null;
}

// ピクセル → タイムスタンプ
// convertFromPixelは最終バー以降をクランプするので、最終バーのX以降は外挿
function xToTime(x) {
  try {
    const lastTs = bars1m[curIdx1m]?.t * 1000;
    const lastPx = lastTs ? chart.convertToPixel({ timestamp: lastTs }, { paneId: 'candle_pane', absolute: true })?.x : null;

    if (lastPx !== null && lastPx !== undefined && x > lastPx + 2) {
      // 最終バーより右 → 外挿
      const ref = getMsPerPx();
      if (ref) return ref.refTs + (x - ref.refX) * ref.msPerPx;
      return lastTs + (x - lastPx) * (curTF * 60 * 1000); // 粗いフォールバック
    }
    const r = chart.convertFromPixel({ x, y: 100 }, { paneId: 'candle_pane', absolute: true });
    return (r?.timestamp) ? r.timestamp : null;
  } catch(e) { return null; }
}

// タイムスタンプ → ピクセルX
// 最終バー以降のtsはconvertToPixelがnullを返すので外挿
function timeToX(ts) {
  try {
    const lastTs = bars1m[curIdx1m]?.t * 1000;
    if (lastTs && ts > lastTs + curTF * 60 * 1000) {
      // 未来のts → 外挿
      const ref = getMsPerPx();
      if (ref) return ref.refX + (ts - ref.refTs) / ref.msPerPx;
      const lastPx = chart.convertToPixel({ timestamp: lastTs }, { paneId: 'candle_pane', absolute: true })?.x;
      if (lastPx !== null) return lastPx + (ts - lastTs) / (curTF * 60 * 1000);
      return null;
    }
    const r = chart.convertToPixel({ timestamp: ts }, { paneId: 'candle_pane', absolute: true });
    return (r?.x !== undefined && r.x !== null) ? r.x : null;
  } catch(e) { return null; }
}

// rawX1/rawX2: ドラッグ中の生ピクセル（指定時はtsよりも優先）
function drawOneFibo(p1, p2, t1, t2, alpha = 1.0, rawX1 = null, rawX2 = null) {
  const range  = Math.abs(p1 - p2);
  const isDown = p1 >= p2;

  const xa = timeToX(t1) ?? rawX1;
  const xb = timeToX(t2) ?? rawX2;
  const xL = Math.min(xa ?? 0,              xb ?? fiboCanvas.width);
  const xR = Math.max(xa ?? 0,              xb ?? fiboCanvas.width);

  FIBO_LEVELS.forEach((lvl, i) => {
    // 100% = p1（ドラッグ開始点）、0% = p2、以降は同方向に延伸
    const price = isDown ? (p2 + range * lvl) : (p2 - range * lvl);
    const y = priceToY(price);
    if (y === null || y < 0 || y > fiboCanvas.height) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xL, y);
    ctx.lineTo(xR, y);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle   = '#ffffff';
    ctx.font        = '11px monospace';
    const labelY = isDown ? y - 3 : y + 12;
    const labelText = lvl === 0 ? '' : `${lvl}`;
    ctx.fillText(labelText, Math.min(xR + 4, fiboCanvas.width - 115), labelY);
    ctx.restore();
  });
}

const HANDLE_R = 6; // ハンドル半径(px)

function drawOneHLine(price, alpha = 1.0) {
  const y = priceToY(price);
  const w = chartDiv.clientWidth;
  if (y === null || y < 0 || y > chartDiv.clientHeight) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#ffeb3b';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  // Y軸上に価格ラベル
  ctx.font = 'bold 10px monospace';
  const label = price.toFixed(2);
  const tw = ctx.measureText(label).width;
  const lx = w - tw - 4;
  ctx.fillStyle = '#ffeb3bcc';
  ctx.fillRect(lx - 2, y - 6, tw + 4, 12);
  ctx.fillStyle = '#000';
  ctx.fillText(label, lx, y + 3);
  ctx.restore();
}

function drawOneTLine(p1, p2, t1, t2, alpha = 1.0, rx1 = null, rx2 = null) {
  const x1 = timeToX(t1) ?? rx1, x2 = timeToX(t2) ?? rx2;
  const y1 = priceToY(p1), y2 = priceToY(p2);
  if (x1 === null || x2 === null || y1 === null || y2 === null) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawAllHandles() {
  if (!editMode) return;
  function shouldDraw(type, idx) {
    if (!editTarget) return true;
    return editTarget.type === type && editTarget.idx === idx;
  }
  function drawPairHandles(collection, type, color) {
    collection.forEach((f, i) => {
      if (!shouldDraw(type, i)) return;
      [['p1','t1'], ['p2','t2']].forEach(([pk, tk]) => {
        const x = timeToX(f[tk]), y = priceToY(f[pk]);
        if (x === null || y === null) return;
        ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI*2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      });
    });
  }
  drawPairHandles(fiboSaved, 'fibo', '#f57f17');
  drawPairHandles(tlineSaved, 'tline', '#ffffff');
  // トレンドライン中央移動ハンドル
  tlineSaved.forEach((f, i) => {
    if (!shouldDraw('tline', i)) return;
    const x1 = timeToX(f.t1), x2 = timeToX(f.t2);
    const y1 = priceToY(f.p1), y2 = priceToY(f.p2);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;
    const mx = (x1+x2)/2, my = (y1+y2)/2;
    ctx.beginPath(); ctx.arc(mx, my, HANDLE_R, 0, Math.PI*2);
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.5; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
  });
  // 水平線ハンドル（中央）
  hlineSaved.forEach((h, i) => {
    if (!shouldDraw('hline', i)) return;
    const y = priceToY(h.price);
    if (y === null) return;
    const cx = chartDiv.clientWidth / 2;
    ctx.beginPath(); ctx.arc(cx, y, HANDLE_R, 0, Math.PI*2);
    ctx.fillStyle = '#ffeb3b'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

var _drawingsDirty = false;
var _saveTimer = null;
function markDrawingsDirty() {
  if (_drawingsDirty) return;
  _drawingsDirty = true;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _drawingsDirty = false; saveDrawings(); }, 1000);
}

function redrawFibo() {
  ctx.clearRect(0, 0, fiboCanvas.width, fiboCanvas.height);
  detectFVGs();
  drawFVGs();
  detectBOS();
  drawBOS();
  detectOB();
  drawOB();
  detectRanges();
  drawRanges();
  drawBidAskLines();
  drawTradeMarkers();
  drawPositionLines();
  hlineSaved.forEach(h => drawOneHLine(h.price));
  tlineSaved.forEach(f => drawOneTLine(f.p1, f.p2, f.t1, f.t2));
  fiboSaved.forEach(f => drawOneFibo(f.p1, f.p2, f.t1, f.t2, 1.0, null, f.rx2));
  if (fiboDrag) drawOneFibo(fiboDrag.p1, fiboDrag.p2, fiboDrag.t1, fiboDrag.t2, 0.6, fiboDrag.rx1, fiboDrag.rx2);
  if (tlineDrag) drawOneTLine(tlineDrag.p1, tlineDrag.p2, tlineDrag.t1, tlineDrag.t2, 0.6, tlineDrag.rx1, tlineDrag.rx2);
  drawAllHandles();
}

// 50ms間隔で再描画（スクロール・ズーム・スケール変更に追随）
setInterval(redrawFibo, 100);
// イベントでも即時反映
chart.subscribeAction(klinecharts.ActionType.OnVisibleRangeChange, redrawFibo);

// ===== ドラッグ操作 =====
var fiboActive     = false;
var dragging       = false;
var dragStartPrice = null;
var editHandle     = null; // { fiboIdx, point:'p1'|'p2' } ハンドル編集中

// ハンドルのヒットテスト（editTarget限定）
function hitHandle(mx, my) {
  if (editTarget) {
    const col = editTarget.type === 'hline' ? hlineSaved : editTarget.type === 'tline' ? tlineSaved : fiboSaved;
    const f = col[editTarget.idx];
    if (!f) return null;
    if (editTarget.type === 'hline') {
      const y = priceToY(f.price), cx = chartDiv.clientWidth / 2;
      if (y !== null && Math.sqrt((mx-cx)**2 + (my-y)**2) < HANDLE_R + 6)
        return { collection: col, idx: editTarget.idx, point: 'price', timeKey: null, type: 'hline' };
    } else {
      // 中央ハンドル（全体移動）
      if (editTarget.type === 'tline') {
        const x1 = timeToX(f.t1), x2 = timeToX(f.t2), y1 = priceToY(f.p1), y2 = priceToY(f.p2);
        if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) {
          const cmx = (x1+x2)/2, cmy = (y1+y2)/2;
          if (Math.sqrt((mx-cmx)**2 + (my-cmy)**2) < HANDLE_R + 6)
            return { collection: col, idx: editTarget.idx, point: 'move', timeKey: null, type: 'tline_move' };
        }
      }
      for (const [pk, tk] of [['p1','t1'], ['p2','t2']]) {
        const x = timeToX(f[tk]), y = priceToY(f[pk]);
        if (x === null || y === null) continue;
        if (Math.sqrt((mx-x)**2 + (my-y)**2) < HANDLE_R + 6)
          return { collection: col, idx: editTarget.idx, point: pk, timeKey: tk, type: editTarget.type };
      }
    }
    return null;
  }
  // フィボ
  for (let i = fiboSaved.length - 1; i >= 0; i--) {
    const f = fiboSaved[i];
    for (const [pk, tk] of [['p1','t1'], ['p2','t2']]) {
      const x = timeToX(f[tk]), y = priceToY(f[pk]);
      if (x === null || y === null) continue;
      if (Math.sqrt((mx-x)**2 + (my-y)**2) < HANDLE_R + 6)
        return { collection: fiboSaved, idx: i, point: pk, timeKey: tk, type: 'fibo' };
    }
  }
  // トレンドライン
  for (let i = tlineSaved.length - 1; i >= 0; i--) {
    const f = tlineSaved[i];
    for (const [pk, tk] of [['p1','t1'], ['p2','t2']]) {
      const x = timeToX(f[tk]), y = priceToY(f[pk]);
      if (x === null || y === null) continue;
      if (Math.sqrt((mx-x)**2 + (my-y)**2) < HANDLE_R + 6)
        return { collection: tlineSaved, idx: i, point: pk, timeKey: tk, type: 'tline' };
    }
  }
  // 水平線（中央ハンドル）
  for (let i = hlineSaved.length - 1; i >= 0; i--) {
    const y = priceToY(hlineSaved[i].price);
    const cx = chartDiv.clientWidth / 2;
    if (y !== null && Math.sqrt((mx-cx)**2 + (my-y)**2) < HANDLE_R + 6)
      return { collection: hlineSaved, idx: i, point: 'price', timeKey: null, type: 'hline' };
  }
  return null;
}

var toolBtns = document.querySelectorAll('.tool-btn');

function enableFiboMode(tool) {
  curTool = tool || curTool;
  fiboActive = true;
  fiboCanvas.style.pointerEvents = 'auto';
  fiboCanvas.style.cursor = 'crosshair';
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === curTool));
  chart.setScrollEnabled(false);
  chart.setZoomEnabled(false);
  redrawFibo();
}
function disableFiboMode() {
  fiboActive = false; dragging = false; fiboDrag = null; tlineDrag = null; editHandle = null;
  curTool = ''; editMode = false; editTarget = null;
  fiboCanvas.style.pointerEvents = 'none';
  fiboCanvas.style.cursor = 'default';
  toolBtns.forEach(b => b.classList.remove('active'));
  chart.setScrollEnabled(true);
  chart.setZoomEnabled(true);
  redrawFibo();
}

toolBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.tool;
    if (fiboActive && curTool === v) { disableFiboMode(); }
    else { editMode = false; enableFiboMode(v); }
  });
});

function pixelToPrice(y) {
  try {
    const r = chart.convertFromPixel({ x: 100, y }, { paneId: 'candle_pane', absolute: true });
    return (r && r.value !== undefined) ? r.value : null;
  } catch(e) { return null; }
}

var dragStartTime = null;
var dragStartX    = null;

fiboCanvas.addEventListener('mousedown', e => {
  if (!fiboActive) return;
  const hit = hitHandle(e.offsetX, e.offsetY);
  if (hit) {
    editHandle = hit;
    if (hit.type === 'tline_move') {
      const f = hit.collection[hit.idx];
      editHandle._origP1 = f.p1; editHandle._origP2 = f.p2;
      editHandle._origT1 = f.t1; editHandle._origT2 = f.t2;
      // 端点のピクセル位置を保存
      editHandle._px1 = timeToX(f.t1); editHandle._py1 = priceToY(f.p1);
      editHandle._px2 = timeToX(f.t2); editHandle._py2 = priceToY(f.p2);
      editHandle._dragStartX = e.offsetX; editHandle._dragStartY = e.offsetY;
    }
    fiboCanvas.style.cursor = 'grab';
  } else if (editMode) {
    // 編集モードでハンドル外クリック → 終了
    disableFiboMode();
  } else if (curTool === 'hline') {
    const p = pixelToPrice(e.offsetY);
    if (p !== null) {
      hlineSaved.push({ price: p }); markDrawingsDirty();
      editMode = true; editTarget = { type: 'hline', idx: hlineSaved.length - 1 };
      curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      redrawFibo();
    }
  } else if (curTool === 'fibo' || curTool === 'tline') {
    const p = pixelToPrice(e.offsetY);
    const t = xToTime(e.offsetX);
    if (p !== null && t !== null) { dragStartPrice = p; dragStartTime = t; dragStartX = e.offsetX; dragging = true; }
  }
});

// ドラッグ中はキャンバス外でも追従（document レベル）
function canvasRelPos(e) {
  const rect = fiboCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

document.addEventListener('mousemove', e => {
  if (!fiboActive) return;
  const { x, y } = canvasRelPos(e);

  if (editHandle) {
    const p = pixelToPrice(y), t = xToTime(x);
    if (p !== null) {
      if (editHandle.type === 'tline_move') {
        // ピクセル差分を計算し、元の端点ピクセルにオフセットして変換
        const dx = x - editHandle._dragStartX;
        const dy = y - editHandle._dragStartY;
        const newP1 = pixelToPrice(editHandle._py1 + dy);
        const newP2 = pixelToPrice(editHandle._py2 + dy);
        const newT1 = xToTime(editHandle._px1 + dx);
        const newT2 = xToTime(editHandle._px2 + dx);
        if (newP1 !== null && newP2 !== null) {
          const f = editHandle.collection[editHandle.idx];
          f.p1 = newP1; f.p2 = newP2;
          if (newT1 !== null) f.t1 = newT1;
          if (newT2 !== null) f.t2 = newT2;
        }
      } else if (editHandle.type === 'hline') {
        editHandle.collection[editHandle.idx].price = p;
      } else {
        editHandle.collection[editHandle.idx][editHandle.point] = p;
        if (t !== null && editHandle.timeKey) editHandle.collection[editHandle.idx][editHandle.timeKey] = t;
      }
      redrawFibo();
    }
  } else if (dragging && dragStartPrice !== null) {
    const p = pixelToPrice(y) ?? dragStartPrice;
    const t = xToTime(x)     ?? dragStartTime;
    if (curTool === 'tline') {
      tlineDrag = { p1: dragStartPrice, p2: p, t1: dragStartTime, t2: t, rx1: dragStartX, rx2: x };
    } else {
      fiboDrag = { p1: dragStartPrice, p2: p, t1: dragStartTime, t2: t, rx1: dragStartX, rx2: x };
    }
    redrawFibo();
  } else if (e.target === fiboCanvas) {
    const hit = hitHandle(x, y);
    fiboCanvas.style.cursor = hit ? 'grab' : 'crosshair';
  }
});

document.addEventListener('mouseup', e => {
  if (!fiboActive) return;
  const { x, y } = canvasRelPos(e);

  if (editHandle) {
    editHandle = null;
    fiboCanvas.style.cursor = 'crosshair';
    markDrawingsDirty(); redrawFibo();
  } else if (dragging) {
    if (curTool === 'tline') {
      if (tlineDrag && Math.abs(tlineDrag.p2 - tlineDrag.p1) > 0.001) {
        tlineSaved.push({ p1: tlineDrag.p1, p2: tlineDrag.p2, t1: tlineDrag.t1, t2: tlineDrag.t2 }); markDrawingsDirty();
        editMode = true; editTarget = { type: 'tline', idx: tlineSaved.length - 1 };
        curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      } else { disableFiboMode(); }
      tlineDrag = null;
    } else if (curTool === 'fibo') {
      if (fiboDrag && Math.abs(fiboDrag.p2 - fiboDrag.p1) > 0.001) {
        fiboSaved.push({ p1: fiboDrag.p1, p2: fiboDrag.p2, t1: fiboDrag.t1, t2: fiboDrag.t2, rx1: fiboDrag.rx1, rx2: fiboDrag.rx2 }); markDrawingsDirty();
        editMode = true; editTarget = { type: 'fibo', idx: fiboSaved.length - 1 };
        curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      } else { disableFiboMode(); }
      fiboDrag = null;
    } else { disableFiboMode(); }
    dragging = false; dragStartPrice = null; dragStartTime = null; dragStartX = null;
    redrawFibo();
  }
});

document.getElementById('btn-tool-clear').addEventListener('click', () => {
  fiboSaved = []; hlineSaved = []; tlineSaved = [];
  disableFiboMode();
});

// ===== 描画オブジェクトのヒットテスト（ライン近傍10px） =====
// 返り値: { type, idx } or null
function hitDrawObject(mx, my) {
  // 水平線
  for (let i = hlineSaved.length - 1; i >= 0; i--) {
    const y = priceToY(hlineSaved[i].price);
    if (y !== null && Math.abs(my - y) < 10) return { type: 'hline', idx: i };
  }
  // トレンドライン
  for (let i = tlineSaved.length - 1; i >= 0; i--) {
    const f = tlineSaved[i];
    const x1 = timeToX(f.t1), x2 = timeToX(f.t2);
    const y1 = priceToY(f.p1), y2 = priceToY(f.p2);
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    // 点と線分の距離
    const dx = x2-x1, dy = y2-y1, len2 = dx*dx+dy*dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((mx-x1)*dx+(my-y1)*dy)/len2)) : 0;
    const px = x1+t*dx, py = y1+t*dy;
    if (Math.sqrt((mx-px)**2+(my-py)**2) < 10) return { type: 'tline', idx: i };
  }
  // フィボ
  for (let i = fiboSaved.length - 1; i >= 0; i--) {
    const f = fiboSaved[i];
    const xa = timeToX(f.t1), xb = timeToX(f.t2);
    if (xa === null || xb === null) continue;
    const xL = Math.min(xa, xb), xR = Math.max(xa, xb);
    if (mx < xL - 10 || mx > xR + 60) continue;
    const range = Math.abs(f.p1 - f.p2);
    const isDown = f.p1 >= f.p2;
    for (const lvl of FIBO_LEVELS) {
      const price = isDown ? (f.p2 + range * lvl) : (f.p2 - range * lvl);
      const y = priceToY(price);
      if (y !== null && Math.abs(my - y) < 10) return { type: 'fibo', idx: i };
    }
  }
  return null;
}
// 後方互換
function hitFiboObject(mx, my) {
  const hit = hitDrawObject(mx, my);
  return hit ? hit.idx : -1;
}

// ===== 削除メニュー =====
const deleteMenu = document.createElement('div');
Object.assign(deleteMenu.style, {
  position: 'fixed', display: 'none', zIndex: '100',
  background: '#2b2b2b', border: '1px solid #4a4a4a', borderRadius: '2px',
  padding: '2px 0', boxShadow: '0 2px 8px rgba(0,0,0,0.7)',
  fontSize: '13px', color: '#ddd', minWidth: '140px'
});
const menuItemStyle = 'width:100%;background:none;padding:5px 20px;border:none;color:#ddd;font-size:13px;cursor:pointer;text-align:left;font-family:monospace;display:block';
const menuItemHover = 'this.style.background="#3d6a99"';
const menuItemOut   = 'this.style.background="none"';
deleteMenu.innerHTML = `
  <button id="dmenu-edit" style="${menuItemStyle}" onmouseover='${menuItemHover}' onmouseout='${menuItemOut}'>編集</button>
  <button id="dmenu-dup" style="${menuItemStyle}" onmouseover='${menuItemHover}' onmouseout='${menuItemOut}'>複製</button>
  <div style="height:1px;background:#4a4a4a;margin:2px 0"></div>
  <button id="dmenu-del" style="${menuItemStyle};color:#ff6b6b" onmouseover='${menuItemHover}' onmouseout='${menuItemOut}'>削除</button>
`;
document.body.appendChild(deleteMenu);

var deleteTargetIdx = -1;
var deleteTargetType = '';
function showDeleteMenu(x, y, idx, type) {
  deleteTargetIdx = idx;
  deleteTargetType = type || '';
  deleteMenu.style.display = 'block';
  const mh = deleteMenu.offsetHeight;
  const mw = deleteMenu.offsetWidth;
  deleteMenu.style.left = Math.min(x, window.innerWidth  - mw - 4) + 'px';
  deleteMenu.style.top  = Math.max(4, y - mh - 4) + 'px';
  deleteMenu.style.display = 'block';
}
function hideDeleteMenu() { deleteMenu.style.display = 'none'; deleteTargetIdx = -1; deleteTargetType = ''; }

document.getElementById('dmenu-edit').addEventListener('click', () => {
  if (deleteTargetIdx >= 0) {
    editMode = true;
    editTarget = { type: deleteTargetType, idx: deleteTargetIdx };
    enableFiboMode(deleteTargetType || 'fibo');
  }
  hideDeleteMenu();
});
document.getElementById('dmenu-dup').addEventListener('click', () => {
  if (deleteTargetIdx >= 0) {
    const col = deleteTargetType === 'hline' ? hlineSaved : deleteTargetType === 'tline' ? tlineSaved : fiboSaved;
    const orig = col[deleteTargetIdx];
    if (orig) {
      // 少しずらして複製（トレンドラインは同じ傾きで価格を少しずらす）
      const offset = deleteTargetType === 'hline' ? 5 : 3;
      const dup = JSON.parse(JSON.stringify(orig));
      if (deleteTargetType === 'hline') {
        dup.price += offset;
      } else {
        dup.p1 += offset; dup.p2 += offset;
      }
      col.push(dup);
      editMode = true; editTarget = { type: deleteTargetType, idx: col.length - 1 };
      enableFiboMode(deleteTargetType);
      markDrawingsDirty(); redrawFibo();
    }
  }
  hideDeleteMenu();
});
document.getElementById('dmenu-del').addEventListener('click', () => {
  if (deleteTargetIdx >= 0) {
    const col = deleteTargetType === 'hline' ? hlineSaved : deleteTargetType === 'tline' ? tlineSaved : fiboSaved;
    col.splice(deleteTargetIdx, 1);
    markDrawingsDirty(); redrawFibo();
  }
  hideDeleteMenu();
});
document.addEventListener('touchstart', e => {
  if (!deleteMenu.contains(e.target)) hideDeleteMenu();
}, { passive: true });
document.addEventListener('mousedown', e => {
  if (!deleteMenu.contains(e.target)) hideDeleteMenu();
});

// ===== タッチ操作（スマホ対応）=====
var longPressTimer = null;
var touchMoved     = false;
var touchDragging  = false;

function getTouchPos(e) {
  const t = e.touches[0];
  const rect = fiboCanvas.getBoundingClientRect();
  return { x: t.clientX - rect.left, y: t.clientY - rect.top };
}

// fiboCanvas にもタッチ受付（FIBOモード時）
fiboCanvas.addEventListener('touchstart', e => {
  if (!fiboActive) return;
  e.preventDefault();
  touchMoved = false;
  const { x, y } = getTouchPos(e);

  // 長押し検出（FIBOモード外でも動作させたいので後で別途追加）
  longPressTimer = setTimeout(() => {
    if (!touchMoved) {
      const hit = hitDrawObject(x, y);
      if (hit) {
        const t = e.touches[0];
        showDeleteMenu(t.clientX, t.clientY - 60, hit.idx, hit.type);
        dragging = false; dragStartPrice = null; dragStartTime = null; fiboDrag = null; tlineDrag = null;
      }
    }
  }, 500);

  const hit = hitHandle(x, y);
  if (hit) {
    editHandle = hit;
    if (hit.type === 'tline_move') {
      const f = hit.collection[hit.idx];
      editHandle._startP1 = f.p1; editHandle._startP2 = f.p2;
      editHandle._startT1 = f.t1; editHandle._startT2 = f.t2;
      editHandle._px1 = timeToX(f.t1); editHandle._py1 = priceToY(f.p1);
      editHandle._px2 = timeToX(f.t2); editHandle._py2 = priceToY(f.p2);
      editHandle._dragStartX = x; editHandle._dragStartY = y;
    }
  } else if (editMode) {
    disableFiboMode();
  } else if (curTool === 'hline') {
    const p = pixelToPrice(y);
    if (p !== null) {
      hlineSaved.push({ price: p }); markDrawingsDirty();
      editMode = true; editTarget = { type: 'hline', idx: hlineSaved.length - 1 };
      curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      redrawFibo();
    }
  } else if (curTool === 'fibo' || curTool === 'tline') {
    const p = pixelToPrice(y), t = xToTime(x);
    if (p !== null && t !== null) { dragStartPrice = p; dragStartTime = t; touchDragging = true; }
  }
}, { passive: false });

fiboCanvas.addEventListener('touchmove', e => {
  if (!fiboActive) return;
  e.preventDefault();
  touchMoved = true;
  clearTimeout(longPressTimer);
  const { x, y } = getTouchPos(e);

  if (editHandle) {
    const p = pixelToPrice(y), t = xToTime(x);
    if (p !== null) {
      if (editHandle.type === 'tline_move') {
        // ピクセル差分を計算し、元の端点ピクセルにオフセットして変換
        const dx = x - editHandle._dragStartX;
        const dy = y - editHandle._dragStartY;
        const newP1 = pixelToPrice(editHandle._py1 + dy);
        const newP2 = pixelToPrice(editHandle._py2 + dy);
        const newT1 = xToTime(editHandle._px1 + dx);
        const newT2 = xToTime(editHandle._px2 + dx);
        if (newP1 !== null && newP2 !== null) {
          const f = editHandle.collection[editHandle.idx];
          f.p1 = newP1; f.p2 = newP2;
          if (newT1 !== null) f.t1 = newT1;
          if (newT2 !== null) f.t2 = newT2;
        }
      } else if (editHandle.type === 'hline') {
        editHandle.collection[editHandle.idx].price = p;
      } else {
        editHandle.collection[editHandle.idx][editHandle.point] = p;
        if (t !== null && editHandle.timeKey) editHandle.collection[editHandle.idx][editHandle.timeKey] = t;
      }
      redrawFibo();
    }
  } else if (touchDragging && dragStartPrice !== null) {
    const p = pixelToPrice(y), t = xToTime(x);
    if (p !== null && t !== null) {
      if (curTool === 'tline') {
        tlineDrag = { p1: dragStartPrice, p2: p, t1: dragStartTime, t2: t };
      } else {
        fiboDrag = { p1: dragStartPrice, p2: p, t1: dragStartTime, t2: t };
      }
      redrawFibo();
    }
  }
}, { passive: false });

fiboCanvas.addEventListener('touchend', e => {
  if (!fiboActive) return;
  clearTimeout(longPressTimer);
  if (editHandle) { editHandle = null; markDrawingsDirty(); redrawFibo(); }
  else if (touchDragging) {
    if (curTool === 'tline') {
      if (tlineDrag && Math.abs(tlineDrag.p2 - dragStartPrice) > 0.001) {
        tlineSaved.push({ ...tlineDrag }); markDrawingsDirty();
        editMode = true; editTarget = { type: 'tline', idx: tlineSaved.length - 1 };
        curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      } else { disableFiboMode(); }
      tlineDrag = null;
    } else {
      if (fiboDrag && Math.abs(fiboDrag.p2 - dragStartPrice) > 0.001) {
        fiboSaved.push({ ...fiboDrag }); markDrawingsDirty();
        editMode = true; editTarget = { type: 'fibo', idx: fiboSaved.length - 1 };
        curTool = ''; toolBtns.forEach(b => b.classList.remove('active'));
      } else { disableFiboMode(); }
      fiboDrag = null;
    }
    touchDragging = false; dragStartPrice = null; dragStartTime = null;
    redrawFibo();
  }
}, { passive: true });

// FIBOモード外でも長押しで削除メニュー（チャート全体）
chartDiv.addEventListener('touchstart', e => {
  if (fiboActive) return; // FIBOモード時は上の処理に任せる
  touchMoved = false;
  const t0 = e.touches[0];
  const rect = chartDiv.getBoundingClientRect();
  const x = t0.clientX - rect.left, y = t0.clientY - rect.top;
  longPressTimer = setTimeout(() => {
    if (!touchMoved) {
      const hit = hitDrawObject(x, y);
      if (hit) showDeleteMenu(t0.clientX, t0.clientY - 60, hit.idx, hit.type);
    }
  }, 500);
}, { passive: true });
chartDiv.addEventListener('touchmove', () => { touchMoved = true; clearTimeout(longPressTimer); }, { passive: true });
chartDiv.addEventListener('touchend',  () => clearTimeout(longPressTimer), { passive: true });

// ===== 右クリックで削除メニュー（PC） =====
fiboCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const hit = hitDrawObject(e.offsetX, e.offsetY);
  if (hit) showDeleteMenu(e.clientX, e.clientY, hit.idx, hit.type);
});
// ツールモード外でもチャート上で右クリック
chartDiv.addEventListener('contextmenu', e => {
  if (fiboActive) return;
  const rect = chartDiv.getBoundingClientRect();
  const hit = hitDrawObject(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) { e.preventDefault(); showDeleteMenu(e.clientX, e.clientY, hit.idx, hit.type); }
});

// ===== FIBOモード外クリック/タッチで終了 =====
function handleFiboExit(e) {
  if (!fiboActive) return;
  const t = e.target;
  if ([...toolBtns].includes(t) || t === document.getElementById('btn-tool-clear')
      || fiboCanvas.contains(t) || deleteMenu.contains(t)) return;
  disableFiboMode();
}
document.addEventListener('click', handleFiboExit, true);
document.addEventListener('touchstart', handleFiboExit, true);

// ===== タッチ→マウス変換（チャート全体） =====
// klinecharts v9のmouseハンドラはPC同様に上下左右自由に動くが、
// タッチハンドラは横スクロールのみ。全タッチをマウスイベントに変換する。
(() => {
  let proxyActive = false;
  let lastTarget = null;

  function dispatchMouse(type, clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY) || lastTarget;
    if (!el) return;
    lastTarget = el;
    el.dispatchEvent(new MouseEvent(type, {
      clientX, clientY, button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      bubbles: true, cancelable: true
    }));
  }

  let lpTimer = null;
  let lpMoved = false;
  let startCX = 0, startCY = 0;

  chartDiv.addEventListener('touchstart', e => {
    if (fiboActive || e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    proxyActive = true;
    lpMoved = false;
    const t = e.touches[0];
    startCX = t.clientX; startCY = t.clientY;
    const rect = chartDiv.getBoundingClientRect();
    const lx = t.clientX - rect.left, ly = t.clientY - rect.top;
    // 長押し検出（500ms）→ 描画オブジェクトがあれば編集モードに入る
    lpTimer = setTimeout(() => {
      if (!lpMoved) {
        const hit = hitDrawObject(lx, ly);
        if (hit) {
          proxyActive = false;
          dispatchMouse('mouseup', t.clientX, t.clientY);
          editMode = true;
          editTarget = { type: hit.type, idx: hit.idx };
          enableFiboMode(hit.type);
          return;
        }
      }
    }, 500);
    dispatchMouse('mousedown', t.clientX, t.clientY);
  }, { passive: false, capture: true });

  document.addEventListener('touchmove', e => {
    if (!proxyActive) return;
    const t = e.touches[0];
    // 少し動いただけでは長押しキャンセルしない（10px閾値）
    const dx = t.clientX - startCX, dy = t.clientY - startCY;
    if (dx*dx + dy*dy > 100) { lpMoved = true; clearTimeout(lpTimer); }
    e.preventDefault();
    dispatchMouse('mousemove', t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchend', e => {
    clearTimeout(lpTimer);
    if (!proxyActive) return;
    proxyActive = false;
    const t = e.changedTouches[0];
    dispatchMouse('mouseup', t.clientX, t.clientY);
    lastTarget = null;
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    clearTimeout(lpTimer);
    proxyActive = false;
    lastTarget = null;
  }, { passive: true });
})();
