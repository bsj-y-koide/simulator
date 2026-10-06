// ===== キャンバス（SMC・TP/SL用）=====
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

// 価格 → Y座標
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
function xToTime(x) {
  try {
    const lastTs = bars1m[curIdx1m]?.t * 1000;
    const lastPx = lastTs ? chart.convertToPixel({ timestamp: lastTs }, { paneId: 'candle_pane', absolute: true })?.x : null;
    if (lastPx !== null && lastPx !== undefined && x > lastPx + 2) {
      const ref = getMsPerPx();
      if (ref) return ref.refTs + (x - ref.refX) * ref.msPerPx;
      return lastTs + (x - lastPx) * (curTF * 60 * 1000);
    }
    const r = chart.convertFromPixel({ x, y: 100 }, { paneId: 'candle_pane', absolute: true });
    return (r?.timestamp) ? r.timestamp : null;
  } catch(e) { return null; }
}

// タイムスタンプ → ピクセルX
function timeToX(ts) {
  try {
    const lastTs = bars1m[curIdx1m]?.t * 1000;
    if (lastTs && ts > lastTs + curTF * 60 * 1000) {
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

function pixelToPrice(y) {
  try {
    const r = chart.convertFromPixel({ x: 100, y }, { paneId: 'candle_pane', absolute: true });
    return (r && r.value !== undefined) ? r.value : null;
  } catch(e) { return null; }
}

// ===== 再描画（SMC・TP/SL）=====
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
  if (typeof checkTPSLAndLimits === 'function') checkTPSLAndLimits(livePrice || bars1m[curIdx1m]?.c || 0);
  drawBidAskLines();
  drawTradeMarkers();
  drawPositionLines();
}

setInterval(redrawFibo, 100);
chart.subscribeAction(klinecharts.ActionType.OnVisibleRangeChange, redrawFibo);

// ===== ツールボタン =====
var toolBtns = document.querySelectorAll('.tool-btn');

var OVERLAY_NAMES = { fibo: 'customFibo', hline: 'customHLine', tline: 'customSegment' };

toolBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.tool;
    toolBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chart.createOverlay({ name: OVERLAY_NAMES[v] || v });
  });
});

document.getElementById('btn-tool-clear').addEventListener('click', () => {
  try { chart.removeOverlay(); } catch(e) {}
  toolBtns.forEach(b => b.classList.remove('active'));
});

// overlay描画完了でボタン解除
chart.subscribeAction(klinecharts.ActionType.OnOverlayChange, () => {
  toolBtns.forEach(b => b.classList.remove('active'));
});

// settings.js との互換（keyboard shortcut）
function enableFiboMode(tool) {
  const name = OVERLAY_NAMES[tool] || tool;
  chart.createOverlay({ name });
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}
function disableFiboMode() {
  toolBtns.forEach(b => b.classList.remove('active'));
}
// settings.js が参照するダミー変数
var fiboActive = false;

// ===== TP/SL ドラッグ =====
var tpslDrag = null;
var tpslCooldown = 0;

document.addEventListener('mousedown', e => {
  if (tpslDrag) return;
  const rect = chartDiv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
  const hit = hitTPSLHandle(mx, my);
  if (hit && hit.kind !== 'select') {
    if (hit.kind === 'limit' && selectedLimitId !== hit.obj.id) return;
    e.preventDefault(); e.stopPropagation();
    tpslDrag = hit;
    chart.setScrollEnabled(false);
    chart.setZoomEnabled(false);
  }
}, true);

// チャート上クリックでポジション/指値ライン選択
chartDiv.addEventListener('click', e => {
  if (tpslDrag) return;
  const rect = chartDiv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;

  const hit = hitTPSLHandle(mx, my);
  if (hit) {
    if (hit.kind === 'select') {
      selectedPosId = selectedPosId === hit.posId ? null : hit.posId;
      selectedLimitId = null;
    } else if (hit.kind === 'limit') {
      selectedLimitId = selectedLimitId === hit.obj.id ? null : hit.obj.id;
      selectedPosId = null;
    }
    redrawFibo();
    return;
  }

  for (const p of positions) {
    const y = priceToY(p.price);
    if (y !== null && Math.abs(my - y) < 15) {
      selectedPosId = selectedPosId === p.id ? null : p.id;
      redrawFibo();
      return;
    }
  }
  for (const o of pendingOrders) {
    const y = priceToY(o.price);
    if (y !== null && Math.abs(my - y) < 15) {
      selectedLimitId = selectedLimitId === o.id ? null : o.id;
      selectedPosId = null;
      redrawFibo();
      return;
    }
  }

  if (selectedPosId !== null || selectedLimitId !== null) {
    selectedPosId = null;
    if (selectedLimitId !== null) {
      const o = pendingOrders.find(o => o.id === selectedLimitId);
      if (o) o.confirmed = true;
      selectedLimitId = null;
    }
    redrawFibo();
  }
});

document.addEventListener('click', e => {
  if (selectedLimitId === null) return;
  if (e.target.closest('#ma-panel') || e.target.closest('.omenu-btn') || deleteMenu.contains(e.target) || orderMenu.contains(e.target)) return;
  const rect = chartDiv.getBoundingClientRect();
  const my = e.clientY - rect.top;
  for (const o of pendingOrders) {
    if (o.id === selectedLimitId) {
      const y = priceToY(o.price);
      if (y !== null && Math.abs(my - y) < 15) return;
    }
  }
  const o = pendingOrders.find(o => o.id === selectedLimitId);
  if (o) o.confirmed = true;
  selectedLimitId = null;
  redrawFibo();
});

// TP/SL & 指値ハンドルのヒットテスト
function hitTPSLHandle(mx, my) {
  for (const p of positions) {
    if (p.tp !== null) { const y = priceToY(p.tp); if (y !== null && Math.abs(my-y) < 15) return { posId: p.id, kind: 'tp', obj: p }; }
    if (p.sl !== null) { const y = priceToY(p.sl); if (y !== null && Math.abs(my-y) < 15) return { posId: p.id, kind: 'sl', obj: p }; }
    if (selectedPosId === p.id) {
      const isBuy = p.type === 'BUY';
      if (p.tp === null) { const gy = priceToY(isBuy ? p.price+3 : p.price-3); if (gy !== null && Math.abs(my-gy) < 15) return { posId: p.id, kind: 'tp_new', obj: p }; }
      if (p.sl === null) { const gy = priceToY(isBuy ? p.price-3 : p.price+3); if (gy !== null && Math.abs(my-gy) < 15) return { posId: p.id, kind: 'sl_new', obj: p }; }
    }
  }
  for (const o of pendingOrders) {
    if (o.tp !== null) { const y = priceToY(o.tp); if (y !== null && Math.abs(my-y) < 15) return { posId: o.id, kind: 'tp', obj: o }; }
    if (o.sl !== null) { const y = priceToY(o.sl); if (y !== null && Math.abs(my-y) < 15) return { posId: o.id, kind: 'sl', obj: o }; }
    if (selectedLimitId === o.id) {
      const isBuy = o.type === 'BUY_LIMIT';
      if (o.tp === null) { const gy = priceToY(isBuy ? o.price+3 : o.price-3); if (gy !== null && Math.abs(my-gy) < 15) return { posId: o.id, kind: 'tp_new', obj: o }; }
      if (o.sl === null) { const gy = priceToY(isBuy ? o.price-3 : o.price+3); if (gy !== null && Math.abs(my-gy) < 15) return { posId: o.id, kind: 'sl_new', obj: o }; }
    }
  }
  for (const o of pendingOrders) {
    const y = priceToY(o.price);
    if (y !== null && Math.abs(my-y) < 12) return { posId: o.id, kind: 'limit', obj: o };
  }
  for (const p of positions) {
    const y = priceToY(p.price);
    if (y !== null && Math.abs(my-y) < 12) return { posId: p.id, kind: 'select', obj: p };
  }
  return null;
}

document.addEventListener('mousemove', e => {
  if (!tpslDrag) return;
  const rect = fiboCanvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const p = pixelToPrice(y);
  if (p !== null) {
    if (tpslDrag.kind === 'tp' || tpslDrag.kind === 'tp_new') { tpslDrag.obj.tp = p; }
    else if (tpslDrag.kind === 'sl' || tpslDrag.kind === 'sl_new') { tpslDrag.obj.sl = p; }
    else if (tpslDrag.kind === 'limit') {
      const dp = p - tpslDrag.obj.price;
      tpslDrag.obj.price = p;
      if (tpslDrag.obj.tp !== null) tpslDrag.obj.tp += dp;
      if (tpslDrag.obj.sl !== null) tpslDrag.obj.sl += dp;
      const mid = livePrice || bars1m[curIdx1m]?.c || 0;
      tpslDrag.obj.type = p < mid ? 'BUY_LIMIT' : 'SELL_LIMIT';
    }
    redrawFibo();
  }
});

document.addEventListener('mouseup', e => {
  if (!tpslDrag) return;
  tpslCooldown = Date.now() + 1000;
  if (tpslDrag.kind === 'tp_new' && tpslDrag.obj.tp === null) {
    const ib = tpslDrag.obj.type === 'BUY' || tpslDrag.obj.type === 'BUY_LIMIT';
    tpslDrag.obj.tp = ib ? tpslDrag.obj.price+3 : tpslDrag.obj.price-3;
  }
  if (tpslDrag.kind === 'sl_new' && tpslDrag.obj.sl === null) {
    const ib = tpslDrag.obj.type === 'BUY' || tpslDrag.obj.type === 'BUY_LIMIT';
    tpslDrag.obj.sl = ib ? tpslDrag.obj.price-3 : tpslDrag.obj.price+3;
  }
  if (tpslDrag.kind === 'limit') selectedLimitId = tpslDrag.obj.id;
  tpslDrag = null;
  chart.setScrollEnabled(true);
  chart.setZoomEnabled(true);
  redrawFibo();
});

// ===== 注文メニュー =====
const orderMenu = document.createElement('div');
Object.assign(orderMenu.style, {
  position: 'fixed', display: 'none', zIndex: '100',
  background: '#2b2b2b', border: '1px solid #4a4a4a', borderRadius: '2px',
  padding: '2px 0', boxShadow: '0 2px 8px rgba(0,0,0,0.7)',
  fontSize: '13px', color: '#ddd', minWidth: '140px'
});
document.body.appendChild(orderMenu);

var orderMenuTarget = null;
function showOrderMenu(x, y, hit) {
  orderMenuTarget = hit;
  let items = '';
  if (hit.kind === 'tp' || hit.kind === 'tp_new') {
    items = `<button class="omenu-btn" data-action="del-tp">TP 削除</button>`;
  } else if (hit.kind === 'sl' || hit.kind === 'sl_new') {
    items = `<button class="omenu-btn" data-action="del-sl">SL 削除</button>`;
  } else if (hit.kind === 'limit') {
    items = `<button class="omenu-btn" data-action="del-limit">指値キャンセル</button>`;
    if (hit.obj.tp !== null) items += `<button class="omenu-btn" data-action="del-tp">TP 削除</button>`;
    if (hit.obj.sl !== null) items += `<button class="omenu-btn" data-action="del-sl">SL 削除</button>`;
  } else if (hit.kind === 'position') {
    items = `<button class="omenu-btn" data-action="close-pos">決済</button>`;
    if (hit.obj.tp !== null) items += `<button class="omenu-btn" data-action="del-tp">TP 削除</button>`;
    if (hit.obj.sl !== null) items += `<button class="omenu-btn" data-action="del-sl">SL 削除</button>`;
  }
  orderMenu.innerHTML = items;
  orderMenu.querySelectorAll('.omenu-btn').forEach(btn => {
    Object.assign(btn.style, { width:'100%',background:'none',padding:'5px 20px',border:'none',color:'#ddd',fontSize:'13px',cursor:'pointer',textAlign:'left',fontFamily:'monospace',display:'block' });
    btn.onmouseover = () => btn.style.background = '#3d6a99';
    btn.onmouseout  = () => btn.style.background = 'none';
  });
  orderMenu.style.display = 'block';
  const mh = orderMenu.offsetHeight, mw = orderMenu.offsetWidth;
  orderMenu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  orderMenu.style.top  = Math.max(4, y - mh - 4) + 'px';
}
function hideOrderMenu() { orderMenu.style.display = 'none'; orderMenuTarget = null; }

orderMenu.addEventListener('click', e => {
  const action = e.target.dataset?.action;
  if (!action || !orderMenuTarget) { hideOrderMenu(); return; }
  const obj = orderMenuTarget.obj;
  if (action === 'del-tp') obj.tp = null;
  if (action === 'del-sl') obj.sl = null;
  if (action === 'del-limit') pendingOrders = pendingOrders.filter(o => o.id !== obj.id);
  if (action === 'close-pos') document.getElementById('btn-close').click();
  hideOrderMenu();
  redrawFibo();
});
document.addEventListener('mousedown', e => { if (e.button === 2) return; if (!orderMenu.contains(e.target)) hideOrderMenu(); });
document.addEventListener('touchstart', e => { if (!orderMenu.contains(e.target)) hideOrderMenu(); }, { passive: true });

// ===== 描画オブジェクトメニュー（overlay右クリック / 右クリック）=====
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
  <button id="dmenu-dup" style="${menuItemStyle}" onmouseover='${menuItemHover}' onmouseout='${menuItemOut}'>複製</button>
  <div style="height:1px;background:#4a4a4a;margin:2px 0"></div>
  <button id="dmenu-del" style="${menuItemStyle};color:#ff6b6b" onmouseover='${menuItemHover}' onmouseout='${menuItemOut}'>削除</button>
`;
document.body.appendChild(deleteMenu);

var deleteTargetOverlay = null;
function showOverlayMenu(x, y, overlay) {
  deleteTargetOverlay = overlay;
  deleteMenu.style.display = 'block';
  const mh = deleteMenu.offsetHeight, mw = deleteMenu.offsetWidth;
  deleteMenu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  deleteMenu.style.top  = Math.max(4, y - mh - 4) + 'px';
}
function hideDeleteMenu() { deleteMenu.style.display = 'none'; deleteTargetOverlay = null; }

document.getElementById('dmenu-dup').addEventListener('click', () => {
  if (deleteTargetOverlay) {
    chart.createOverlay({ name: deleteTargetOverlay.name, points: JSON.parse(JSON.stringify(deleteTargetOverlay.points || [])) });
  }
  hideDeleteMenu();
});
document.getElementById('dmenu-del').addEventListener('click', () => {
  if (deleteTargetOverlay) {
    chart.removeOverlay({ id: deleteTargetOverlay.id });
  }
  hideDeleteMenu();
});
document.addEventListener('touchstart', e => { if (!deleteMenu.contains(e.target)) hideDeleteMenu(); }, { passive: true });
document.addEventListener('mousedown', e => { if (e.button === 2) return; if (!deleteMenu.contains(e.target)) hideDeleteMenu(); });

// klinecharts overlay右クリックイベント
chartDiv.addEventListener('overlayRightClick', e => {
  const { overlay, pageX, pageY } = e.detail;
  showOverlayMenu(pageX, pageY, overlay);
});

// 右クリックメニュー（TP/SL / 注文ライン）
chartDiv.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (orderMenu.style.display !== 'none') return;
  const rect = chartDiv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const tpslHit = hitTPSLHandle(mx, my);
  if (tpslHit && tpslHit.kind !== 'select') {
    showOrderMenu(e.clientX, e.clientY, tpslHit);
    return;
  }
  for (const p of positions) {
    const y = priceToY(p.price);
    if (y !== null && Math.abs(my - y) < 12) { showOrderMenu(e.clientX, e.clientY, { kind: 'position', obj: p }); return; }
  }
  for (const o of pendingOrders) {
    const y = priceToY(o.price);
    if (y !== null && Math.abs(my - y) < 12) { showOrderMenu(e.clientX, e.clientY, { kind: 'limit', obj: o }); return; }
  }
}, true);

// ===== タッチ→マウス変換（klinecharts用）=====
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
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const rect = chartDiv.getBoundingClientRect();
    const lx = t.clientX - rect.left, ly = t.clientY - rect.top;

    // TP/SL/指値/ポジションのタッチチェック
    const tpslHit = hitTPSLHandle(lx, ly);
    let orderHit = null;
    if (tpslHit) {
      orderHit = tpslHit;
    } else {
      for (const p of positions) {
        const py = priceToY(p.price);
        if (py !== null && Math.abs(ly - py) < 15) { orderHit = { kind: 'select', posId: p.id, obj: p }; break; }
      }
      if (!orderHit) {
        for (const o of pendingOrders) {
          const oy = priceToY(o.price);
          if (oy !== null && Math.abs(ly - oy) < 15) { orderHit = { kind: 'limit_select', obj: o }; break; }
        }
      }
    }
    if (orderHit) {
      e.preventDefault(); e.stopPropagation();
      var _orderTouchMoved = false;
      const orderLpTimer = setTimeout(() => {
        if (!_orderTouchMoved) {
          if (orderHit.kind === 'select') {
            showOrderMenu(t.clientX, t.clientY - 60, { kind: 'position', obj: orderHit.obj });
          } else if (orderHit.kind === 'limit_select' || orderHit.kind === 'limit') {
            showOrderMenu(t.clientX, t.clientY - 60, { kind: 'limit', obj: orderHit.obj });
          } else if (orderHit.kind === 'tp' || orderHit.kind === 'tp_new' || orderHit.kind === 'sl' || orderHit.kind === 'sl_new') {
            showOrderMenu(t.clientX, t.clientY - 60, orderHit);
          }
        }
      }, 500);
      const onMove = () => { _orderTouchMoved = true; clearTimeout(orderLpTimer); };
      const onEnd = () => {
        clearTimeout(orderLpTimer);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        if (_orderTouchMoved) return;
        if (orderHit.kind === 'select') {
          selectedPosId = selectedPosId === orderHit.posId ? null : orderHit.posId;
          selectedLimitId = null;
        } else if (orderHit.kind === 'limit_select') {
          selectedLimitId = selectedLimitId === orderHit.obj.id ? null : orderHit.obj.id;
          selectedPosId = null;
        }
        redrawFibo();
      };
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('touchend', onEnd, { once: true });
      if (orderHit.kind !== 'select' && orderHit.kind !== 'limit_select') {
        tpslDrag = orderHit;
        chart.setScrollEnabled(false);
        chart.setZoomEnabled(false);
      }
      return;
    }

    if (selectedPosId !== null || selectedLimitId !== null) {
      if (selectedLimitId !== null) {
        const o = pendingOrders.find(o => o.id === selectedLimitId);
        if (o) o.confirmed = true;
      }
      selectedPosId = null;
      selectedLimitId = null;
      redrawFibo();
    }

    e.preventDefault();
    e.stopPropagation();
    proxyActive = true;
    lpMoved = false;
    startCX = t.clientX; startCY = t.clientY;
    lpTimer = setTimeout(() => {
      if (!lpMoved) {
        const tpslH = hitTPSLHandle(lx, ly);
        if (tpslH && tpslH.kind !== 'select') {
          proxyActive = false;
          dispatchMouse('mouseup', t.clientX, t.clientY);
          showOrderMenu(t.clientX, t.clientY - 60, tpslH);
          return;
        }
        for (const p of positions) {
          const py = priceToY(p.price);
          if (py !== null && Math.abs(ly - py) < 12) {
            proxyActive = false;
            dispatchMouse('mouseup', t.clientX, t.clientY);
            showOrderMenu(t.clientX, t.clientY - 60, { kind: 'position', obj: p });
            return;
          }
        }
        for (const o of pendingOrders) {
          const oy = priceToY(o.price);
          if (oy !== null && Math.abs(ly - oy) < 12) {
            proxyActive = false;
            dispatchMouse('mouseup', t.clientX, t.clientY);
            showOrderMenu(t.clientX, t.clientY - 60, { kind: 'limit', obj: o });
            return;
          }
        }
        // klinecharts overlay の長押し → 右クリック相当を発火してメニュー表示
        {
          proxyActive = false;
          dispatchMouse('mouseup', t.clientX, t.clientY);
          const el = document.elementFromPoint(t.clientX, t.clientY);
          if (el) {
            el.dispatchEvent(new MouseEvent('mousedown', {
              clientX: t.clientX, clientY: t.clientY,
              pageX: t.pageX, pageY: t.pageY,
              button: 2, buttons: 2,
              bubbles: true, cancelable: true
            }));
          }
        }
      }
    }, 500);
    dispatchMouse('mousedown', t.clientX, t.clientY);
  }, { passive: false, capture: true });

  document.addEventListener('touchmove', e => {
    if (tpslDrag) {
      e.preventDefault();
      const t = e.touches[0];
      const rect = chartDiv.getBoundingClientRect();
      const y = t.clientY - rect.top;
      const p = pixelToPrice(y);
      if (p !== null) {
        if (tpslDrag.kind === 'tp' || tpslDrag.kind === 'tp_new') { tpslDrag.obj.tp = p; }
        else if (tpslDrag.kind === 'sl' || tpslDrag.kind === 'sl_new') { tpslDrag.obj.sl = p; }
        else if (tpslDrag.kind === 'limit') {
          tpslDrag.obj.price = p;
          const mid = livePrice || bars1m[curIdx1m]?.c || 0;
          tpslDrag.obj.type = p < mid ? 'BUY_LIMIT' : 'SELL_LIMIT';
        }
        redrawFibo();
      }
      return;
    }
    if (!proxyActive) return;
    const t = e.touches[0];
    const dx = t.clientX - startCX, dy = t.clientY - startCY;
    if (dx*dx + dy*dy > 100) { lpMoved = true; clearTimeout(lpTimer); }
    e.preventDefault();
    dispatchMouse('mousemove', t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchend', e => {
    clearTimeout(lpTimer);
    if (tpslDrag) {
      tpslCooldown = Date.now() + 1000;
      if (tpslDrag.kind === 'limit') selectedLimitId = tpslDrag.obj.id;
      tpslDrag = null;
      chart.setScrollEnabled(true);
      chart.setZoomEnabled(true);
      redrawFibo();
      return;
    }
    if (!proxyActive) return;
    proxyActive = false;
    const t = e.changedTouches[0];
    dispatchMouse('mouseup', t.clientX, t.clientY);
    // タップ（ドラッグなし）のとき click も発火 → klinecharts overlay 点置きに必要
    if (!lpMoved) dispatchMouse('click', t.clientX, t.clientY);
    lastTarget = null;
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    clearTimeout(lpTimer);
    proxyActive = false;
    lastTarget = null;
  }, { passive: true });
})();
