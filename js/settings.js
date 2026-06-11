// ===== MA =====
const MA_COLORS = ['#ff9800','#ab47bc','#42a5f5','#ef5350','#26a69a','#ffeb3b','#ec407a','#66bb6a','#78909c','#fff'];
const MA_DEFAULTS = [
  { period: 20, enabled: true, color: MA_COLORS[0], type: 'SMA' },
  { period: 50, enabled: true, color: MA_COLORS[1], type: 'SMA' },
  { period: 200, enabled: true, color: MA_COLORS[2], type: 'SMA' }
];
// 古いキーを掃除
localStorage.removeItem('maParams');
localStorage.removeItem('maSetting');
localStorage.removeItem('maConfigs');

var maLines;
try {
  const saved = JSON.parse(localStorage.getItem('maLines'));
  maLines = (Array.isArray(saved) && saved.length > 0) ? saved.map((m, i) => ({ ...m, type: m.type || 'SMA', color: MA_COLORS[i % MA_COLORS.length] })) : MA_DEFAULTS;
} catch(e) { maLines = MA_DEFAULTS; }

var _maInitDone = false;
function applyMA() {
  const active = maLines.filter(m => m.enabled);
  const params = active.length > 0 ? active.map(m => m.period) : [20, 50, 200];
  _maTypes = active.length > 0 ? active.map(m => m.type || 'SMA') : ['SMA','SMA','SMA'];
  if (!_maInitDone) {
    chart.createIndicator('CustomMA', false, { id: 'candle_pane' });
    _maInitDone = true;
  }
  chart.overrideIndicator({ name: 'CustomMA', calcParams: params }, 'candle_pane');
  // 色をグローバルスタイルで適用（安全）
  const colors = maLines.map(m => ({ color: m.enabled ? m.color : 'transparent', size: m.enabled ? 1 : 0 }));
  chart.setStyles({ indicator: { lines: colors } });
}

function renderMAList() {
  document.getElementById('ma-list').innerHTML = maLines.map((m, i) => {
    const c = m.color;
    return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;padding:4px 0">
      <input type="checkbox" ${m.enabled?'checked':''} data-mai="${i}" class="ma-chk" style="accent-color:${c}">
      <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${c};flex-shrink:0"></span>
      <select data-mai="${i}" class="ma-type" style="background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:1px 2px;font-size:11px">
        <option value="SMA" ${(m.type||'SMA')==='SMA'?'selected':''}>MA</option>
        <option value="EMA" ${m.type==='EMA'?'selected':''}>EMA</option>
      </select>
      <input type="number" min="1" max="999" value="${m.period}" data-mai="${i}" class="ma-per" style="width:50px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:2px 4px;font-size:12px;text-align:center">
      <button onclick="removeMALine(${i})" style="margin-left:auto;background:none;border:none;color:#484f58;font-size:14px;cursor:pointer;padding:0 4px;min-height:20px">✕</button>
    </div>`;
  }).join('');
}

function cycleMAColor(i) {
  const cur = MA_COLORS.indexOf(maLines[i].color);
  maLines[i].color = MA_COLORS[(cur + 1) % MA_COLORS.length];
  renderMAList();
}
function removeMALine(i) { maLines.splice(i, 1); saveAndApplyMA(); renderMAList(); }

function saveAndApplyMA() {
  localStorage.setItem('maLines', JSON.stringify(maLines));
  applyMA();
}

renderMAList();
applyMA();

// FVGトグル
document.getElementById('fvg-toggle').checked = fvgEnabled;
document.getElementById('fvg-toggle').addEventListener('change', e => {
  fvgEnabled = e.target.checked;
  localStorage.setItem('fvgEnabled', JSON.stringify(fvgEnabled));
  fvgCacheIdx = -1; // キャッシュ無効化
  redrawFibo();
});

// BOS/CHoCH トグル
document.getElementById('bos-toggle').checked = bosEnabled;
document.getElementById('bos-toggle').addEventListener('change', e => {
  bosEnabled = e.target.checked;
  localStorage.setItem('bosEnabled', JSON.stringify(bosEnabled));
  bosCacheIdx = -1;
  redrawFibo();
});

// Order Block トグル
document.getElementById('ob-toggle').checked = obEnabled;
document.getElementById('ob-toggle').addEventListener('change', e => {
  obEnabled = e.target.checked;
  localStorage.setItem('obEnabled', JSON.stringify(obEnabled));
  obCacheIdx = -1;
  redrawFibo();
});

// 時間帯レンジ
document.getElementById('range-toggle').checked = rangeEnabled;
document.getElementById('range-from').value = rangeSetting.from;
document.getElementById('range-to').value = rangeSetting.to;
document.getElementById('range-end').value = rangeSetting.end;
document.getElementById('range-settings').style.display = rangeEnabled ? 'block' : 'none';

document.getElementById('range-toggle').addEventListener('change', e => {
  rangeEnabled = e.target.checked;
  localStorage.setItem('rangeEnabled', JSON.stringify(rangeEnabled));
  document.getElementById('range-settings').style.display = rangeEnabled ? 'block' : 'none';
  rangeCacheIdx = -1;
  redrawFibo();
});
['range-from','range-to','range-end'].forEach(id => {
  document.getElementById(id).addEventListener('change', e => {
    rangeSetting[id.replace('range-','')] = e.target.value;
    localStorage.setItem('rangeSetting', JSON.stringify(rangeSetting));
    rangeCacheIdx = -1;
    redrawFibo();
  });
});

document.getElementById('btn-settings').addEventListener('click', () => {
  const panel = document.getElementById('ma-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') renderMAList();
});
document.getElementById('ma-add').addEventListener('click', () => {
  const used = maLines.map(m => m.color);
  const next = MA_COLORS.find(c => !used.includes(c)) || MA_COLORS[maLines.length % MA_COLORS.length];
  maLines.push({ period: 20, enabled: true, color: next, type: 'SMA' });
  renderMAList();
});
document.getElementById('ma-apply').addEventListener('click', () => {
  // UIから値を読み取り
  document.querySelectorAll('.ma-per').forEach(el => {
    maLines[parseInt(el.dataset.mai)].period = parseInt(el.value) || 20;
  });
  document.querySelectorAll('.ma-chk').forEach(el => {
    maLines[parseInt(el.dataset.mai)].enabled = el.checked;
  });
  document.querySelectorAll('.ma-type').forEach(el => {
    maLines[parseInt(el.dataset.mai)].type = el.value;
  });
  saveAndApplyMA();
  document.getElementById('ma-panel').style.display = 'none';
});

// ===== 自動TP/SL =====
document.getElementById('auto-tpsl-toggle').checked = autoTPSL.enabled;
document.getElementById('auto-tp-pips').value = autoTPSL.tp;
document.getElementById('auto-sl-pips').value = autoTPSL.sl;
document.getElementById('auto-tpsl-settings').style.display = autoTPSL.enabled ? 'block' : 'none';

document.getElementById('auto-tpsl-toggle').addEventListener('change', e => {
  autoTPSL.enabled = e.target.checked;
  document.getElementById('auto-tpsl-settings').style.display = autoTPSL.enabled ? 'block' : 'none';
  localStorage.setItem('autoTPSL', JSON.stringify(autoTPSL));
});
document.getElementById('auto-tp-pips').addEventListener('change', e => {
  autoTPSL.tp = parseInt(e.target.value) || 50;
  localStorage.setItem('autoTPSL', JSON.stringify(autoTPSL));
});
document.getElementById('auto-sl-pips').addEventListener('change', e => {
  autoTPSL.sl = parseInt(e.target.value) || 30;
  localStorage.setItem('autoTPSL', JSON.stringify(autoTPSL));
});

// ===== キーボード =====
document.addEventListener('keydown', e => {
  if (e.key === ' ')          { e.preventDefault(); btnPlay.click(); }
  if (e.key === 'ArrowRight') advance(1);
  if (e.key === 'b' || e.key === 'B') document.getElementById('btn-buy').click();
  if (e.key === 's' || e.key === 'S') document.getElementById('btn-sell').click();
  // CLOSE ALLはボタンのみ（誤作動防止）
  if (e.key === 'f' || e.key === 'F') { enableFiboMode('fibo'); }
  if (e.key === 'Escape')     disableFiboMode();
});
