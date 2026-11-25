/* ============================================================
   Estoque São João — app de controle de estoque (versão Firebase)
   Os dados ficam no Firestore da conta Google da empresa e
   aparecem em tempo real em todos os aparelhos (precisa de login).
   ============================================================ */
(function(){
"use strict";

var DEFAULT_PARAMS = { leadTimeDias: 5, margemPct: 0, diasAno: 365 };

var STATUS_LABEL = { critico:"Crítico", baixo:"Baixo", ok:"Em dia" };
var STATUS_COLOR = { critico:"var(--crit)", baixo:"var(--pink)", ok:"var(--teal)" };

/* ---------------- state ---------------- */
var state = {
  ready:false,
  online:true,
  items:{},            // codigo(string) -> {produto,categoria,qtdAnual,estoqueAtual,localizacao,emProducao,ordemAtualId}
  movements:[],         // recent movements, newest first
  orders:[],            // production orders (aberta/concluida/cancelada)
  params: Object.assign({}, DEFAULT_PARAMS),
  tab:"painel",
  filter:"todos",       // todos | critico | baixo | ok
  search:"",
  cfgTab:"localizacao",
  movSelected:null,     // codigo currently chosen in mov form
  movTipo:"entrada",
  relPeriodo:7           // dias considerados na coluna/relatório de concluídas (0 = tudo)
};

/* ---------------- helpers ---------------- */
function el(html){
  var t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function qs(sel, root){ return (root||document).querySelector(sel); }
function qsa(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
function fmtInt(n){ return Math.round(n).toLocaleString('pt-BR'); }
function nowIso(){ return new Date().toISOString(); }
function fmtDateTime(iso){
  try{
    var d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  }catch(e){ return ''; }
}
function fmtDate(iso){
  try{ return new Date(iso).toLocaleDateString('pt-BR'); }catch(e){ return ''; }
}
function toast(msg){
  var t = qs('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(function(){ t.classList.remove('show'); }, 2400);
}
function norm(s){
  return (s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function isTypingInForm(){
  var a = document.activeElement;
  if(!a) return false;
  var tag = a.tagName;
  return (tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT') && qs('#content').contains(a);
}

/* ---------------- derived data ---------------- */
function computeMin(qtdAnual){
  var p = state.params;
  var dias = p.diasAno > 0 ? p.diasAno : 365;
  var v = (qtdAnual / dias) * p.leadTimeDias * (1 + (p.margemPct/100));
  return Math.max(0, Math.round(v));
}
function statusOf(atual, min){
  if(atual <= 0) return 'critico';
  if(atual < min) return 'baixo';
  return 'ok';
}
function allItemsArray(){
  var out = [];
  for(var cod in state.items){
    if(!state.items.hasOwnProperty(cod)) continue;
    var it = state.items[cod];
    var min = computeMin(it.qtdAnual||0);
    var atual = it.estoqueAtual||0;
    out.push({
      codigo: cod,
      produto: it.produto,
      categoria: it.categoria,
      qtdAnual: it.qtdAnual||0,
      estoqueAtual: atual,
      localizacao: it.localizacao||'',
      emProducao: !!it.emProducao,
      ordemAtualId: it.ordemAtualId||null,
      min: min,
      status: statusOf(atual, min)
    });
  }
  return out;
}
function filteredItems(){
  var arr = allItemsArray();
  var s = norm(state.search);
  if(s){
    arr = arr.filter(function(it){
      return norm(it.produto).indexOf(s) > -1 || norm(it.codigo).indexOf(s) > -1 || norm(it.categoria).indexOf(s) > -1;
    });
  }
  if(state.filter !== 'todos'){
    arr = arr.filter(function(it){ return it.status === state.filter; });
  }
  arr.sort(function(a,b){
    var order = {critico:0, baixo:1, ok:2};
    if(order[a.status] !== order[b.status]) return order[a.status]-order[b.status];
    return a.produto.localeCompare(b.produto,'pt-BR');
  });
  return arr;
}

/* ---------------- comunicação com o Firebase ---------------- */
var _got = { items:false, movements:false, orders:false, params:false };
var _unsub = null;
var _dirty = false;
var _busy = false;
var _bootTimer = null;

function friendlyError(e){
  if(e && e.userMessage) return e.userMessage;
  var code = (e && e.code) || '';
  if(code.indexOf('permission-denied') > -1) return 'Sem permissão. Saia e entre de novo com o e-mail da empresa.';
  if(code.indexOf('unavailable') > -1 || code.indexOf('network') > -1) return 'Sem internet no momento. Tente de novo quando voltar.';
  return (e && e.message) ? e.message : 'erro desconhecido';
}

function setOnline(ok){
  if(state.online === ok) return;
  state.online = ok;
  var dot = qs('#conn-dot');
  if(dot) dot.classList.toggle('offline', !ok);
  if(!ok && state.ready) toast('Sem internet. Você ainda vê os dados salvos, mas só consegue registrar quando voltar.');
  if(ok && state.ready) toast('Conexão restabelecida.');
}

function dataArrived(kind, value){
  if(kind === 'items') state.items = value;
  else if(kind === 'movements') state.movements = value;
  else if(kind === 'orders') state.orders = value;
  else if(kind === 'params') state.params = Object.assign({}, DEFAULT_PARAMS, value || {});
  _got[kind] = true;
  if(!(_got.items && _got.movements && _got.orders && _got.params)) return;
  if(!state.ready){
    state.ready = true;
    clearTimeout(_bootTimer);
    finishBoot();
    return;
  }
  if(isTypingInForm()){ _dirty = true; return; }
  renderCurrentTab();
}

function showBootError(){
  var errBox = qs('#loading-error'), spinner = qs('#loading-spinner'), text = qs('#loading-text');
  if(errBox) errBox.classList.remove('hidden');
  if(spinner) spinner.classList.add('hidden');
  if(text) text.textContent = 'Não foi possível carregar…';
}

function hideBootError(){
  var errBox = qs('#loading-error'), spinner = qs('#loading-spinner'), text = qs('#loading-text');
  if(errBox) errBox.classList.add('hidden');
  if(spinner) spinner.classList.remove('hidden');
  if(text) text.textContent = 'Carregando estoque…';
}

function finishBoot(){
  qs('#loading').classList.add('hidden');
  qs('#login').classList.add('hidden');
  qs('#app').classList.remove('hidden');
  renderContent();
}

function startData(){
  stopData();
  _got = { items:false, movements:false, orders:false, params:false };
  state.ready = false;
  hideBootError();
  qs('#loading').classList.remove('hidden');
  _bootTimer = setTimeout(function(){ if(!state.ready) showBootError(); }, 15000);
  _unsub = FB.subscribe({
    onItems: function(v){ dataArrived('items', v); },
    onMovements: function(v){ dataArrived('movements', v); },
    onOrders: function(v){ dataArrived('orders', v); },
    onParams: function(v){ dataArrived('params', v); },
    onError: function(e){
      console.error(e);
      if(!state.ready){ showBootError(); }
      else toast('Problema de conexão: ' + friendlyError(e));
    }
  });
}

function stopData(){
  if(_unsub){ _unsub(); _unsub = null; }
  clearTimeout(_bootTimer);
}

function showLogin(msg){
  stopData();
  state.ready = false;
  qs('#loading').classList.add('hidden');
  qs('#app').classList.add('hidden');
  qs('#login').classList.remove('hidden');
  var m = qs('#login-msg');
  m.textContent = msg || '';
  m.classList.toggle('hidden', !msg);
}

function showConfigMissing(){
  qs('#loading').classList.add('hidden');
  qs('#config-missing').classList.remove('hidden');
}

async function initApp(){
  bindNav();
  var retryBtn = qs('#loading-retry');
  if(retryBtn) retryBtn.addEventListener('click', function(){ startData(); });

  var cfg = window.FIREBASE_CONFIG;
  if(!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('COLE') === 0){ showConfigMissing(); return; }

  var emu = /[?&]emu=1/.test(location.search) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  FB.init(cfg, { emulator: emu });

  qs('#login-form').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var btn = qs('#login-btn');
    btn.disabled = true; btn.textContent = 'Entrando…';
    try{
      await FB.login(qs('#login-email').value.trim(), qs('#login-pass').value);
    }catch(e){
      var c = (e && e.code) || '';
      var msg = (c.indexOf('invalid-credential') > -1 || c.indexOf('wrong-password') > -1 || c.indexOf('user-not-found') > -1 || c.indexOf('invalid-email') > -1)
        ? 'E-mail ou senha incorretos.'
        : (c.indexOf('network') > -1 ? 'Sem internet. Tente de novo.' : 'Não consegui entrar (' + (c || e.message) + ').');
      var m = qs('#login-msg'); m.textContent = msg; m.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = 'Entrar';
  });

  var lo = qs('#logout-btn');
  if(lo) lo.addEventListener('click', function(){ FB.logout(); });

  FB.onAuth(function(user){
    if(user){ qs('#login-pass').value = ''; startData(); }
    else showLogin('');
  });

  window.addEventListener('online', function(){ setOnline(true); });
  window.addEventListener('offline', function(){ setOnline(false); });
  setOnline(navigator.onLine !== false);

  // se uma atualização chegou enquanto a pessoa digitava, mostra assim que ela terminar
  document.addEventListener('focusout', function(){
    if(!_dirty) return;
    setTimeout(function(){ if(_dirty && !isTypingInForm()){ _dirty = false; renderCurrentTab(); } }, 350);
  });
}

/* ---------------- escritas ---------------- */
async function writeItemField(codigo, patch){
  state.items[codigo] = Object.assign({}, state.items[codigo], patch);
  renderCurrentTab();
  try{
    await FB.updateItem(codigo, patch);
  }catch(e){
    console.error(e);
    toast('Não deu para salvar agora: ' + friendlyError(e));
  }
}

async function addProduct(data){
  var codigo = String(data.codigo||'').trim();
  if(!codigo || !data.produto){ toast('Informe o código e o nome do produto.'); return; }
  if(codigo.indexOf('/') > -1){ toast('O código não pode ter "/".'); return; }
  try{
    await FB.addItem(codigo, {
      produto: String(data.produto),
      categoria: String(data.categoria||'OUTROS').toUpperCase(),
      qtdAnual: Number(data.qtdAnual)||0,
      estoqueAtual: Number(data.estoqueAtual)||0,
      localizacao: String(data.localizacao||''),
      emProducao:false, ordemAtualId:null
    });
    toast('Produto adicionado!');
  }catch(e){ console.error(e); toast('Erro ao salvar o produto: ' + friendlyError(e)); }
}

async function registerMovement(codigo, tipo, qtd, obs){
  var it = state.items[codigo];
  if(!it || _busy) return;
  _busy = true;
  try{
    await FB.addMovement(codigo, tipo, qtd, obs||'');
    toast((tipo==='entrada' ? 'Entrada' : 'Saída') + ' registrada: ' + qtd + ' un.');
  }catch(e){
    console.error(e);
    toast('Não registrou: ' + friendlyError(e));
  }
  _busy = false;
}

async function saveParams(newParams){
  state.params = Object.assign({}, state.params, newParams);
  renderCurrentTab();
  try{
    await FB.saveParams(newParams);
    toast('Parâmetros atualizados.');
  }catch(e){ console.error(e); toast('Não deu para salvar os parâmetros: ' + friendlyError(e)); }
}

/* ---- ordens de produção (para o kanban de 3 colunas + relatório) ---- */
function periodDays(){ return state.relPeriodo; }
function withinPeriod(iso, days){
  if(!days || days<=0) return true;
  if(!iso) return false;
  var cutoff = Date.now() - days*24*60*60*1000;
  return new Date(iso).getTime() >= cutoff;
}

async function startProductionOrder(it){
  try{
    var min = computeMin(it.qtdAnual||0);
    var deficit = Math.max(0, min - (it.estoqueAtual||0));
    await FB.startOrder(it.codigo, deficit);
    toast('Produção de "'+it.produto+'" disparada.');
  }catch(e){ console.error(e); toast('Erro ao iniciar produção: ' + friendlyError(e)); }
}

async function cancelProductionOrder(it){
  var orderId = it.ordemAtualId;
  if(!orderId) return;
  try{
    await FB.cancelOrder(orderId);
    toast('Produção de "'+it.produto+'" cancelada.');
  }catch(e){ console.error(e); toast('Erro ao cancelar: ' + friendlyError(e)); }
}

async function concludeProductionOrder(it, quantidade, registrarEntrada){
  var orderId = it.ordemAtualId;
  if(!orderId){ toast('Essa ordem não foi encontrada.'); return; }
  try{
    await FB.concludeOrder(orderId, quantidade, !!registrarEntrada);
    toast('Produção de "'+it.produto+'" concluída: '+fmtInt(quantidade)+' un.');
  }catch(e){ console.error(e); toast('Erro ao concluir: ' + friendlyError(e)); }
}

function renderCurrentTab(){ if(state.ready) renderContent(); }

function setTab(tab){
  state.tab = tab;
  qsa('.navbtn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === tab); });
  var sub = {
    painel:'Painel de controle', mov:'Entradas e saídas', producao:'Lista de produção', config:'Configurações'
  };
  qs('#topbar-sub').textContent = sub[tab] || '';
  renderContent();
  window.scrollTo(0,0);
}

function renderContent(){
  var c = qs('#content');
  c.innerHTML = '';
  if(Object.keys(state.items).length === 0){ c.appendChild(renderSetup()); return; }
  if(state.tab === 'painel') c.appendChild(renderPainel());
  else if(state.tab === 'mov') c.appendChild(renderMov());
  else if(state.tab === 'producao') c.appendChild(renderProducao());
  else if(state.tab === 'config') c.appendChild(renderConfig());
}

/* ----------------------- PAINEL (Kanban) ----------------------- */
function renderPainel(){
  var wrap = el('<div></div>');
  var all = allItemsArray();
  var counts = { critico:0, baixo:0, ok:0 };
  all.forEach(function(it){ counts[it.status]++; });

  wrap.appendChild(el(
    '<div class="section-head">'+
      '<div><h1>Painel de estoque</h1><p>'+all.length+' itens no catálogo</p></div>'+
    '</div>'
  ));

  var search = el(
    '<div class="searchbar">'+
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'+
      '<input type="text" placeholder="Buscar produto, código ou categoria" id="search-input">'+
    '</div>'
  );
  search.querySelector('input').value = state.search;
  search.querySelector('input').addEventListener('input', function(e){
    state.search = e.target.value; renderContent();
    setTimeout(function(){
      var i = qs('#search-input'); if(i){ i.focus(); i.selectionStart = i.selectionEnd = i.value.length; }
    },0);
  });
  wrap.appendChild(search);

  var chips = el('<div class="chiprow"></div>');
  [
    ['todos','Todos', all.length, 'var(--ink-soft)'],
    ['critico','Crítico', counts.critico, 'var(--crit)'],
    ['baixo','Baixo', counts.baixo, 'var(--pink)'],
    ['ok','Em dia', counts.ok, 'var(--teal)']
  ].forEach(function(c){
    var chip = el('<button class="chip" data-k="'+c[0]+'"><span class="dot" style="background:'+c[3]+'"></span>'+c[1]+' <span class="count">'+c[2]+'</span></button>');
    if(state.filter === c[0]) chip.classList.add('active');
    chip.addEventListener('click', function(){ state.filter = c[0]; renderContent(); });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);

  var items = filteredItems();

  if(items.length === 0){
    wrap.appendChild(el(
      '<div class="empty">'+
        '<svg viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.6"/></svg>'+
        '<b>Nada por aqui</b>Ajuste a busca ou o filtro selecionado.'+
      '</div>'
    ));
    return wrap;
  }

  // mobile list
  var list = el('<div class="list-mobile"></div>');
  items.forEach(function(it){ list.appendChild(productCard(it)); });
  wrap.appendChild(list);

  // desktop board
  var board = el('<div class="board"></div>');
  ['critico','baixo','ok'].forEach(function(st){
    var col = el(
      '<div class="board-col">'+
        '<div class="board-col__head"><span class="dot" style="background:'+STATUS_COLOR[st]+'"></span>'+STATUS_LABEL[st]+' <span style="color:var(--ink-soft);font-weight:600;">('+counts[st]+')</span></div>'+
        '<div class="board-col__cards"></div>'+
      '</div>'
    );
    var body = col.querySelector('.board-col__cards');
    items.filter(function(it){ return it.status===st; }).forEach(function(it){ body.appendChild(productCard(it)); });
    if(items.filter(function(it){return it.status===st;}).length===0){
      body.appendChild(el('<div style="text-align:center;color:var(--ink-soft);font-size:12.5px;padding:18px 0;">Nenhum item aqui</div>'));
    }
    board.appendChild(col);
  });
  wrap.appendChild(board);

  return wrap;
}

function productCard(it){
  var pct = it.min > 0 ? Math.min(100, Math.round((it.estoqueAtual/it.min)*100)) : (it.estoqueAtual>0?100:0);
  var card = el(
    '<div class="pcard st-'+it.status+'" data-cod="'+it.codigo+'">'+
      '<div class="pcard__top">'+
        '<div>'+
          '<div class="pcard__name">'+escapeHtml(it.produto)+'</div>'+
          '<div class="pcard__meta">'+
            '<span class="badge code">#'+it.codigo+'</span>'+
            '<span class="badge">'+escapeHtml(it.categoria)+'</span>'+
            (it.emProducao ? '<span class="badge prod">Em produção</span>' : '')+
          '</div>'+
          (it.localizacao ? '<div class="pcard__loc"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.4" stroke="currentColor" stroke-width="1.8"/></svg>'+escapeHtml(it.localizacao)+'</div>' : '')+
        '</div>'+
      '</div>'+
      '<div class="qtyrow">'+
        '<div class="qtybox"><b>'+fmtInt(it.estoqueAtual)+'</b><span>mín. '+fmtInt(it.min)+' un.</span></div>'+
        '<div class="steppers">'+
          '<button class="stepbtn minus" data-act="minus">–</button>'+
          '<button class="stepbtn plus" data-act="plus">+</button>'+
        '</div>'+
      '</div>'+
      '<div class="bar"><div class="bar__fill" style="width:'+pct+'%"></div></div>'+
    '</div>'
  );
  card.addEventListener('click', function(e){
    if(e.target.closest('.stepbtn')) return;
    openProductModal(it.codigo);
  });
  card.querySelector('.stepbtn.plus').addEventListener('click', function(e){
    e.stopPropagation(); quickStep(it.codigo, 'entrada');
  });
  card.querySelector('.stepbtn.minus').addEventListener('click', function(e){
    e.stopPropagation(); quickStep(it.codigo, 'saida');
  });
  return card;
}

function quickStep(codigo, tipo){
  registerMovement(codigo, tipo, 1, 'Ajuste rápido no painel');
}

function escapeHtml(s){
  return (s||'').toString().replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

/* ----------------------- PRODUCT MODAL ----------------------- */
function openProductModal(codigo){
  var it = allItemsArray().filter(function(x){ return x.codigo===codigo; })[0];
  if(!it) return;
  var root = qs('#modal-root');
  var hist = state.movements.filter(function(m){ return m.codigo===codigo; }).slice(0,8);

  var backdrop = el('<div class="modal-backdrop"></div>');
  var modal = el(
    '<div class="modal">'+
      '<div class="modal__head">'+
        '<div><h2>'+escapeHtml(it.produto)+'</h2><p>Código #'+it.codigo+' · '+escapeHtml(it.categoria)+'</p></div>'+
        '<button class="modal__close" id="m-close">✕</button>'+
      '</div>'+
      '<div class="grid2" style="margin-bottom:14px;">'+
        '<div class="stat"><b style="color:'+STATUS_COLOR[it.status]+'">'+fmtInt(it.estoqueAtual)+'</b><span>Estoque atual</span></div>'+
        '<div class="stat"><b>'+fmtInt(it.min)+'</b><span>Estoque mínimo</span></div>'+
      '</div>'+
      '<div class="field">'+
        '<label>Localização no estoque</label>'+
        '<input type="text" id="m-loc" placeholder="Ex.: Câmara 2 · Prateleira B3" value="'+escapeHtml(it.localizacao)+'">'+
      '</div>'+
      '<div class="grid2" style="margin-bottom:6px;">'+
        '<button class="btn btn-primary" id="m-entrada">+ Registrar entrada</button>'+
        '<button class="btn btn-primary pink" id="m-saida">– Registrar saída</button>'+
      '</div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:14px 0 4px 0;font-size:13px;font-weight:600;color:var(--ink-soft);">'+
        '<input type="checkbox" id="m-producao" '+(it.emProducao?'checked':'')+' style="width:17px;height:17px;" '+(it.emProducao?'disabled':'')+'>'+
        (it.emProducao ? 'Em produção — use os botões abaixo para concluir ou cancelar' : 'Marcar como "em produção"')+
      '</label>'+
      (it.emProducao ? '<div class="grid2" style="margin-top:8px;">'+
        '<button class="btn btn-primary" id="m-concluir">✓ Concluir</button>'+
        '<button class="btn btn-outline" id="m-cancelar">Cancelar produção</button>'+
      '</div>' : '')+
      '<div style="margin-top:16px;">'+
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px;">Últimas movimentações</div>'+
        '<div id="m-hist"></div>'+
      '</div>'+
    '</div>'
  );
  backdrop.appendChild(modal);
  root.innerHTML='';
  root.appendChild(backdrop);

  var histEl = modal.querySelector('#m-hist');
  if(hist.length===0){
    histEl.appendChild(el('<div style="font-size:12.5px;color:var(--ink-soft);">Nenhuma movimentação registrada ainda.</div>'));
  }else{
    hist.forEach(function(m){
      histEl.appendChild(el(
        '<div class="movrow">'+
          '<div class="movicon '+m.tipo+'">'+(m.tipo==='entrada'?'+':'–')+'</div>'+
          '<div class="movbody"><b>'+(m.tipo==='entrada'?'Entrada':'Saída')+'</b><span>'+fmtDateTime(m.timestamp)+(m.obs?' · '+escapeHtml(m.obs):'')+'</span></div>'+
          '<div class="movqty '+m.tipo+'">'+(m.tipo==='entrada'?'+':'-')+m.quantidade+'</div>'+
        '</div>'
      ));
    });
  }

  function close(){ root.innerHTML=''; }
  backdrop.addEventListener('click', function(e){ if(e.target===backdrop) close(); });
  modal.querySelector('#m-close').addEventListener('click', close);
  modal.querySelector('#m-loc').addEventListener('change', function(e){
    writeItemField(codigo, { localizacao: e.target.value });
  });
  modal.querySelector('#m-producao').addEventListener('change', function(){
    if(!it.emProducao) startProductionOrder(it);
    close();
  });
  var mConcluir = modal.querySelector('#m-concluir');
  if(mConcluir) mConcluir.addEventListener('click', function(){ close(); openConcludeModal(it); });
  var mCancelar = modal.querySelector('#m-cancelar');
  if(mCancelar) mCancelar.addEventListener('click', function(){ close(); cancelProductionOrder(it); });
  modal.querySelector('#m-entrada').addEventListener('click', function(){
    close(); state.tab='mov'; state.movSelected=codigo; state.movTipo='entrada';
    setTab('mov');
  });
  modal.querySelector('#m-saida').addEventListener('click', function(){
    close(); state.tab='mov'; state.movSelected=codigo; state.movTipo='saida';
    setTab('mov');
  });
}

/* ----------------------- MOVIMENTAÇÃO ----------------------- */
function renderMov(){
  var wrap = el('<div></div>');
  wrap.appendChild(el(
    '<div class="section-head"><div><h1>Entradas e saídas</h1><p>Registre o que entrou ou saiu do estoque</p></div></div>'
  ));

  var card = el('<div class="card"></div>');

  var seg = el(
    '<div class="segmented" style="margin-bottom:14px;">'+
      '<button data-t="entrada" class="'+(state.movTipo==='entrada'?'active entrada':'')+'">Entrada</button>'+
      '<button data-t="saida" class="'+(state.movTipo==='saida'?'active saida':'')+'">Saída</button>'+
    '</div>'
  );
  qsa('button', seg).forEach(function(b){
    b.addEventListener('click', function(){ state.movTipo = b.dataset.t; renderContent(); });
  });
  card.appendChild(seg);

  var selectedItem = state.movSelected ? state.items[state.movSelected] : null;

  var acField = el(
    '<div class="field autocomplete">'+
      '<label>Produto</label>'+
      '<input type="text" id="mov-search" placeholder="Digite o nome ou código do produto" autocomplete="off" value="'+(selectedItem?escapeHtml(selectedItem.produto)+' (#'+state.movSelected+')':'')+'">'+
      '<div class="ac-results hidden" id="mov-results"></div>'+
    '</div>'
  );
  card.appendChild(acField);

  var qtyField = el(
    '<div class="field"><label>Quantidade</label><input type="number" id="mov-qtd" min="1" step="1" placeholder="0" inputmode="numeric"></div>'
  );
  card.appendChild(qtyField);

  var obsField = el(
    '<div class="field"><label>Observação (opcional)</label><input type="text" id="mov-obs" placeholder="Ex.: pedido cliente, perda, contagem"></div>'
  );
  card.appendChild(obsField);

  var submitBtn = el('<button class="btn btn-primary btn-block" id="mov-submit">Registrar movimentação</button>');
  card.appendChild(submitBtn);

  wrap.appendChild(card);

  // autocomplete logic
  var input = acField.querySelector('#mov-search');
  var results = acField.querySelector('#mov-results');
  input.addEventListener('input', function(){
    var s = norm(input.value);
    state.movSelected = null;
    if(!s){ results.classList.add('hidden'); results.innerHTML=''; return; }
    var matches = allItemsArray().filter(function(it){
      return norm(it.produto).indexOf(s)>-1 || norm(it.codigo).indexOf(s)>-1;
    }).slice(0,8);
    if(matches.length===0){ results.classList.add('hidden'); results.innerHTML=''; return; }
    results.innerHTML='';
    matches.forEach(function(it){
      var row = el('<div class="ac-item">'+escapeHtml(it.produto)+'<small>#'+it.codigo+' · '+escapeHtml(it.categoria)+' · estoque atual: '+fmtInt(it.estoqueAtual)+'</small></div>');
      row.addEventListener('click', function(){
        state.movSelected = it.codigo;
        input.value = it.produto + ' (#'+it.codigo+')';
        results.classList.add('hidden');
      });
      results.appendChild(row);
    });
    results.classList.remove('hidden');
  });
  document.addEventListener('click', function(e){
    if(!acField.contains(e.target)) results.classList.add('hidden');
  }, {once:true});

  submitBtn.addEventListener('click', function(){
    if(!state.movSelected){ toast('Escolha um produto na lista.'); return; }
    var qtd = parseInt(qs('#mov-qtd').value, 10);
    if(!qtd || qtd<=0){ toast('Informe uma quantidade válida.'); return; }
    var obs = qs('#mov-obs').value;
    registerMovement(state.movSelected, state.movTipo, qtd, obs);
    state.movSelected = null;
    renderContent();
  });

  // history
  var histHead = el('<div class="section-head" style="margin-top:22px;"><div><h1 style="font-size:17px;">Histórico recente</h1></div></div>');
  wrap.appendChild(histHead);
  var histCard = el('<div class="card"></div>');
  if(state.movements.length===0){
    histCard.appendChild(el('<div class="empty" style="padding:24px 0;"><b>Sem movimentações</b>Os registros aparecem aqui assim que você começar a lançar.</div>'));
  }else{
    state.movements.slice(0,30).forEach(function(m){
      histCard.appendChild(el(
        '<div class="movrow">'+
          '<div class="movicon '+m.tipo+'">'+(m.tipo==='entrada'?'+':'–')+'</div>'+
          '<div class="movbody"><b>'+escapeHtml(m.produto)+'</b><span>#'+m.codigo+' · '+fmtDateTime(m.timestamp)+(m.obs?' · '+escapeHtml(m.obs):'')+'</span></div>'+
          '<div class="movqty '+m.tipo+'">'+(m.tipo==='entrada'?'+':'-')+m.quantidade+'</div>'+
        '</div>'
      ));
    });
  }
  wrap.appendChild(histCard);

  return wrap;
}

/* ----------------------- PRODUÇÃO (kanban arrastar-e-soltar) ----------------------- */
var _sortableInstances = [];

function renderProducao(){
  var wrap = el('<div></div>');
  var all = allItemsArray();

  var toProduce = all.filter(function(it){ return it.status !== 'ok' && !it.emProducao; });
  toProduce.sort(function(a,b){
    if(a.status!==b.status) return a.status==='critico' ? -1 : 1;
    return (b.min-b.estoqueAtual) - (a.min-a.estoqueAtual);
  });
  var inProduction = all.filter(function(it){ return it.emProducao; });
  inProduction.sort(function(a,b){ return a.produto.localeCompare(b.produto,'pt-BR'); });

  var days = periodDays();
  var doneOrders = state.orders.filter(function(o){ return o.status==='concluida' && withinPeriod(o.concluidoEm, days); });
  doneOrders.sort(function(a,b){ return new Date(b.concluidoEm) - new Date(a.concluidoEm); });

  var exportList = toProduce.concat(inProduction);

  wrap.appendChild(el(
    '<div class="section-head"><div><h1>Kanban de produção</h1><p>Arraste um item para "Em produção" e depois conclua para registrar a quantidade feita</p></div></div>'
  ));

  var toolbar = el(
    '<div class="toolbar">'+
      '<button class="btn btn-outline btn-sm" id="exp-pdf">Exportar pendências (PDF)</button>'+
      '<button class="btn btn-outline btn-sm" id="exp-xls">Exportar pendências (Excel)</button>'+
    '</div>'
  );
  wrap.appendChild(toolbar);
  toolbar.querySelector('#exp-pdf').addEventListener('click', function(){ exportProducaoPDF(exportList); });
  toolbar.querySelector('#exp-xls').addEventListener('click', function(){ exportProducaoXLS(exportList); });

  var board = el(
    '<div class="kanban3">'+
      '<div class="kcol">'+
        '<div class="kcol__head"><b><span class="dot" style="background:var(--pink)"></span>A produzir</b><span class="kcol__count">'+toProduce.length+'</span></div>'+
        '<div class="kdrop" id="kdrop-aproduzir" data-col="aproduzir"></div>'+
      '</div>'+
      '<div class="kcol">'+
        '<div class="kcol__head"><b><span class="dot" style="background:var(--cone)"></span>Em produção</b><span class="kcol__count">'+inProduction.length+'</span></div>'+
        '<div class="kdrop" id="kdrop-emproducao" data-col="emproducao"></div>'+
      '</div>'+
      '<div class="kcol kcol--done">'+
        '<div class="kcol__head"><b><span class="dot" style="background:var(--teal)"></span>Concluídas</b>'+
          '<select id="rel-periodo">'+
            '<option value="7"'+(days===7?' selected':'')+'>Últimos 7 dias</option>'+
            '<option value="30"'+(days===30?' selected':'')+'>Últimos 30 dias</option>'+
            '<option value="90"'+(days===90?' selected':'')+'>Últimos 90 dias</option>'+
            '<option value="0"'+(days===0?' selected':'')+'>Tudo</option>'+
          '</select>'+
        '</div>'+
        '<div class="kdrop" id="kdrop-concluidas"></div>'+
      '</div>'+
    '</div>'
  );
  wrap.appendChild(board);

  var colA = board.querySelector('#kdrop-aproduzir');
  var colB = board.querySelector('#kdrop-emproducao');
  var colC = board.querySelector('#kdrop-concluidas');

  if(toProduce.length===0){
    colA.appendChild(el('<div class="kempty">Nada pendente por aqui</div>'));
  } else {
    toProduce.forEach(function(it){ colA.appendChild(kanbanCard(it, 'aproduzir')); });
  }
  if(inProduction.length===0){
    colB.appendChild(el('<div class="kempty">Arraste um item da coluna ao lado quando começar a produzir</div>'));
  } else {
    inProduction.forEach(function(it){ colB.appendChild(kanbanCard(it, 'emproducao')); });
  }
  if(doneOrders.length===0){
    colC.appendChild(el('<div class="kempty">Nenhuma produção concluída neste período</div>'));
  } else {
    doneOrders.forEach(function(o){ colC.appendChild(doneCard(o)); });
  }

  board.querySelector('#rel-periodo').addEventListener('change', function(e){
    state.relPeriodo = parseInt(e.target.value,10);
    renderContent();
  });

  // wire up drag & drop (works with mouse and touch) — só entre "a produzir" e "em produção"
  _sortableInstances.forEach(function(s){ try{ s.destroy(); }catch(e){} });
  _sortableInstances = [];
  if(window.Sortable){
    [colA, colB].forEach(function(colEl){
      var inst = new window.Sortable(colEl, {
        group:'producao-kanban',
        animation:150,
        ghostClass:'sortable-ghost',
        dragClass:'sortable-drag',
        delay:60,
        delayOnTouchOnly:true,
        touchStartThreshold:4,
        onAdd:function(evt){
          var codigo = evt.item.getAttribute('data-cod');
          var destCol = evt.to.getAttribute('data-col');
          var itObj = allItemsArray().filter(function(x){ return x.codigo===codigo; })[0];
          if(!itObj) return;
          if(destCol === 'emproducao') startProductionOrder(itObj);
          else cancelProductionOrder(itObj);
        }
      });
      _sortableInstances.push(inst);
    });
  }

  // ------- relatório de produção (mesmo período da coluna "Concluídas") -------
  wrap.appendChild(renderRelatorioProducao(doneOrders));

  return wrap;
}

function kanbanCard(it, col){
  var deficit = Math.max(0, it.min - it.estoqueAtual);
  var actionHtml = col === 'aproduzir'
    ? '<button class="btn btn-ghost btn-sm" data-move="emproducao">Mover p/ Em produção →</button>'
    : '<button class="btn btn-primary btn-sm" data-conclude="1">✓ Concluir produção</button>'+
      '<button class="link-btn" data-move="aproduzir">← voltar para "A produzir"</button>';

  var card = el(
    '<div class="kcard" data-cod="'+it.codigo+'">'+
      '<div class="kcard__grip"><span></span><span></span><span></span><span></span></div>'+
      '<b class="kname">'+escapeHtml(it.produto)+'</b>'+
      '<div class="kmeta">'+
        '<span class="badge code">#'+it.codigo+'</span>'+
        '<span class="badge" style="background:var(--'+(it.status==='critico'?'crit':it.status==='baixo'?'pink':'teal')+'-tint);color:'+STATUS_COLOR[it.status]+';">'+STATUS_LABEL[it.status]+'</span>'+
      '</div>'+
      '<div class="knums">'+
        '<span>Atual <b>'+fmtInt(it.estoqueAtual)+'</b></span>'+
        '<span>Mín. <b>'+fmtInt(it.min)+'</b></span>'+
        '<span>Produzir <b>'+fmtInt(deficit)+'</b></span>'+
      '</div>'+
      (it.localizacao ? '<div class="pcard__loc"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.4" stroke="currentColor" stroke-width="1.8"/></svg>'+escapeHtml(it.localizacao)+'</div>' : '')+
      '<div class="kcard__actions">'+actionHtml+'</div>'+
    '</div>'
  );
  var moveBtn = card.querySelector('[data-move]');
  if(moveBtn){
    moveBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var dest = e.currentTarget.getAttribute('data-move');
      if(dest === 'emproducao') startProductionOrder(it); else cancelProductionOrder(it);
    });
  }
  var concludeBtn = card.querySelector('[data-conclude]');
  if(concludeBtn){
    concludeBtn.addEventListener('click', function(e){
      e.stopPropagation();
      openConcludeModal(it);
    });
  }
  card.addEventListener('click', function(e){
    if(e.target.closest('[data-move]') || e.target.closest('[data-conclude]')) return;
    openProductModal(it.codigo);
  });
  return card;
}

function doneCard(order){
  var card = el(
    '<div class="kcard">'+
      '<b class="kname">'+escapeHtml(order.produto)+'</b>'+
      '<div class="kmeta">'+
        '<span class="badge code">#'+order.codigo+'</span>'+
        '<span class="badge">'+escapeHtml(order.categoria||'')+'</span>'+
      '</div>'+
      '<div class="knums"><span>Produzido <b>'+fmtInt(order.quantidadeProduzida||0)+' un.</b></span></div>'+
      '<div class="kcard__done-meta">Concluído em '+fmtDateTime(order.concluidoEm)+'</div>'+
    '</div>'
  );
  return card;
}

function openConcludeModal(it){
  var root = qs('#modal-root');
  var deficit = Math.max(0, it.min - it.estoqueAtual);
  var backdrop = el('<div class="modal-backdrop"></div>');
  var modal = el(
    '<div class="modal">'+
      '<div class="modal__head">'+
        '<div><h2>Concluir produção</h2><p>'+escapeHtml(it.produto)+' · #'+it.codigo+'</p></div>'+
        '<button class="modal__close" id="cm-close">✕</button>'+
      '</div>'+
      '<div class="field">'+
        '<label>Quantidade produzida</label>'+
        '<input type="number" id="cm-qtd" min="0" step="1" value="'+deficit+'" inputmode="numeric">'+
      '</div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:6px 0 18px 0;font-size:13px;font-weight:600;color:var(--ink-soft);">'+
        '<input type="checkbox" id="cm-entrada" checked style="width:17px;height:17px;">'+
        'Registrar essa quantidade como entrada no estoque'+
      '</label>'+
      '<button class="btn btn-primary btn-block" id="cm-save">Concluir e salvar</button>'+
    '</div>'
  );
  backdrop.appendChild(modal);
  root.innerHTML=''; root.appendChild(backdrop);
  function close(){ root.innerHTML=''; }
  backdrop.addEventListener('click', function(e){ if(e.target===backdrop) close(); });
  modal.querySelector('#cm-close').addEventListener('click', close);
  modal.querySelector('#cm-save').addEventListener('click', function(){
    var qtd = parseInt(qs('#cm-qtd').value,10);
    if(isNaN(qtd) || qtd<0){ toast('Informe uma quantidade válida.'); return; }
    var registrar = qs('#cm-entrada').checked;
    close();
    concludeProductionOrder(it, qtd, registrar);
  });
}

function renderRelatorioProducao(doneOrders){
  var box = el('<div style="margin-top:22px;"></div>');
  box.appendChild(el('<div class="section-head"><div><h1 style="font-size:17px;">Relatório de produção</h1><p>Período: '+periodLabel(periodDays())+'</p></div></div>'));

  var totalQtd = doneOrders.reduce(function(s,o){ return s+(o.quantidadeProduzida||0); }, 0);
  var stats = el(
    '<div class="grid2" style="margin-bottom:14px;">'+
      '<div class="stat"><b>'+doneOrders.length+'</b><span>Ordens concluídas</span></div>'+
      '<div class="stat"><b>'+fmtInt(totalQtd)+'</b><span>Unidades produzidas</span></div>'+
    '</div>'
  );
  box.appendChild(stats);

  var toolbar = el(
    '<div class="toolbar">'+
      '<button class="btn btn-outline btn-sm" id="rel-pdf">Exportar relatório (PDF)</button>'+
      '<button class="btn btn-outline btn-sm" id="rel-xls">Exportar relatório (Excel)</button>'+
    '</div>'
  );
  box.appendChild(toolbar);

  var card = el('<div class="card"></div>');
  if(doneOrders.length===0){
    card.appendChild(el('<div style="text-align:center;color:var(--ink-soft);font-size:13px;padding:14px 0;">Nenhuma ordem concluída neste período ainda.</div>'));
  } else {
    var byProduct = {};
    doneOrders.forEach(function(o){
      var k = o.codigo;
      if(!byProduct[k]) byProduct[k] = { produto:o.produto, categoria:o.categoria, total:0, ordens:0 };
      byProduct[k].total += (o.quantidadeProduzida||0);
      byProduct[k].ordens += 1;
    });
    var arr = Object.keys(byProduct).map(function(k){ return Object.assign({codigo:k}, byProduct[k]); });
    arr.sort(function(a,b){ return b.total-a.total; });
    arr.forEach(function(r){
      card.appendChild(el(
        '<div class="rep-row"><span>'+escapeHtml(r.produto)+' <small style="color:var(--ink-soft);">('+r.ordens+' ordem'+(r.ordens>1?'s':'')+')</small></span><b>'+fmtInt(r.total)+' un.</b></div>'
      ));
    });
  }
  box.appendChild(card);

  toolbar.querySelector('#rel-pdf').addEventListener('click', function(){ exportRelatorioPDF(doneOrders); });
  toolbar.querySelector('#rel-xls').addEventListener('click', function(){ exportRelatorioXLS(doneOrders); });

  return box;
}

function periodLabel(days){
  if(!days || days<=0) return 'todo o histórico';
  if(days===7) return 'últimos 7 dias';
  return 'últimos '+days+' dias';
}

async function exportProducaoPDF(list){
  if(!window.jspdf){ toast('Exportação indisponível neste momento.'); return; }
  if(list.length===0){ toast('Não há itens para exportar.'); return; }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({unit:'pt', format:'a4'});
  var pageW = doc.internal.pageSize.getWidth();
  var marginX = 40;
  var y = 50;

  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.setTextColor(84,18,30);
  doc.text('Sorveteria São João — Lista de Produção', marginX, y);
  y += 18;
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.setTextColor(90,90,90);
  doc.text('Gerado em ' + fmtDateTime(nowIso()), marginX, y);
  y += 22;

  doc.setDrawColor(230,220,210);
  doc.line(marginX, y, pageW-marginX, y);
  y += 16;

  doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
  doc.setTextColor(40,25,18);
  var cols = [
    {t:'Código', x:marginX, w:45},
    {t:'Produto', x:marginX+45, w:225},
    {t:'Atual', x:marginX+275, w:55},
    {t:'Mínimo', x:marginX+335, w:55},
    {t:'Produzir', x:marginX+395, w:60},
    {t:'Status', x:marginX+455, w:60}
  ];
  cols.forEach(function(c){ doc.text(c.t, c.x, y); });
  y += 8;
  doc.setDrawColor(230,220,210);
  doc.line(marginX, y, pageW-marginX, y);
  y += 14;

  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  list.forEach(function(it){
    if(y > 780){ doc.addPage(); y = 50; }
    var deficit = Math.max(0, it.min - it.estoqueAtual);
    doc.setTextColor(40,25,18);
    doc.text(String(it.codigo), cols[0].x, y);
    doc.text(String(it.produto).substring(0,42), cols[1].x, y);
    doc.text(fmtInt(it.estoqueAtual), cols[2].x, y);
    doc.text(fmtInt(it.min), cols[3].x, y);
    doc.setFont('helvetica','bold');
    doc.text(fmtInt(deficit), cols[4].x, y);
    doc.setFont('helvetica','normal');
    var stColor = it.status==='critico' ? [90,18,30] : [190,60,110];
    doc.setTextColor(stColor[0],stColor[1],stColor[2]);
    doc.text(STATUS_LABEL[it.status], cols[5].x, y);
    y += 16;
  });

  var blob = doc.output('blob');
  var fname = 'producao_sao_joao_' + isoDateStamp() + '.pdf';
  offerDownload(fname, blob);
}

function exportProducaoXLS(list){
  if(!window.XLSX){ toast('Exportação indisponível neste momento.'); return; }
  if(list.length===0){ toast('Não há itens para exportar.'); return; }
  var rows = list.map(function(it){
    return {
      'Código': it.codigo,
      'Produto': it.produto,
      'Categoria': it.categoria,
      'Estoque Atual': it.estoqueAtual,
      'Estoque Mínimo': it.min,
      'Quantidade a Produzir': Math.max(0, it.min-it.estoqueAtual),
      'Status': STATUS_LABEL[it.status],
      'Localização': it.localizacao || ''
    };
  });
  var ws = window.XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:8},{wch:38},{wch:14},{wch:12},{wch:14},{wch:18},{wch:10},{wch:22}];
  var wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Producao');
  var out = window.XLSX.write(wb, {bookType:'xlsx', type:'array'});
  var blob = new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  var fname = 'producao_sao_joao_' + isoDateStamp() + '.xlsx';
  offerDownload(fname, blob);
}

function isoDateStamp(){
  var d = new Date();
  function p(n){ return (n<10?'0':'')+n; }
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate());
}

async function exportRelatorioPDF(doneOrders){
  if(!window.jspdf){ toast('Exportação indisponível neste momento.'); return; }
  if(doneOrders.length===0){ toast('Não há ordens concluídas nesse período.'); return; }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({unit:'pt', format:'a4'});
  var pageW = doc.internal.pageSize.getWidth();
  var marginX = 40;
  var y = 50;

  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.setTextColor(84,18,30);
  doc.text('Sorveteria São João — Relatório de Produção', marginX, y);
  y += 18;
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.setTextColor(90,90,90);
  doc.text('Período: '+periodLabel(periodDays())+' · Gerado em '+fmtDateTime(nowIso()), marginX, y);
  y += 20;

  var totalQtd = doneOrders.reduce(function(s,o){ return s+(o.quantidadeProduzida||0); }, 0);
  doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.setTextColor(15,110,116);
  doc.text(doneOrders.length + ' ordens concluídas  ·  ' + fmtInt(totalQtd) + ' unidades produzidas', marginX, y);
  y += 20;

  doc.setDrawColor(230,220,210);
  doc.line(marginX, y, pageW-marginX, y);
  y += 16;

  doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
  doc.setTextColor(40,25,18);
  var cols = [
    {t:'Código', x:marginX, w:45},
    {t:'Produto', x:marginX+45, w:230},
    {t:'Categoria', x:marginX+280, w:90},
    {t:'Produzido', x:marginX+375, w:65},
    {t:'Concluído em', x:marginX+445, w:80}
  ];
  cols.forEach(function(c){ doc.text(c.t, c.x, y); });
  y += 8;
  doc.line(marginX, y, pageW-marginX, y);
  y += 14;

  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  doneOrders.forEach(function(o){
    if(y > 780){ doc.addPage(); y = 50; }
    doc.setTextColor(40,25,18);
    doc.text(String(o.codigo), cols[0].x, y);
    doc.text(String(o.produto).substring(0,44), cols[1].x, y);
    doc.text(String(o.categoria||''), cols[2].x, y);
    doc.setFont('helvetica','bold');
    doc.text(fmtInt(o.quantidadeProduzida||0), cols[3].x, y);
    doc.setFont('helvetica','normal');
    doc.text(fmtDate(o.concluidoEm), cols[4].x, y);
    y += 16;
  });

  var blob = doc.output('blob');
  offerDownload('relatorio_producao_sao_joao_' + isoDateStamp() + '.pdf', blob);
}

function exportRelatorioXLS(doneOrders){
  if(!window.XLSX){ toast('Exportação indisponível neste momento.'); return; }
  if(doneOrders.length===0){ toast('Não há ordens concluídas nesse período.'); return; }
  var rows = doneOrders.map(function(o){
    return {
      'Código': o.codigo,
      'Produto': o.produto,
      'Categoria': o.categoria||'',
      'Quantidade Alvo': o.quantidadeAlvo||0,
      'Quantidade Produzida': o.quantidadeProduzida||0,
      'Iniciado em': fmtDateTime(o.criadoEm),
      'Concluído em': fmtDateTime(o.concluidoEm)
    };
  });
  var ws = window.XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:8},{wch:38},{wch:14},{wch:14},{wch:18},{wch:18},{wch:18}];
  var wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Producao concluida');
  var out = window.XLSX.write(wb, {bookType:'xlsx', type:'array'});
  var blob = new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  offerDownload('relatorio_producao_sao_joao_' + isoDateStamp() + '.xlsx', blob);
}

async function offerDownload(filename, blob){
  try{
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    toast('Arquivo baixado: ' + filename);
  }catch(e){ console.error(e); toast('Não foi possível exportar o arquivo.'); }
}

/* ----------------------- CONFIGURAÇÕES ----------------------- */
function renderConfig(){
  var wrap = el('<div></div>');
  wrap.appendChild(el(
    '<div class="section-head"><div><h1>Configurações</h1><p>Ajuste locais de estoque, parâmetros e produtos</p></div></div>'
  ));

  var tabs = el(
    '<div class="tabs2">'+
      '<button data-c="localizacao" class="'+(state.cfgTab==='localizacao'?'active':'')+'">Localização</button>'+
      '<button data-c="parametros" class="'+(state.cfgTab==='parametros'?'active':'')+'">Parâmetros</button>'+
      '<button data-c="produto" class="'+(state.cfgTab==='produto'?'active':'')+'">Novo produto</button>'+
    '</div>'
  );
  qsa('button', tabs).forEach(function(b){
    b.addEventListener('click', function(){ state.cfgTab = b.dataset.c; renderContent(); });
  });
  wrap.appendChild(tabs);

  if(state.cfgTab === 'localizacao') wrap.appendChild(renderCfgLocalizacao());
  else if(state.cfgTab === 'parametros') wrap.appendChild(renderCfgParametros());
  else wrap.appendChild(renderCfgNovoProduto());

  return wrap;
}

function renderCfgLocalizacao(){
  var wrap = el('<div></div>');
  var search = el(
    '<div class="searchbar">'+
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'+
      '<input type="text" placeholder="Buscar produto" id="cfg-search">'+
    '</div>'
  );
  wrap.appendChild(search);

  var card = el('<div class="card" style="padding:6px 16px;"></div>');
  var listBox = el('<div></div>');
  card.appendChild(listBox);
  wrap.appendChild(card);

  function draw(term){
    listBox.innerHTML='';
    var arr = allItemsArray().sort(function(a,b){ return a.produto.localeCompare(b.produto,'pt-BR'); });
    var s = norm(term);
    if(s){ arr = arr.filter(function(it){ return norm(it.produto).indexOf(s)>-1 || norm(it.codigo).indexOf(s)>-1; }); }
    arr = arr.slice(0,60);
    if(arr.length===0){
      listBox.appendChild(el('<div style="padding:20px 0;color:var(--ink-soft);font-size:13px;text-align:center;">Nenhum produto encontrado.</div>'));
      return;
    }
    arr.forEach(function(it){
      var row = el(
        '<div class="cfg-row">'+
          '<div class="cfg-row__main"><b>'+escapeHtml(it.produto)+'</b><small>#'+it.codigo+' · '+escapeHtml(it.categoria)+'</small></div>'+
          '<input type="text" value="'+escapeHtml(it.localizacao)+'" placeholder="Local" data-cod="'+it.codigo+'">'+
        '</div>'
      );
      row.querySelector('input').addEventListener('change', function(e){
        writeItemField(it.codigo, { localizacao: e.target.value });
      });
      listBox.appendChild(row);
    });
    if(arr.length===60){
      listBox.appendChild(el('<div style="padding:10px 0;color:var(--ink-soft);font-size:11.5px;text-align:center;">Mostrando os primeiros 60 · use a busca para refinar</div>'));
    }
  }
  draw('');
  search.querySelector('input').addEventListener('input', function(e){ draw(e.target.value); });

  return wrap;
}

function renderCfgParametros(){
  var wrap = el('<div></div>');
  var p = state.params;
  var card = el(
    '<div class="card">'+
      '<div class="field"><label>Lead time de reposição/produção (dias)</label><input type="number" id="p-lead" min="0" step="1" value="'+p.leadTimeDias+'"></div>'+
      '<div class="field"><label>Margem de segurança extra (%)</label><input type="number" id="p-margem" min="0" step="1" value="'+p.margemPct+'"></div>'+
      '<div class="field"><label>Dias considerados no ano</label><input type="number" id="p-dias" min="1" step="1" value="'+p.diasAno+'"></div>'+
      '<button class="btn btn-primary btn-block" id="p-save">Salvar parâmetros</button>'+
      '<div class="footnote">Fórmula: Estoque Mínimo = (Qtd. produzida no ano ÷ dias do ano) × lead time × (1 + margem). Alterar aqui recalcula o mínimo de todos os produtos automaticamente.</div>'+
    '</div>'
  );
  card.querySelector('#p-save').addEventListener('click', function(){
    var lead = parseFloat(qs('#p-lead').value) || 0;
    var margem = parseFloat(qs('#p-margem').value) || 0;
    var dias = parseFloat(qs('#p-dias').value) || 365;
    saveParams({leadTimeDias:lead, margemPct:margem, diasAno:dias});
  });
  wrap.appendChild(card);
  return wrap;
}

function renderCfgNovoProduto(){
  var wrap = el('<div></div>');
  var maxCod = 0;
  for(var k in state.items){ var n = parseInt(k,10); if(n>maxCod) maxCod = n; }
  var cats = Array.from(new Set(allItemsArray().map(function(it){ return it.categoria; }))).sort();

  var card = el(
    '<div class="card">'+
      '<div class="field"><label>Código</label><input type="number" id="np-cod" value="'+(maxCod+1)+'"></div>'+
      '<div class="field"><label>Nome do produto</label><input type="text" id="np-nome" placeholder="Ex.: POTE 1,5 LITROS PISTACHE"></div>'+
      '<div class="field"><label>Categoria</label><input type="text" id="np-cat" list="np-cat-list" placeholder="Ex.: POTE"><datalist id="np-cat-list">'+
        cats.map(function(c){ return '<option value="'+escapeHtml(c)+'">'; }).join('')+
      '</datalist></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>Qtd. produzida/ano (estimativa)</label><input type="number" id="np-qtdano" min="0" value="0"></div>'+
        '<div class="field"><label>Estoque atual</label><input type="number" id="np-atual" min="0" value="0"></div>'+
      '</div>'+
      '<div class="field"><label>Localização (opcional)</label><input type="text" id="np-loc" placeholder="Ex.: Câmara 1 · Prateleira A2"></div>'+
      '<button class="btn btn-primary btn-block" id="np-save">Adicionar produto</button>'+
    '</div>'
  );
  card.querySelector('#np-save').addEventListener('click', function(){
    var codigo = parseInt(qs('#np-cod').value,10);
    var nome = qs('#np-nome').value.trim();
    if(!codigo || !nome){ toast('Preencha código e nome do produto.'); return; }
    if(state.items[String(codigo)]){ toast('Já existe um produto com esse código.'); return; }
    addProduct({
      codigo: codigo,
      produto: nome,
      categoria: (qs('#np-cat').value || 'OUTROS').toUpperCase(),
      qtdAnual: parseFloat(qs('#np-qtdano').value)||0,
      estoqueAtual: parseFloat(qs('#np-atual').value)||0,
      localizacao: qs('#np-loc').value||''
    });
    state.cfgTab='localizacao';
    renderContent();
  });
  wrap.appendChild(card);
  return wrap;
}


/* ----------------------- primeira vez: banco vazio ----------------------- */
function renderSetup(){
  var w = el('<div class="card" style="max-width:520px;margin:24px auto;padding:22px;">'+
    '<h2 style="margin:0 0 6px;font-family:var(--font-display);color:var(--teal-deep);">Vamos começar!</h2>'+
    '<p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;line-height:1.5;">O banco de dados ainda está vazio. Escolha como carregar os produtos (só precisa fazer isso uma vez):</p>'+
    '<button class="btn btn-primary" id="setup-seed" style="width:100%;margin-bottom:10px;">Carregar a lista de produtos (estoque zerado)</button>'+
    '<button class="btn" id="setup-import" style="width:100%;">Importar do app antigo (arquivo data.json)</button>'+
    '<input type="file" id="setup-file" accept=".json,application/json" class="hidden">'+
    '<p id="setup-msg" style="margin:12px 0 0;font-size:13px;color:var(--ink-soft);"></p>'+
  '</div>');
  var msg = qs('#setup-msg', w);
  function progress(done, total){ msg.textContent = 'Gravando… ' + done + ' de ' + total; }
  async function run(data){
    qsa('button', w).forEach(function(b){ b.disabled = true; });
    try{
      await FB.importData(data, progress);
      msg.textContent = 'Pronto! Carregando…';
    }catch(e){
      console.error(e);
      msg.textContent = 'Não deu certo: ' + friendlyError(e);
      qsa('button', w).forEach(function(b){ b.disabled = false; });
    }
  }
  qs('#setup-seed', w).addEventListener('click', async function(){
    try{
      var res = await fetch('seed_products.json', { cache:'no-store' });
      var arr = await res.json();
      var items = {};
      arr.forEach(function(p){
        items[String(p[0])] = { produto:p[1], categoria:p[2], qtdAnual:p[3], estoqueAtual:0, localizacao:'', emProducao:false, ordemAtualId:null };
      });
      await run({ items: items, params: DEFAULT_PARAMS });
    }catch(e){ console.error(e); msg.textContent = 'Não consegui ler a lista de produtos.'; }
  });
  qs('#setup-import', w).addEventListener('click', function(){ qs('#setup-file', w).click(); });
  qs('#setup-file', w).addEventListener('change', function(ev){
    var f = ev.target.files && ev.target.files[0];
    if(!f) return;
    var rd = new FileReader();
    rd.onload = function(){
      try{
        var d = JSON.parse(rd.result);
        if(!d || !d.items || !Object.keys(d.items).length) throw new Error('arquivo sem produtos');
        run(d);
      }catch(e){ msg.textContent = 'Esse arquivo não parece ser o data.json do app antigo.'; }
    };
    rd.readAsText(f);
  });
  return w;
}

/* ----------------------- boot ----------------------- */
function bindNav(){
  qsa('.navbtn').forEach(function(b){
    b.addEventListener('click', function(){ setTab(b.dataset.tab); });
  });
  qsa('.navbtn[data-tab="painel"]').forEach(function(b){ b.classList.add('active'); });
}

document.addEventListener('DOMContentLoaded', function(){
  initApp();
});

})();
