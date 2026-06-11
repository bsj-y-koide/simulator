// ===== ポジション管理 =====
var positions   = [];
var posId       = 0;
var realizedPnL = 0; // 確定済み損益
var sessionStartIdx = 0; // セッション開始時のバーインデックス
var sessionId = Date.now(); // セッション識別子
var tradeHistory = []; // このセッションの全トレード履歴
var pendingOrders = []; // 指値注文 { id, type:'BUY_LIMIT'|'SELL_LIMIT', price, lot, tp, sl, confirmed }
var selectedLimitId = null; // 編集中の指値ID
var selectedPosId = null; // TP/SL編集中のポジションID
var tpslDrag = null; // { posId, kind:'tp'|'sl' } ドラッグ中
var tpslCooldown = 0; // TP/SL設定直後のクールダウン

const HALF_SPREAD = 0.2; // 2pips = $0.20（片側）、合計4pips
function getLot() { return parseFloat(document.getElementById('lot').value); }

function openPosition(type) {
  const mid = livePrice || bars1m[curIdx1m].c;
  const price = type === 'BUY' ? mid + HALF_SPREAD : mid - HALF_SPREAD;
  const entryTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
  const pos = { id: ++posId, type, price, lot: getLot(), entryTime, entryIdx: curIdx1m, tp: null, sl: null };
  positions.push(pos);
  selectedPosId = null; // 初期状態はTP/SL非表示
  updatePnL(mid);
}

document.getElementById('btn-buy').addEventListener('click', () => { if (limitTimer === 'fired') { limitTimer = null; return; } openPosition('BUY'); });
document.getElementById('btn-sell').addEventListener('click', () => { if (limitTimer === 'fired') { limitTimer = null; return; } openPosition('SELL'); });

// 長押しで指値モード
let limitTimer = null;
// 長押しで指値モード（どちらのボタンでも同じ：価格位置でBUY/SELL自動判定）
['btn-buy','btn-sell'].forEach(id => {
  const btn = document.getElementById(id);
  const isBuyBtn = id === 'btn-buy';
  function placeLimitOrder() {
    limitTimer = 'fired';
    const mid = livePrice || bars1m[curIdx1m].c;
    const offset = mid * 0.001; // 現在価格の0.1%
    const type = isBuyBtn ? 'BUY_LIMIT' : 'SELL_LIMIT';
    const price = isBuyBtn ? mid - offset : mid + offset;
    const limitId = ++posId;
    pendingOrders.push({ id: limitId, type, price, lot: getLot(), tp: null, sl: null, confirmed: false });
    selectedLimitId = limitId;
    selectedPosId = null;
    redrawFibo();
  }
  btn.addEventListener('mousedown', () => { limitTimer = setTimeout(placeLimitOrder, 500); });
  btn.addEventListener('mouseup', () => { if (limitTimer !== 'fired') clearTimeout(limitTimer); });
  btn.addEventListener('mouseleave', () => { if (limitTimer !== 'fired') { clearTimeout(limitTimer); limitTimer = null; } });
  btn.addEventListener('touchstart', e => { limitTimer = setTimeout(() => { e.preventDefault(); placeLimitOrder(); }, 500); }, { passive: false });
  btn.addEventListener('touchend', () => { if (limitTimer !== 'fired') clearTimeout(limitTimer); });
  btn.addEventListener('contextmenu', e => e.preventDefault());
});
document.getElementById('btn-close').addEventListener('click', () => {
  const mid = livePrice || bars1m[curIdx1m].c;
  const closeTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
  // 全ポジションを決済して確定損益に加算 + DB保存
  for (const p of positions) {
    const cur = p.type === 'BUY' ? mid - HALF_SPREAD : mid + HALF_SPREAD; // BUY→Bidで決済、SELL→Askで決済
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    const pnlUsd = diff * p.lot * 100;
    realizedPnL += pnlUsd;
    const trade = {
      sessionId, type: p.type, lot: p.lot,
      entryPrice: p.price, closePrice: cur,
      entryTime: p.entryTime, closeTime,
      entryIdx: p.entryIdx, closeIdx: curIdx1m,
      pnlUsd, pnlJpy: Math.round(pnlUsd * JPY_RATE),
      pips: Math.round(diff * 10) / 10,
      holdBars: curIdx1m - p.entryIdx
    };
    tradeHistory.push(trade);
    if (db) dbAdd('trades', trade);
  }
  // セッション情報を更新
  if (db) {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      store.put({
        ...existing, id: sessionId, startIdx: sessionStartIdx,
        startDate: new Date(bars1m[sessionStartIdx].t * 1000).toISOString(),
        startPrice: bars1m[sessionStartIdx].c,
        trades: tradeHistory.length,
        totalPnL: realizedPnL,
        totalPnLJpy: Math.round(realizedPnL * JPY_RATE),
        drawings: {
          fibo: fiboSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 })),
          hline: hlineSaved.map(h => ({ price:h.price })),
          tline: tlineSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 }))
        }
      });
    };
  }
  positions = [];
  updatePnL(cur);
});

// TP/SL到達 & 指値約定チェック（毎ティック呼ばれる）
function checkTPSLAndLimits(mid) {
  // ドラッグ中・設定直後はチェックしない
  if (tpslDrag) return;
  if (tpslCooldown > Date.now()) return;
  // TP/SL
  const toClose = [];
  positions.forEach(p => {
    if (p.tp !== null) {
      if (p.type === 'BUY' && mid >= p.tp) toClose.push({ pos: p, closePrice: p.tp - HALF_SPREAD, reason: 'TP' });
      if (p.type === 'SELL' && mid <= p.tp) toClose.push({ pos: p, closePrice: p.tp + HALF_SPREAD, reason: 'TP' });
    }
    if (p.sl !== null) {
      if (p.type === 'BUY' && mid <= p.sl) toClose.push({ pos: p, closePrice: p.sl - HALF_SPREAD, reason: 'SL' });
      if (p.type === 'SELL' && mid >= p.sl) toClose.push({ pos: p, closePrice: p.sl + HALF_SPREAD, reason: 'SL' });
    }
  });
  toClose.forEach(({ pos, closePrice, reason }) => {
    const diff = pos.type === 'BUY' ? closePrice - pos.price : pos.price - closePrice;
    const pnlUsd = diff * pos.lot * 100;
    realizedPnL += pnlUsd;
    const closeTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
    const trade = {
      sessionId, type: pos.type, lot: pos.lot,
      entryPrice: pos.price, closePrice,
      entryTime: pos.entryTime, closeTime,
      entryIdx: pos.entryIdx, closeIdx: curIdx1m,
      pnlUsd, pnlJpy: Math.round(pnlUsd * JPY_RATE),
      pips: Math.round(diff * 10) / 10,
      holdBars: curIdx1m - pos.entryIdx,
      closeReason: reason
    };
    tradeHistory.push(trade);
    if (db) dbAdd('trades', trade);
    positions = positions.filter(pp => pp.id !== pos.id);
    if (selectedPosId === pos.id) selectedPosId = null;
  });

  // 指値約定
  const toFill = [];
  pendingOrders.forEach(o => {
    if (!o.confirmed) return;
    if (o.type === 'BUY_LIMIT' && mid <= o.price) toFill.push(o);
    if (o.type === 'SELL_LIMIT' && mid >= o.price) toFill.push(o);
  });
  toFill.forEach(o => {
    const type = o.type === 'BUY_LIMIT' ? 'BUY' : 'SELL';
    const price = type === 'BUY' ? o.price + HALF_SPREAD : o.price - HALF_SPREAD;
    const entryTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
    positions.push({ id: o.id, type, price, lot: o.lot, entryTime, entryIdx: curIdx1m, tp: o.tp, sl: o.sl });
    pendingOrders = pendingOrders.filter(pp => pp.id !== o.id);
  });

  if (toClose.length > 0 || toFill.length > 0) updatePnL(mid);
}

function calcFloat(mid) {
  let f = 0;
  for (const p of positions) {
    const cur = p.type === 'BUY' ? mid - HALF_SPREAD : mid + HALF_SPREAD;
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    f += diff * p.lot * 100;
  }
  return f;
}

const JPY_RATE = 160;
function fmtJpy(v) {
  const jpy = v * JPY_RATE;
  return `${jpy >= 0 ? '+' : ''}${Math.round(jpy).toLocaleString()}円`;
}
function fmtUsd(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}$`; }

function updatePnL(cur) {
  const floatPnL = calcFloat(cur);
  const totalPnL = realizedPnL + floatPnL;

  const fe = document.getElementById('pnl-float');
  fe.textContent = `含み: ${fmtJpy(floatPnL)}`;
  fe.style.color  = floatPnL >= 0 ? '#26a69a' : '#ef5350';

  const te = document.getElementById('pnl-total');
  te.textContent = `確定+含み: ${fmtJpy(totalPnL)}`;
  te.style.color  = totalPnL >= 0 ? '#26a69a' : '#ef5350';

  updatePosDisplay(cur);
}

function updatePosDisplay(cur) {
  const el = document.getElementById('positions');
  const info = document.getElementById('pos-info');
  if (positions.length === 0) {
    el.innerHTML = `<span style="color:#666">ポジションなし</span>　<span style="color:#aaa">確定: ${fmtJpy(realizedPnL)}</span>`;
    info.textContent = '';
    return;
  }
  el.innerHTML = positions.map(p => {
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    const pnl  = diff * p.lot * 100;
    return `<span style="color:${pnl>=0?'#26a69a':'#ef5350'}">[${p.id}] ${p.type} ${p.lot} @ ${p.price.toFixed(2)} → ${fmtJpy(pnl)}</span>`;
  }).join('  ') + `　<span style="color:#aaa;font-size:11px">確定累計: ${fmtJpy(realizedPnL)}</span>`;
  info.textContent = `${positions.length}件`;
}

// Bid/Ask価格ラベル（Y軸右側のみ）
function drawBidAskLines() {
  const mid = livePrice || bars1m[curIdx1m]?.c || 0;
  if (mid === 0) return;
  const bid = mid - HALF_SPREAD;
  const ask = mid + HALF_SPREAD;
  const w = chartDiv.clientWidth;

  const bidY = priceToY(bid);
  const askY = priceToY(ask);

  [{ price: bid, color: '#ef5350', y: bidY },
   { price: ask, color: '#26a69a', y: askY }].forEach(({ price, color, y }) => {
    if (y === null || y < 0 || y > chartDiv.clientHeight) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();
  });

  // ラベル（重ならないよう調整）
  if (bidY !== null && askY !== null) {
    ctx.save();
    ctx.font = 'bold 10px monospace';
    const lblH = 12;
    let by = bidY, ay = askY;
    // 近すぎる場合は上下にずらす
    if (Math.abs(by - ay) < lblH + 2) {
      const mid2 = (by + ay) / 2;
      ay = mid2 - lblH / 2 - 1;
      by = mid2 + lblH / 2 + 1;
    }
    [{ price: bid, color: '#ef5350', y: by },
     { price: ask, color: '#26a69a', y: ay }].forEach(({ price, color, y }) => {
      const label = price.toFixed(2);
      const tw = ctx.measureText(label).width;
      const lx = w - tw - 4;
      ctx.fillStyle = color;
      ctx.fillRect(lx - 2, y - 6, tw + 4, lblH);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, y + 3);
    });
    ctx.restore();
  }
}

function drawTradeMarkers() {
  if (tradeHistory.length === 0) return;
  tradeHistory.forEach(t => {
    const entryX = timeToX(t.entryTime ? new Date(t.entryTime).getTime() : null);
    const closeX = timeToX(t.closeTime ? new Date(t.closeTime).getTime() : null);
    const entryY = priceToY(t.entryPrice);
    const closeY = priceToY(t.closePrice);
    const isBuy = t.type === 'BUY';
    const profit = t.pnlUsd >= 0;

    // エントリー→決済の接続線
    if (entryX !== null && closeX !== null && entryY !== null && closeY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = profit ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(entryX, entryY);
      ctx.lineTo(closeX, closeY);
      ctx.stroke();
      ctx.restore();
    }

    // エントリーマーカー（▲/▼）
    if (entryX !== null && entryY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = isBuy ? '#1565c0' : '#b71c1c';
      ctx.beginPath();
      if (isBuy) {
        ctx.moveTo(entryX, entryY + 6);
        ctx.lineTo(entryX - 5, entryY + 14);
        ctx.lineTo(entryX + 5, entryY + 14);
      } else {
        ctx.moveTo(entryX, entryY - 6);
        ctx.lineTo(entryX - 5, entryY - 14);
        ctx.lineTo(entryX + 5, entryY - 14);
      }
      ctx.fill();
      ctx.restore();
    }

    // 決済マーカー（×）
    if (closeX !== null && closeY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = profit ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(closeX - 5, closeY - 5);
      ctx.lineTo(closeX + 5, closeY + 5);
      ctx.moveTo(closeX + 5, closeY - 5);
      ctx.lineTo(closeX - 5, closeY + 5);
      ctx.stroke();
      // 損益ラベル
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = profit ? '#26a69a' : '#ef5350';
      ctx.fillText(fmtJpy(t.pnlUsd), closeX + 8, closeY + 4);
      ctx.restore();
    }
  });
}

function drawPositionLines() {
  const cur = livePrice || bars1m[curIdx1m]?.c || 0;
  const w = chartDiv.clientWidth;

  // 指値注文ライン
  pendingOrders.forEach(o => {
    const y = priceToY(o.price);
    if (y === null) return;
    const isBuy = o.type === 'BUY_LIMIT';
    ctx.save();
    ctx.strokeStyle = isBuy ? '#42a5f5' : '#ef5350';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 4]);
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = isBuy ? '#42a5f5' : '#ef5350';
    ctx.fillText(`${o.type} @ ${o.price.toFixed(2)}`, 4, y - 4);
    // ドラッグハンドル（未確定 or 選択中のみ）
    if (!o.confirmed || selectedLimitId === o.id) {
      ctx.beginPath(); ctx.arc(w / 2, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = isBuy ? '#42a5f5' : '#ef5350'; ctx.globalAlpha = 0.6; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
    }
    ctx.restore();

    // 指値のTP/SL
    const isLimitSel = selectedLimitId === o.id;
    if (o.tp !== null) drawTPSLLine(o.tp, 'TP', true, isBuy ? 'BUY' : 'SELL', o.lot, isLimitSel);
    if (o.sl !== null) drawTPSLLine(o.sl, 'SL', false, isBuy ? 'BUY' : 'SELL', o.lot, isLimitSel);
    // 選択中ガイド
    if (isLimitSel) {
      if (o.tp === null) {
        const gy = priceToY(isBuy ? o.price*(1+0.001) : o.price*(1-0.001));
        if (gy !== null) {
          ctx.save(); ctx.globalAlpha = 0.8; ctx.strokeStyle = '#76ff03'; ctx.lineWidth = 1.5;
          ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
          ctx.setLineDash([]); ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#76ff03';
          ctx.fillText('← TP', w/2-20, gy-5);
          ctx.beginPath(); ctx.arc(w/2, gy, 7, 0, Math.PI*2);
          ctx.fillStyle = '#76ff03'; ctx.globalAlpha = 0.6; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
          ctx.restore();
        }
      }
      if (o.sl === null) {
        const gy = priceToY(isBuy ? o.price*(1-0.001) : o.price*(1+0.001));
        if (gy !== null) {
          ctx.save(); ctx.globalAlpha = 0.8; ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 1.5;
          ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
          ctx.setLineDash([]); ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#ff5252';
          ctx.fillText('← SL', w/2-20, gy+14);
          ctx.beginPath(); ctx.arc(w/2, gy, 7, 0, Math.PI*2);
          ctx.fillStyle = '#ff5252'; ctx.globalAlpha = 0.6; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
          ctx.restore();
        }
      }
    }
  });

  if (positions.length === 0) return;
  positions.forEach(p => {
    const y = priceToY(p.price);
    if (y === null || y < 0 || y > fiboCanvas.height) return;
    const isBuy = p.type === 'BUY';
    const diff  = isBuy ? cur - p.price : p.price - cur;
    const profit = diff >= 0;
    ctx.save();
    ctx.strokeStyle = isBuy ? '#42a5f5' : '#ef5350';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.font = 'bold 12px monospace';
    const pnl  = diff * p.lot * 100;
    const label = `${p.type}  ${fmtJpy(pnl)}`;
    const tw = ctx.measureText(label).width;
    const lx = (w - tw) / 2 - 4;
    ctx.fillStyle = profit ? '#1b5e20cc' : '#b71c1ccc';
    ctx.fillRect(lx, y - 15, tw + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 4, y - 3);
    ctx.restore();

    // TP/SLライン & ハンドル
    const isSelected = selectedPosId === p.id;
    if (p.tp !== null) drawTPSLLine(p.tp, 'TP', true, p.type, p.lot, isSelected);
    if (p.sl !== null) drawTPSLLine(p.sl, 'SL', false, p.type, p.lot, isSelected);

    // 選択中: TP/SLドラッグハンドル（未設定なら薄いガイドライン）
    if (isSelected) {
      if (p.tp === null) {
        const guideY = priceToY(isBuy ? p.price*(1+0.001) : p.price*(1-0.001));
        if (guideY !== null) {
          ctx.save(); ctx.globalAlpha = 0.8; ctx.strokeStyle = '#76ff03'; ctx.lineWidth = 1.5;
          ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(0, guideY); ctx.lineTo(w, guideY); ctx.stroke();
          ctx.setLineDash([]); ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#76ff03';
          ctx.fillText('← TP', w/2 - 20, guideY - 5);
          ctx.beginPath(); ctx.arc(w/2, guideY, 7, 0, Math.PI*2);
          ctx.fillStyle = '#76ff03'; ctx.globalAlpha = 0.6; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
          ctx.restore();
        }
      }
      if (p.sl === null) {
        const guideY = priceToY(isBuy ? p.price*(1-0.001) : p.price*(1+0.001));
        if (guideY !== null) {
          ctx.save(); ctx.globalAlpha = 0.8; ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 1.5;
          ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(0, guideY); ctx.lineTo(w, guideY); ctx.stroke();
          ctx.setLineDash([]); ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#ff5252';
          ctx.fillText('← SL', w/2 - 20, guideY + 14);
          ctx.beginPath(); ctx.arc(w/2, guideY, 7, 0, Math.PI*2);
          ctx.fillStyle = '#ff5252'; ctx.globalAlpha = 0.6; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
          ctx.restore();
        }
      }
    }
  });
}

function drawTPSLLine(price, kind, isTP, posType, lot, showHandle) {
  const y = priceToY(price);
  if (y === null) return;
  const w = chartDiv.clientWidth;
  const color = isTP ? '#76ff03' : '#ff5252';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();

  // ラベル
  ctx.setLineDash([]);
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = color;
  ctx.fillText(`${kind} ${price.toFixed(2)}`, 4, y - 4);
  ctx.restore();

  // ハンドル
  if (showHandle !== false) {
    ctx.save();
    ctx.beginPath(); ctx.arc(w/2, y, 6, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.globalAlpha = 0.6; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke();
    ctx.restore();
  }
}
