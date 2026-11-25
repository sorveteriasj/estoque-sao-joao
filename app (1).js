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
  prodFamily:null,      // família aberta no kanban (null = tela de escolha, '*' = todas)
  gest:{ periodo:'hoje', de:'', ate:'', fam:'*' },
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
function toast(msg, ms){
  var t = qs('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(function(){ t.classList.remove('show'); }, ms || 2400);
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
      familia: familyOf(it.produto, it.categoria),
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
  var at = famAtrasadas();
  if(at.length){ toast('⚠ Há famílias para verificar em Produção.', 5000); }
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
    markVerified(familyOf(it.produto, it.categoria), true);
    toast('Produção de "'+it.produto+'" disparada.');
  }catch(e){ console.error(e); toast('Erro ao iniciar produção: ' + friendlyError(e)); }
}

async function cancelProductionOrder(it){
  var orderId = it.ordemAtualId;
  if(!orderId) return;
  try{
    await FB.cancelOrder(orderId);
    markVerified(familyOf(it.produto, it.categoria), true);
    toast('Produção de "'+it.produto+'" cancelada.');
  }catch(e){ console.error(e); toast('Erro ao cancelar: ' + friendlyError(e)); }
}

async function concludeProductionOrder(it, quantidade, registrarEntrada){
  var orderId = it.ordemAtualId;
  if(!orderId){ toast('Essa ordem não foi encontrada.'); return; }
  try{
    await FB.concludeOrder(orderId, quantidade, !!registrarEntrada);
    markVerified(familyOf(it.produto, it.categoria), true);
    toast('Produção de "'+it.produto+'" concluída: '+fmtInt(quantidade)+' un.');
  }catch(e){ console.error(e); toast('Erro ao concluir: ' + friendlyError(e)); }
}

function renderCurrentTab(){ if(state.ready) renderContent(); }

function setTab(tab){
  state.tab = tab;
  if(tab === 'producao') state.prodFamily = null;
  qsa('.navbtn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === tab); });
  var sub = {
    painel:'Painel de controle', mov:'Entradas e saídas', producao:'Lista de produção', gestao:'Gerenciamento diário', config:'Configurações'
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
  else if(state.tab === 'gestao') c.appendChild(renderGestao());
  else if(state.tab === 'config') c.appendChild(renderConfig());
  updateBadges();
}

/* ----------------------- PAINEL (Kanban) ----------------------- */
function renderPainel(){
  var wrap = el('<div></div>');
  var all = allItemsArray();
  var counts = { critico:0, baixo:0, ok:0 };
  all.forEach(function(it){ counts[it.status]++; });

  var _al = alertaFamilias(); if(_al) wrap.appendChild(_al);
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

  var chips = el('<div class="chiprow" style="flex-wrap:wrap;overflow:visible"></div>');
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
  if(state.prodFamily === null) return renderFamilias();
  var wrap = el('<div></div>');
  var famSel = state.prodFamily;
  var all = allItemsArray().filter(function(it){ return famSel === '*' || it.familia === famSel; });

  var toProduce = all.filter(function(it){ return it.status !== 'ok' && !it.emProducao; });
  toProduce.sort(function(a,b){
    if(a.status!==b.status) return a.status==='critico' ? -1 : 1;
    return (b.min-b.estoqueAtual) - (a.min-a.estoqueAtual);
  });
  var inProduction = all.filter(function(it){ return it.emProducao; });
  inProduction.sort(function(a,b){ return a.produto.localeCompare(b.produto,'pt-BR'); });

  var days = periodDays();
  var doneOrders = state.orders.filter(function(o){ return o.status==='concluida' && withinPeriod(o.concluidoEm, days) && (famSel === '*' || familyOf(o.produto, o.categoria) === famSel); });
  doneOrders.sort(function(a,b){ return new Date(b.concluidoEm) - new Date(a.concluidoEm); });

  var exportList = toProduce.concat(inProduction);

  wrap.appendChild(famHeader());

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

/* ----------------------- FAMÍLIAS DE PRODUTOS ----------------------- */
// Família = como os produtos já são escritos: "CAIXA 10 LITROS", "POTE 1,5 LITROS", "PICOLE"...
var FAM_DIRETAS = { PICOLE:1, EXTRUSADO:1, PALETA:1 };
var FAM_SIZE_RE = /^(.*?\b\d+(?:[,.]\d+)?\s*(?:LITROS?|LTS?|L|ML)\b)/;
var FAM_LIMITE_HORAS = 48;   // "mais de 2 dias" sem verificar = alerta

function stdText(s){ return String(s||'').toUpperCase().replace(/\s+/g,' ').trim(); }
function famFirstWord(nome){ return stdText(nome).split(' ')[0] || ''; }
function familyOf(produto, categoria){
  var nome = stdText(produto);
  var cat = stdText(categoria) || famFirstWord(nome);
  if(cat === 'CAIXA' || cat === 'POTE'){
    var m = FAM_SIZE_RE.exec(nome);
    if(m) return m[1].replace(/(\d)\s*ML$/, '$1 ML');
    return cat;
  }
  if(FAM_DIRETAS[cat]) return cat;
  return 'OUTROS';
}
function famSlug(f){ return norm(f).replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
function dayStart(d){ var x = new Date(d); x.setHours(0,0,0,0); return x; }

function familiesInfo(){
  var map = {};
  var verif = (state.params && state.params.verificacoes) || {};
  allItemsArray().forEach(function(it){
    var f = it.familia;
    var o = map[f] || (map[f] = { nome:f, slug:famSlug(f), itens:0, aProduzir:0, emProducao:0, criticos:0, baixos:0, ok:0 });
    o.itens++;
    if(it.status === 'critico') o.criticos++; else if(it.status === 'baixo') o.baixos++; else o.ok++;
    if(it.emProducao) o.emProducao++; else if(it.status !== 'ok') o.aProduzir++;
  });
  var now = Date.now();
  return Object.keys(map).map(function(k){
    var o = map[k];
    o.ultima = verif[o.slug] || null;
    o.horas = o.ultima ? (now - new Date(o.ultima).getTime())/3600000 : null;
    o.atrasada = (o.horas === null) || o.horas > FAM_LIMITE_HORAS;
    return o;
  }).sort(function(a,b){
    if(a.nome==='OUTROS') return 1; if(b.nome==='OUTROS') return -1;
    return a.nome.localeCompare(b.nome,'pt-BR',{numeric:true});
  });
}
function verifTexto(o){
  if(!o.ultima) return '⚠ Nunca verificada';
  if(o.atrasada) return '⚠ Não verificada há ' + Math.floor(o.horas/24) + ' dias';
  var d = new Date(o.ultima);
  var dd = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  var hh = d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  return '✓ Verificada ' + (dd <= 0 ? 'hoje às ' + hh : dd === 1 ? 'ontem às ' + hh : 'há ' + dd + ' dias');
}
function famAtrasadas(){ return familiesInfo().filter(function(f){ return f.atrasada && f.itens > 0; }); }

function markVerified(famNome, silent){
  var slug = famSlug(famNome), iso = nowIso();
  var v = Object.assign({}, (state.params && state.params.verificacoes) || {});
  v[slug] = iso;
  state.params.verificacoes = v;
  var patch = { verificacoes:{} }; patch.verificacoes[slug] = iso;
  FB.saveParams(patch).catch(function(e){
    console.error(e);
    if(!silent) toast('Não deu para salvar a verificação: ' + friendlyError(e));
  });
  updateBadges();
  if(!silent){ toast('Família "' + famNome + '" marcada como verificada.'); renderCurrentTab(); }
}
function familyOfCodigo(codigo){
  var it = state.items[codigo];
  return it ? familyOf(it.produto, it.categoria) : null;
}

function updateBadges(){
  var n = state.ready ? famAtrasadas().length : 0;
  qsa('.navbtn[data-tab="producao"]').forEach(function(b){
    var d = b.querySelector('.navdot');
    if(!d){ d = document.createElement('i'); d.className = 'navdot'; b.appendChild(d); }
    d.classList.toggle('hidden', n === 0);
    d.title = n + ' família(s) sem verificação há mais de 2 dias';
  });
}

function alertaFamilias(){
  var at = famAtrasadas();
  if(!at.length) return null;
  var box = el('<div class="alertbar"><div><b>⚠ Há famílias para verificar</b></div><button class="btn btn-sm alertbar__btn" type="button">Ver</button></div>');
  box.querySelector('button').addEventListener('click', function(){ setTab('producao'); });
  return box;
}

/* ----------------------- PRODUÇÃO: escolher a família ----------------------- */
function renderFamilias(){
  var wrap = el('<div></div>');
  wrap.appendChild(el('<div class="section-head"><div><h1>Produção</h1><p>Escolha a família de produtos para abrir o kanban</p></div></div>'));
  var fams = familiesInfo();
  var at = fams.filter(function(f){ return f.atrasada; });
  if(at.length){ wrap.appendChild(el('<div class="alertbar"><div><b>⚠ Há famílias para verificar</b></div></div>')); }
  var ordem = fams.slice().sort(function(a,b){
    if(a.atrasada !== b.atrasada) return a.atrasada ? -1 : 1;
    if(a.criticos !== b.criticos) return b.criticos - a.criticos;
    return a.nome.localeCompare(b.nome,'pt-BR',{numeric:true});
  });
  var grid = el('<div class="famgrid"></div>');
  var tot = fams.reduce(function(s,f){ s.a += f.aProduzir; s.e += f.emProducao; s.c += f.criticos; return s; }, {a:0,e:0,c:0});
  var todas = el(
    '<button class="famcard famcard--all" type="button" data-fam="*">' +
      '<b class="famcard__name">Todas as famílias</b>' +
      '<div class="famcard__nums"><span><b>' + tot.a + '</b> a produzir</span><span><b>' + tot.e + '</b> em produção</span></div>' +
      '<div class="famcard__verif">Visão geral de todos os itens</div>' +
    '</button>'
  );
  grid.appendChild(todas);
  ordem.forEach(function(f){
    var c = el(
      '<button class="famcard' + (f.atrasada ? ' famcard--late' : '') + '" type="button" data-fam="' + escapeHtml(f.nome) + '">' +
        '<b class="famcard__name">' + escapeHtml(f.nome) + '</b>' +
        '<div class="famcard__nums">' +
          '<span><b>' + f.aProduzir + '</b> a produzir</span>' +
          '<span><b>' + f.emProducao + '</b> em produção</span>' +
          (f.criticos ? '<span class="famcard__crit"><b>' + f.criticos + '</b> crítico' + (f.criticos > 1 ? 's' : '') + '</span>' : '') +
        '</div>' +
        '<div class="famcard__verif">' + verifTexto(f) + '</div>' +
      '</button>'
    );
    grid.appendChild(c);
  });
  qsa('.famcard', grid).forEach(function(b){
    b.addEventListener('click', function(){ state.prodFamily = b.dataset.fam; renderContent(); window.scrollTo(0,0); });
  });
  wrap.appendChild(grid);
  return wrap;
}

function famHeader(){
  var fam = state.prodFamily;
  var box = el('<div class="famhead"></div>');
  var top = el('<div class="famhead__top"><button class="btn btn-outline btn-sm" id="fam-back" type="button">← Famílias</button></div>');
  top.querySelector('#fam-back').addEventListener('click', function(){ state.prodFamily = null; renderContent(); window.scrollTo(0,0); });
  box.appendChild(top);
  box.appendChild(el('<div class="section-head"><div><h1>Kanban' + (fam === '*' ? ' · todas as famílias' : ' · ' + escapeHtml(fam)) + '</h1><p>Arraste um item para "Em produção" e depois conclua para registrar a quantidade feita</p></div></div>'));
  if(fam !== '*'){
    var info = familiesInfo().filter(function(f){ return f.nome === fam; })[0];
    if(info){
      var v = el(
        '<div class="verif ' + (info.atrasada ? 'verif--late' : 'verif--ok') + '">' +
          '<span>' + verifTexto(info) + '</span>' +
          '<button class="btn btn-primary btn-sm" id="fam-verif" type="button">✓ Marcar como verificada agora</button>' +
        '</div>'
      );
      v.querySelector('#fam-verif').addEventListener('click', function(){ markVerified(fam, false); });
      box.appendChild(v);
    }
  }
  return box;
}

/* ----------------------- GERENCIAMENTO DIÁRIO ----------------------- */
function dayKey(d){
  var x = new Date(d);
  return x.getFullYear() + '-' + ('0'+(x.getMonth()+1)).slice(-2) + '-' + ('0'+x.getDate()).slice(-2);
}
function gestRange(){
  var g = state.gest, today = dayStart(new Date()), s, e;
  var addDays = function(d,n){ var x = new Date(d); x.setDate(x.getDate()+n); return x; };
  if(g.periodo === 'hoje'){ s = today; e = addDays(today,1); }
  else if(g.periodo === 'ontem'){ s = addDays(today,-1); e = today; }
  else if(g.periodo === '7'){ s = addDays(today,-6); e = addDays(today,1); }
  else if(g.periodo === '30'){ s = addDays(today,-29); e = addDays(today,1); }
  else {
    s = g.de ? new Date(g.de + 'T00:00:00') : today;
    var ate = g.ate ? new Date(g.ate + 'T00:00:00') : s;
    e = addDays(ate,1);
    if(e <= s) e = addDays(s,1);
  }
  return { s:s, e:e };
}
function gestPeriodoTexto(R){
  var fim = new Date(R.e.getTime() - 1);
  if(dayKey(R.s) === dayKey(fim)) return R.s.toLocaleDateString('pt-BR');
  return R.s.toLocaleDateString('pt-BR') + ' a ' + fim.toLocaleDateString('pt-BR');
}
function fmtDur(h){
  if(h < 1) return Math.max(1, Math.round(h*60)) + ' min';
  if(h < 48) return (Math.round(h*10)/10).toLocaleString('pt-BR') + ' h';
  return (Math.round(h/24*10)/10).toLocaleString('pt-BR') + ' dias';
}
function sumBy(arr, fn){ return arr.reduce(function(s,x){ return s + (fn(x)||0); }, 0); }

function gestData(){
  var g = state.gest, R = gestRange();
  var t0 = R.s.getTime(), t1 = R.e.getTime();
  function inR(iso){ if(!iso) return false; var t = new Date(iso).getTime(); return t >= t0 && t < t1; }
  function famMov(m){ var it = state.items[m.codigo]; return familyOf(m.produto, it ? it.categoria : ''); }
  function famOk(n){ return g.fam === '*' || n === g.fam; }

  var doneAll = state.orders.filter(function(o){ return o.status === 'concluida' && inR(o.concluidoEm); });
  var done = doneAll.filter(function(o){ return famOk(familyOf(o.produto, o.categoria)); });
  var created = state.orders.filter(function(o){ return inR(o.criadoEm) && famOk(familyOf(o.produto, o.categoria)); });
  var movs = state.movements.filter(function(m){ return inR(m.timestamp) && famOk(famMov(m)); });

  var prodTotal = sumBy(done, function(o){ return o.quantidadeProduzida; });
  var comAlvo = done.filter(function(o){ return (o.quantidadeAlvo||0) > 0; });
  var cumpr = comAlvo.length ? sumBy(comAlvo, function(o){ return o.quantidadeProduzida; }) / sumBy(comAlvo, function(o){ return o.quantidadeAlvo; }) * 100 : null;
  var tempos = done.map(function(o){ return (new Date(o.concluidoEm) - new Date(o.criadoEm))/3600000; }).filter(function(h){ return h >= 0 && isFinite(h); });
  var tempoMedio = tempos.length ? sumBy(tempos, function(h){ return h; }) / tempos.length : null;
  var entradas = sumBy(movs.filter(function(m){ return m.tipo === 'entrada'; }), function(m){ return m.quantidade; });
  var saidas = sumBy(movs.filter(function(m){ return m.tipo === 'saida'; }), function(m){ return m.quantidade; });

  var itens = allItemsArray().filter(function(it){ return famOk(it.familia); });
  var criticosAgora = itens.filter(function(i){ return i.status === 'critico'; }).length;
  var baixosAgora = itens.filter(function(i){ return i.status === 'baixo'; }).length;
  var emProdAgora = itens.filter(function(i){ return i.emProducao; }).length;

  var dias = [], idx = {};
  for(var d = new Date(R.s); d < R.e && dias.length < 92; d.setDate(d.getDate()+1)){
    var k = dayKey(d); var o = { k:k, d:new Date(d), prod:0, ordens:0, ent:0, sai:0 };
    dias.push(o); idx[k] = o;
  }
  done.forEach(function(o){ var r = idx[dayKey(o.concluidoEm)]; if(r){ r.prod += (o.quantidadeProduzida||0); r.ordens++; } });
  movs.forEach(function(m){ var r = idx[dayKey(m.timestamp)]; if(r){ if(m.tipo === 'entrada') r.ent += m.quantidade; else r.sai += m.quantidade; } });

  var porFam = {};
  doneAll.forEach(function(o){
    var f = familyOf(o.produto, o.categoria);
    var r = porFam[f] || (porFam[f] = { prod:0, ordens:0 });
    r.prod += (o.quantidadeProduzida||0); r.ordens++;
  });
  var porProd = {};
  done.forEach(function(o){
    var r = porProd[o.codigo] || (porProd[o.codigo] = { produto:o.produto, prod:0, ordens:0 });
    r.prod += (o.quantidadeProduzida||0); r.ordens++;
  });
  var top = Object.keys(porProd).map(function(k){ return porProd[k]; }).sort(function(a,b){ return b.prod - a.prod; }).slice(0,8);

  return { R:R, done:done, created:created, movs:movs, prodTotal:prodTotal, cumpr:cumpr, tempoMedio:tempoMedio,
           entradas:entradas, saidas:saidas, criticosAgora:criticosAgora, baixosAgora:baixosAgora, emProdAgora:emProdAgora,
           dias:dias, porFam:porFam, top:top };
}

function renderGestao(){
  var g = state.gest;
  var D = gestData();
  var fams = familiesInfo();
  var wrap = el('<div></div>');
  wrap.appendChild(el('<div class="section-head"><div><h1>Gerenciamento diário</h1><p>O que foi feito, dia a dia e por família · ' + gestPeriodoTexto(D.R) + '</p></div></div>'));

  // filtros
  var chips = el('<div class="chiprow"></div>');
  [['hoje','Hoje'],['ontem','Ontem'],['7','Últimos 7 dias'],['30','Últimos 30 dias'],['custom','Personalizado']].forEach(function(p){
    var c = el('<button class="chip gchip' + (g.periodo === p[0] ? ' active' : '') + '" type="button" data-p="' + p[0] + '">' + p[1] + '</button>');
    c.addEventListener('click', function(){ g.periodo = p[0]; renderContent(); });
    chips.appendChild(c);
  });
  wrap.appendChild(chips);
  var bar = el('<div class="gest-filtros"></div>');
  var sel = el('<label class="gfield"><span>Família</span><select id="g-fam"><option value="*">Todas as famílias</option>' +
    fams.map(function(f){ return '<option value="' + escapeHtml(f.nome) + '"' + (g.fam === f.nome ? ' selected' : '') + '>' + escapeHtml(f.nome) + '</option>'; }).join('') + '</select></label>');
  sel.querySelector('select').addEventListener('change', function(e){ g.fam = e.target.value; renderContent(); });
  bar.appendChild(sel);
  if(g.periodo === 'custom'){
    var de = el('<label class="gfield"><span>De</span><input type="date" id="g-de" value="' + (g.de || dayKey(D.R.s)) + '"></label>');
    var ate = el('<label class="gfield"><span>Até</span><input type="date" id="g-ate" value="' + (g.ate || dayKey(new Date(D.R.e.getTime()-1))) + '"></label>');
    de.querySelector('input').addEventListener('change', function(e){ g.de = e.target.value; if(!g.ate) g.ate = e.target.value; renderContent(); });
    ate.querySelector('input').addEventListener('change', function(e){ g.ate = e.target.value; if(!g.de) g.de = e.target.value; renderContent(); });
    bar.appendChild(de); bar.appendChild(ate);
  }
  var exp = el('<button class="btn btn-outline btn-sm" id="g-xls" type="button">Exportar Excel</button>');
  exp.addEventListener('click', function(){ exportGestaoXLS(D); });
  bar.appendChild(exp);
  wrap.appendChild(bar);

  // indicadores
  function kpi(valor, rotulo, sub, cls){
    return '<div class="gk ' + (cls||'') + '"><b>' + valor + '</b><span>' + rotulo + '</span>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }
  var kp = el('<div class="gk-grid">' +
    kpi(fmtInt(D.prodTotal), 'Unidades produzidas', D.done.length + (D.done.length === 1 ? ' ordem concluída' : ' ordens concluídas'), 'gk--main') +
    kpi(D.created.length, 'Ordens disparadas', 'no período') +
    kpi(D.cumpr === null ? '—' : Math.round(D.cumpr) + '%', 'Cumprimento do planejado', 'produzido ÷ quantidade sugerida') +
    kpi(D.tempoMedio === null ? '—' : fmtDur(D.tempoMedio), 'Tempo médio por ordem', 'do disparo à conclusão') +
    kpi(fmtInt(D.entradas), 'Entradas no estoque', 'unidades no período') +
    kpi(fmtInt(D.saidas), 'Saídas do estoque', 'unidades no período') +
    kpi(D.criticosAgora, 'Itens críticos agora', D.baixosAgora + ' baixos', D.criticosAgora ? 'gk--crit' : '') +
    kpi(D.emProdAgora, 'Em produção agora', 'neste momento') +
  '</div>');
  wrap.appendChild(kp);

  // gráfico por dia
  if(D.dias.length > 1){
    var max = Math.max.apply(null, D.dias.map(function(x){ return x.prod; }).concat([1]));
    var passo = D.dias.length > 16 ? Math.ceil(D.dias.length / 12) : 1;
    var bars = D.dias.map(function(x, i){
      var h = Math.round(x.prod / max * 100);
      var rot = (i % passo === 0) ? ('0'+x.d.getDate()).slice(-2) + '/' + ('0'+(x.d.getMonth()+1)).slice(-2) : '';
      return '<div class="gbar" title="' + x.d.toLocaleDateString('pt-BR') + ': ' + fmtInt(x.prod) + ' un. em ' + x.ordens + ' ordem(ns)">' +
               '<em>' + (x.prod ? fmtInt(x.prod) : '') + '</em><div class="gbar__col"><i style="height:' + Math.max(h, x.prod ? 4 : 0) + '%"></i></div><span>' + rot + '</span></div>';
    }).join('');
    wrap.appendChild(el('<div class="card gest-card"><h3>Produção por dia (unidades)</h3><div class="gbars">' + bars + '</div></div>'));
  }

  // por família
  var linhas = fams.map(function(f){
    var r = D.porFam[f.nome] || { prod:0, ordens:0 };
    return { f:f, prod:r.prod, ordens:r.ordens };
  }).sort(function(a,b){ return b.prod - a.prod || a.f.nome.localeCompare(b.f.nome,'pt-BR',{numeric:true}); });
  var maxF = Math.max.apply(null, linhas.map(function(x){ return x.prod; }).concat([1]));
  var totF = sumBy(linhas, function(x){ return x.prod; });
  var tb = linhas.map(function(x){
    var f = x.f, p = f.itens ? 100 / f.itens : 0;
    return '<tr class="' + (g.fam === f.nome ? 'sel' : '') + '" data-fam="' + escapeHtml(f.nome) + '">' +
      '<td class="gfam"><b>' + escapeHtml(f.nome) + '</b><div class="gmini"><i style="width:' + Math.round(x.prod / maxF * 100) + '%"></i></div></td>' +
      '<td class="num"><b>' + fmtInt(x.prod) + '</b><small>' + (totF ? Math.round(x.prod / totF * 100) : 0) + '%</small></td>' +
      '<td class="num">' + x.ordens + '</td>' +
      '<td class="gstk"><div class="stk" title="' + f.criticos + ' críticos, ' + f.baixos + ' baixos, ' + f.ok + ' em dia">' +
        '<i style="width:' + f.criticos * p + '%;background:var(--crit)"></i><i style="width:' + f.baixos * p + '%;background:var(--pink)"></i><i style="width:' + f.ok * p + '%;background:var(--teal)"></i></div>' +
        '<small>' + f.criticos + ' crít. · ' + f.baixos + ' baixos</small></td>' +
      '<td class="gv ' + (f.atrasada ? 'late' : '') + '">' + verifTexto(f).replace('Não verificada há', 'Sem verificar há') + '</td></tr>';
  }).join('');
  var fc = el('<div class="card gest-card"><h3>Por família <small>(toque numa linha para filtrar)</small></h3>' +
    '<div class="gscroll"><table class="gtab"><thead><tr><th>Família</th><th class="num">Produzido</th><th class="num">Ordens</th><th>Situação do estoque</th><th>Verificação</th></tr></thead><tbody>' + tb + '</tbody></table></div></div>');
  qsa('tbody tr', fc).forEach(function(tr){
    tr.addEventListener('click', function(){ g.fam = (g.fam === tr.dataset.fam) ? '*' : tr.dataset.fam; renderContent(); });
  });
  wrap.appendChild(fc);

  // top produtos
  if(D.top.length){
    var mx = D.top[0].prod || 1;
    wrap.appendChild(el('<div class="card gest-card"><h3>Produtos mais produzidos</h3>' + D.top.map(function(t){
      return '<div class="gtop"><span>' + escapeHtml(t.produto) + ' <small>(' + t.ordens + ' ordem' + (t.ordens > 1 ? 's' : '') + ')</small></span><b>' + fmtInt(t.prod) + '</b>' +
             '<div class="gmini"><i style="width:' + Math.round(t.prod / mx * 100) + '%"></i></div></div>';
    }).join('') + '</div>'));
  }

  // dia a dia
  if(D.dias.length > 1){
    var rows = D.dias.slice().reverse().map(function(x){
      return '<tr><td>' + x.d.toLocaleDateString('pt-BR',{weekday:'short', day:'2-digit', month:'2-digit'}) + '</td><td class="num">' + x.ordens + '</td><td class="num"><b>' + fmtInt(x.prod) + '</b></td><td class="num">' + fmtInt(x.ent) + '</td><td class="num">' + fmtInt(x.sai) + '</td></tr>';
    }).join('');
    wrap.appendChild(el('<div class="card gest-card"><h3>Dia a dia</h3><div class="gscroll"><table class="gtab"><thead><tr><th>Dia</th><th class="num">Ordens</th><th class="num">Produzido</th><th class="num">Entradas</th><th class="num">Saídas</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'));
  }

  // ordens concluídas
  var lista = D.done.slice().sort(function(a,b){ return new Date(b.concluidoEm) - new Date(a.concluidoEm); }).slice(0, 40);
  wrap.appendChild(el('<div class="card gest-card"><h3>O que foi concluído' + (D.done.length > 40 ? ' <small>(40 mais recentes)</small>' : '') + '</h3>' +
    (lista.length ? lista.map(function(o){
      return '<div class="gfeed"><div><b>' + escapeHtml(o.produto) + '</b><small>' + escapeHtml(familyOf(o.produto, o.categoria)) + ' · ' + fmtDateTime(o.concluidoEm) + '</small></div>' +
             '<span>' + fmtInt(o.quantidadeProduzida||0) + ' un.' + ((o.quantidadeAlvo||0) > 0 ? '<small>de ' + fmtInt(o.quantidadeAlvo) + '</small>' : '') + '</span></div>';
    }).join('') : '<div class="kempty">Nenhuma produção concluída neste período.</div>') + '</div>'));
  return wrap;
}

function exportGestaoXLS(D){
  if(!window.XLSX){ toast('Exportação indisponível neste momento.'); return; }
  var X = window.XLSX, wb = X.utils.book_new();
  var g = state.gest;
  var resumo = [
    ['Gerenciamento diário · Sorveteria São João'],
    ['Período', gestPeriodoTexto(D.R)],
    ['Família', g.fam === '*' ? 'Todas' : g.fam],
    [],
    ['Unidades produzidas', D.prodTotal],
    ['Ordens concluídas', D.done.length],
    ['Ordens disparadas', D.created.length],
    ['Cumprimento do planejado (%)', D.cumpr === null ? '' : Math.round(D.cumpr)],
    ['Tempo médio por ordem (h)', D.tempoMedio === null ? '' : Math.round(D.tempoMedio*10)/10],
    ['Entradas no estoque (un.)', D.entradas],
    ['Saídas do estoque (un.)', D.saidas],
    ['Itens críticos agora', D.criticosAgora],
    ['Em produção agora', D.emProdAgora]
  ];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(resumo), 'Resumo');
  var dia = [['Dia','Ordens concluídas','Unidades produzidas','Entradas','Saídas']].concat(D.dias.map(function(x){
    return [x.d.toLocaleDateString('pt-BR'), x.ordens, x.prod, x.ent, x.sai];
  }));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(dia), 'Por dia');
  var fam = [['Família','Unidades produzidas','Ordens concluídas','Itens críticos','Itens baixos','Em produção','Verificação']].concat(familiesInfo().map(function(f){
    var r = D.porFam[f.nome] || { prod:0, ordens:0 };
    return [f.nome, r.prod, r.ordens, f.criticos, f.baixos, f.emProducao, verifTexto(f)];
  }));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(fam), 'Por família');
  var ord = [['Código','Produto','Família','Quantidade sugerida','Quantidade produzida','Disparada em','Concluída em']].concat(D.done.map(function(o){
    return [o.codigo, o.produto, familyOf(o.produto, o.categoria), o.quantidadeAlvo||0, o.quantidadeProduzida||0, fmtDateTime(o.criadoEm), fmtDateTime(o.concluidoEm)];
  }));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(ord), 'Ordens concluídas');
  var out = X.write(wb, {bookType:'xlsx', type:'array'});
  offerDownload('gerenciamento_diario_' + isoDateStamp() + '.xlsx', new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}

/* ----------------------- NOVO PRODUTO (nome no padrão dos cadastrados) ----------------------- */
function renderCfgNovoProduto(){
  var wrap = el('<div></div>');
  var maxCod = 0;
  for(var k in state.items){ var n = parseInt(k,10); if(n > maxCod) maxCod = n; }
  var fams = familiesInfo().map(function(f){ return f.nome; }).filter(function(n){ return n !== 'OUTROS'; });

  var card = el(
    '<div class="card">' +
      '<div class="np-dica"><b>Padrão de escrita:</b> FAMÍLIA + SABOR, tudo em MAIÚSCULAS, como nos produtos já cadastrados. Ex.: <b>CAIXA 10 LITROS AÇAI COM NUTELLA</b></div>' +
      '<div class="field"><label>Código</label><input type="number" id="np-cod" value="' + (maxCod+1) + '"></div>' +
      '<div class="field"><label>Família do produto</label><select id="np-fam"><option value="">Escolha a família…</option>' +
        fams.map(function(f){ return '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>'; }).join('') +
        '<option value="__outro">Outro (digitar o nome completo)</option></select></div>' +
      '<div class="field"><label id="np-nome-label">Sabor / descrição</label><input type="text" id="np-nome" placeholder="Ex.: AÇAI COM NUTELLA" autocapitalize="characters" autocomplete="off"></div>' +
      '<div class="np-preview" id="np-preview">Nome que será cadastrado: <b>—</b></div>' +
      '<div id="np-similares"></div>' +
      '<div class="grid2">' +
        '<div class="field"><label>Categoria (automática)</label><input type="text" id="np-cat" readonly></div>' +
        '<div class="field"><label>Família no kanban</label><input type="text" id="np-famkb" readonly></div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div class="field"><label>Qtd. produzida/ano (estimativa)</label><input type="number" id="np-qtdano" min="0" value="0"></div>' +
        '<div class="field"><label>Estoque atual</label><input type="number" id="np-atual" min="0" value="0"></div>' +
      '</div>' +
      '<div class="field"><label>Localização (opcional)</label><input type="text" id="np-loc" placeholder="Ex.: Câmara 1 · Prateleira A2"></div>' +
      '<button class="btn btn-primary btn-block" id="np-save">Adicionar produto</button>' +
    '</div>'
  );

  function nomeFinal(){
    var fam = qs('#np-fam', card).value;
    var desc = stdText(qs('#np-nome', card).value);
    if(!fam) return '';
    if(fam === '__outro') return desc;
    if(!desc) return '';
    if(desc.indexOf(fam + ' ') === 0) desc = desc.slice(fam.length + 1);
    return stdText(fam + ' ' + desc);
  }
  function atualizar(){
    var fam = qs('#np-fam', card).value;
    qs('#np-nome-label', card).textContent = fam === '__outro' ? 'Nome completo do produto' : 'Sabor / descrição';
    var nome = nomeFinal();
    qs('#np-preview b', card).textContent = nome || '—';
    qs('#np-cat', card).value = nome ? famFirstWord(nome) : '';
    qs('#np-famkb', card).value = nome ? familyOf(nome, famFirstWord(nome)) : '';
    var box = qs('#np-similares', card);
    var desc = stdText(qs('#np-nome', card).value);
    var palavras = norm(desc).split(' ').filter(function(w){ return w.length >= 3; });
    var sim = [];
    if(palavras.length){
      sim = allItemsArray().filter(function(it){
        var n = norm(it.produto);
        return palavras.every(function(w){ return n.indexOf(w) > -1; });
      }).slice(0, 6);
    }
    box.innerHTML = sim.length
      ? '<div class="np-sim"><b>Já cadastrados parecidos (confira para não duplicar):</b>' + sim.map(function(it){ return '<span>#' + it.codigo + ' · ' + escapeHtml(it.produto) + '</span>'; }).join('') + '</div>'
      : '';
  }
  ['#np-fam','#np-nome'].forEach(function(s){
    var e = qs(s, card);
    e.addEventListener('input', atualizar); e.addEventListener('change', atualizar);
  });
  qs('#np-nome', card).addEventListener('blur', function(){ this.value = stdText(this.value); atualizar(); });

  card.querySelector('#np-save').addEventListener('click', function(){
    var codigo = parseInt(qs('#np-cod', card).value, 10);
    var nome = nomeFinal();
    if(!codigo){ toast('Informe o código do produto.'); return; }
    if(!qs('#np-fam', card).value){ toast('Escolha a família do produto.'); return; }
    if(!nome || nome === stdText(qs('#np-fam', card).value)){ toast('Digite o sabor ou a descrição do produto.'); return; }
    if(state.items[String(codigo)]){ toast('Já existe um produto com esse código.'); return; }
    var igual = allItemsArray().filter(function(it){ return norm(stdText(it.produto)) === norm(nome); })[0];
    if(igual){ toast('Esse produto já existe: #' + igual.codigo + ' ' + igual.produto); return; }
    addProduct({
      codigo: codigo,
      produto: nome,
      categoria: famFirstWord(nome),
      qtdAnual: parseFloat(qs('#np-qtdano', card).value) || 0,
      estoqueAtual: parseFloat(qs('#np-atual', card).value) || 0,
      localizacao: qs('#np-loc', card).value || ''
    });
    state.cfgTab = 'localizacao';
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
