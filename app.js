/* ================================================================
   CAMADA DE DADOS (Data Layer)
   Versão local: tudo fica salvo no localStorage deste aparelho.
   Sem login, sem nuvem — funciona hoje, agora, abrindo o arquivo.
   A mesma interface (DB.get/DB.add/DB.save) é a que o resto do app
   usa, então quando você quiser reativar a sincronização via
   Firebase (depois do deploy no Hosting), é só trocar esta camada
   de novo, sem mexer no resto do código.

   Chaves e schemas:
   - contas_bancarias   { id, nome, saldo }
   - cartoes            { id, banco, nome, bandeira, tipo, limite, limiteDisponivel, fechamento, vencimento }
   - transacoes         { id, tipo:'receita'|'despesa', valor, categoria, data, cartaoId, descricao }
   - parcelas           { id, transacaoOrigemId, numero, totalParcelas, valor, vencimento, cartaoId, status }
   - contas_fixas       { id, nome, valor, categoria, primeiraData, numParcelas }
   - parcelas_fixas     { id, contaFixaId, numero, totalParcelas, valor, vencimento, status }
   - dividas            { id, tipo:'devo'|'me_devem', pessoa, telefone, valorTotal, valorPago, motivo, data, vencimento, observacoes }
   - parcelas_divida    { id, dividaId, numero, totalParcelas, valor, vencimento, status }
   - caixinhas          { id, nome, objetivo, valorAtual, valorMeta }
   - investimentos      { id, tipo, nome, valorAtual, valorAplicado }
   - categorias         { id, nome, emoji, tipo:'despesa'|'receita' }
   - aprendizado_categorias, historico_patrimonio, aniversarios
   ================================================================ */
const DB = {
  _key(col){ return 'financeiro_' + col; },
  get(col){
    try{
      const raw = localStorage.getItem(this._key(col));
      return raw ? JSON.parse(raw) : [];
    }catch(e){ return []; }
  },
  save(col, arr){
    localStorage.setItem(this._key(col), JSON.stringify(arr));
  },
  add(col, item){
    const arr = this.get(col);
    item.id = item.id || (Date.now().toString(36) + Math.random().toString(36).slice(2,7));
    arr.push(item);
    this.save(col, arr);
    return item;
  }
};

function salvarAprendizadoCategorias(mapa){
  DB.save('aprendizado_categorias', [mapa]);
}

// Categorias padrão (editáveis pela tela de categorias)
const CATEGORIAS_PADRAO = [
  {nome:'Alimentação', emoji:'🍽️'}, {nome:'Supermercado', emoji:'🛒'},
  {nome:'Restaurante', emoji:'🍔'}, {nome:'Farmácia', emoji:'💊'},
  {nome:'Saúde', emoji:'🩺'}, {nome:'Combustível', emoji:'⛽'},
  {nome:'Transporte', emoji:'🚗'}, {nome:'Academia', emoji:'🏋️'},
  {nome:'Lazer', emoji:'🎉'}, {nome:'Viagens', emoji:'✈️'},
  {nome:'Roupas', emoji:'👗'}, {nome:'Beleza', emoji:'💅'},
  {nome:'Pets', emoji:'🐾'}, {nome:'Cursos', emoji:'📚'},
  {nome:'Assinaturas', emoji:'🔁'}, {nome:'Casa', emoji:'🏠'},
  {nome:'Presentes', emoji:'🎁'}, {nome:'Impostos', emoji:'🧾'},
  {nome:'Outros', emoji:'✨'}
];
if(DB.get('categorias').length === 0){
  DB.save('categorias', CATEGORIAS_PADRAO.map((c,i)=>({id:'cat'+i, tipo:'despesa', ...c})));
}

// Migração: contas fixas cadastradas antes do sistema de parcelas ganham um
// primeiro lote de parcelas geradas automaticamente, sem perder o que já existia.
(function migrarContasFixasAntigas(){
  const contasFixas = DB.get('contas_fixas');
  const parcelasFixas = DB.get('parcelas_fixas');
  let mudou = false;
  contasFixas.forEach(cf=>{
    const jaTemParcelas = parcelasFixas.some(p=>p.contaFixaId===cf.id);
    if(jaTemParcelas) return;
    const primeiraData = cf.primeiraData || new Date().toISOString().slice(0,10);
    const numParcelas = cf.numParcelas || 12;
    if(!cf.primeiraData){ cf.primeiraData = primeiraData; cf.numParcelas = numParcelas; mudou = true; }
    const dataBase = new Date(primeiraData+'T00:00:00');
    for(let i=1;i<=numParcelas;i++){
      const venc = new Date(dataBase.getFullYear(), dataBase.getMonth()+(i-1), dataBase.getDate());
      DB.add('parcelas_fixas', { contaFixaId:cf.id, numero:i, totalParcelas:numParcelas, valor:cf.valor, vencimento: venc.toISOString().slice(0,10), status:'pendente' });
    }
  });
  if(mudou) DB.save('contas_fixas', contasFixas);
})();

/* ================================================================
   PWA — registro do Service Worker + atualização automática
   Quando uma nova versão é publicada (depois do deploy no Hosting),
   o navegador detecta o sw.js mudado, baixa a nova versão em segundo
   plano e, assim que ela assume o controle, recarregamos a página
   uma vez sozinhos. Em file:// isso simplesmente não ativa (Service
   Worker exige https ou localhost) — não trava nada, só não faz efeito.
   ================================================================ */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('/sw.js').catch(err=> console.error('Falha ao registrar Service Worker', err));
  });
  let jaRecarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(jaRecarregou) return;
    jaRecarregou = true;
    location.reload();
  });
}

/* ================================================================
   MOTOR DE CÁLCULO E RENDERIZAÇÃO DO DASHBOARD
   ================================================================ */
function money(v){
  return (v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}

/* Helper de gráficos: o Chart.js exige destruir o gráfico anterior
   antes de desenhar um novo no mesmo <canvas>. */
const chartInstances = {};
function criarGrafico(canvasId, config){
  if(chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(document.getElementById(canvasId), config);
}

function calcularDashboard(){
  const contas = DB.get('contas_bancarias');
  const cartoes = DB.get('cartoes');
  const transacoes = DB.get('transacoes');
  const contasFixas = DB.get('contas_fixas');
  const parcelasFixas = DB.get('parcelas_fixas');
  const parcelas = DB.get('parcelas');
  const parcelasDivida = DB.get('parcelas_divida');
  const dividas = DB.get('dividas');
  const caixinhas = DB.get('caixinhas');
  const investimentos = DB.get('investimentos');

  const hoje = new Date();
  const mesAtual = hoje.getMonth(), anoAtual = hoje.getFullYear();

  const dinheiroConta = contas.reduce((s,c)=>s+(c.saldo||0),0);
  const totalCaixinhas = caixinhas.reduce((s,c)=>s+(c.valorAtual||0),0);
  const totalInvestido = investimentos.reduce((s,i)=>s+(i.valorAtual||0),0);
  const limiteDisponivel = cartoes.reduce((s,c)=>s+(c.limiteDisponivel||0),0);

  const devoOutros = dividas.filter(d=>d.tipo==='devo').reduce((s,d)=>s+((d.valorTotal||0)-(d.valorPago||0)),0);
  const meDevem = dividas.filter(d=>d.tipo==='me_devem').reduce((s,d)=>s+((d.valorTotal||0)-(d.valorPago||0)),0);

  let contasAVencer = 0, contasVencidas = 0;
  parcelas.forEach(p=>{
    if(p.status==='pago') return;
    const venc = new Date(p.vencimento);
    if(venc < hoje) contasVencidas += p.valor||0;
    else contasAVencer += p.valor||0;
  });
  parcelasFixas.forEach(p=>{
    if(p.status==='pago') return;
    const venc = new Date(p.vencimento);
    if(venc < hoje) contasVencidas += p.valor||0;
    else contasAVencer += p.valor||0;
  });
  parcelasDivida.forEach(p=>{
    if(p.status==='paga') return;
    const divida = dividas.find(d=>d.id===p.dividaId);
    if(!divida || divida.tipo!=='devo') return;
    const venc = new Date(p.vencimento);
    if(venc < hoje) contasVencidas += p.valor||0;
    else contasAVencer += p.valor||0;
  });

  const transacoesMes = transacoes.filter(t=>{
    const d = new Date(t.data);
    return d.getMonth()===mesAtual && d.getFullYear()===anoAtual;
  });
  const gastoMes = transacoesMes.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+(t.valor||0),0);
  const receitaMes = transacoesMes.filter(t=>t.tipo==='receita').reduce((s,t)=>s+(t.valor||0),0);

  const saldoDisponivel = dinheiroConta + receitaMes - gastoMes;
  const patrimonio = dinheiroConta + totalInvestido + totalCaixinhas - devoOutros;

  const porCategoria = {};
  transacoesMes.filter(t=>t.tipo==='despesa').forEach(t=>{
    porCategoria[t.categoria] = (porCategoria[t.categoria]||0) + t.valor;
  });

  const porCategoriaMesAnterior = {};
  const mesAnteriorRef = new Date(anoAtual, mesAtual-1, 1);
  transacoes.filter(t=>{
    const dt = new Date(t.data);
    return t.tipo==='despesa' && dt.getMonth()===mesAnteriorRef.getMonth() && dt.getFullYear()===mesAnteriorRef.getFullYear();
  }).forEach(t=>{ porCategoriaMesAnterior[t.categoria] = (porCategoriaMesAnterior[t.categoria]||0) + t.valor; });

  const gastosMesesAnteriores = [];
  for(let i=1;i<=3;i++){
    const ref = new Date(anoAtual, mesAtual-i, 1);
    const total = transacoes.filter(t=>{
      const dt = new Date(t.data);
      return t.tipo==='despesa' && dt.getMonth()===ref.getMonth() && dt.getFullYear()===ref.getFullYear();
    }).reduce((s,t)=>s+t.valor,0);
    if(total>0) gastosMesesAnteriores.push(total);
  }
  const mediaGastoMesesAnteriores = gastosMesesAnteriores.length ? gastosMesesAnteriores.reduce((a,b)=>a+b,0)/gastosMesesAnteriores.length : 0;

  return {
    saldoDisponivel, dinheiroConta, totalCaixinhas, totalInvestido, limiteDisponivel,
    devoOutros, meDevem, contasAVencer, contasVencidas, gastoMes, receitaMes,
    patrimonio, porCategoria, porCategoriaMesAnterior, mediaGastoMesesAnteriores, cartoes
  };
}

function renderDashboard(){
  const d = calcularDashboard();

  document.getElementById('saldoDisponivel').textContent = money(d.saldoDisponivel);
  document.getElementById('chipConta').textContent = money(d.dinheiroConta);
  document.getElementById('chipInvestido').textContent = money(d.totalInvestido);
  document.getElementById('chipCaixinhas').textContent = money(d.totalCaixinhas);

  document.getElementById('mContasVencer').textContent = money(d.contasAVencer);
  document.getElementById('mContasVencidas').textContent = money(d.contasVencidas);
  document.getElementById('mDevoOutros').textContent = money(d.devoOutros);
  document.getElementById('mMeDevem').textContent = money(d.meDevem);
  document.getElementById('mLimiteCartoes').textContent = money(d.limiteDisponivel);
  document.getElementById('mPatrimonio').textContent = money(d.patrimonio);
  document.getElementById('mGastoMes').textContent = money(d.gastoMes);
  document.getElementById('mReceitaMes').textContent = money(d.receitaMes);

  const pct = d.receitaMes > 0 ? Math.min(100, Math.round((d.gastoMes / d.receitaMes) * 100)) : 0;
  const circumference = 226;
  const offset = circumference - (pct/100)*circumference;
  document.getElementById('ringFg').style.strokeDashoffset = offset;
  document.getElementById('ringLabel').textContent = pct + '%';

  const cats = Object.keys(d.porCategoria);
  const emptyNote = document.getElementById('gastosEmptyNote');
  if(cats.length === 0){
    emptyNote.style.display = 'block';
  } else {
    emptyNote.style.display = 'none';
    const catMeta = DB.get('categorias');
    const labels = cats.map(c => {
      const meta = catMeta.find(m=>m.nome===c);
      return meta ? meta.emoji+' '+meta.nome : c;
    });
    const values = cats.map(c=>d.porCategoria[c]);
    criarGrafico('chartGastos', {
      type:'doughnut',
      data:{ labels, datasets:[{ data:values, backgroundColor:['#E58AA6','#FBE7A1','#8A7680','#D97878','#7BAE8F','#F1EBE7','#EFC24B','#F7D9E3'], borderWidth:0 }] },
      options:{ maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{ size:11 } } } } }
    });
  }

  registrarSnapshotPatrimonio(d.patrimonio);

  const evoNote = document.getElementById('evolucaoEmptyNote');
  const historico = DB.get('historico_patrimonio').sort((a,b)=> a.data.localeCompare(b.data)).slice(-14);
  if(historico.length < 2){
    evoNote.style.display = 'block';
  } else {
    evoNote.style.display = 'none';
    criarGrafico('chartEvolucao', {
      type:'line',
      data:{
        labels: historico.map(h=> new Date(h.data+'T00:00:00').toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit'})),
        datasets:[{ label:'Patrimônio', data:historico.map(h=>h.valor), borderColor:'#E58AA6', backgroundColor:'rgba(229,138,166,0.15)', fill:true, tension:0.4 }]
      },
      options:{ maintainAspectRatio:false, plugins:{ legend:{ display:false } } }
    });
  }

  renderInsights(d);

  const resumoList = document.getElementById('resumoList');
  const itens = [];
  if(d.receitaMes>0 || d.gastoMes>0){
    itens.push(`<div class="resumo-item"><span class="tag">💵 Receitas</span><span class="amt">${money(d.receitaMes)}</span></div>`);
    itens.push(`<div class="resumo-item"><span class="tag">🧾 Despesas</span><span class="amt">${money(d.gastoMes)}</span></div>`);
    itens.push(`<div class="resumo-item"><span class="tag">${d.receitaMes-d.gastoMes>=0?'✅':'⚠️'} Saldo do mês</span><span class="amt">${money(d.receitaMes-d.gastoMes)}</span></div>`);
  } else {
    itens.push(`<div class="resumo-item"><span class="tag">✨ Tudo pronto</span><span class="amt">Comece adicionando seu primeiro lançamento</span></div>`);
  }
  resumoList.innerHTML = itens.join('');
  if(typeof renderNotificacoes === 'function') renderNotificacoes();
}

// Saudação dinâmica
const hora = new Date().getHours();
document.getElementById('greeting').textContent = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

/* ================================================================
   NAVEGAÇÃO POR ABAS
   ================================================================ */
let currentView = 'dashboard';
function switchView(view){
  currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>{
    const alvo = (view==='caixinhas'||view==='investimentos'||view==='calendario'||view==='calculadora'||view==='relatorios'||view==='categorias'||view==='configuracoes'||view==='assistente') ? 'mais' : view;
    b.classList.toggle('active', b.dataset.view===alvo);
  });
  document.getElementById('fabAdd').style.display = (view==='mais'||view==='calendario'||view==='calculadora'||view==='relatorios'||view==='categorias'||view==='configuracoes'||view==='assistente') ? 'none' : 'flex';
  if(view==='lancamentos') renderListaLancamentos();
  if(view==='cartoes') renderListaCartoes();
  if(view==='contasfixas') renderListaContasFixas();
  if(view==='dividas') renderListaDividas();
  if(view==='caixinhas') renderListaCaixinhas();
  if(view==='investimentos') renderListaInvestimentos();
  if(view==='calendario') renderCalendario();
  if(view==='relatorios') renderRelatorios();
  if(view==='categorias') renderListaCategorias();
  if(view==='configuracoes') renderListaContasBancarias();
  if(view==='assistente') initAssistente();
  if(view==='calculadora' && document.getElementById('calcSomaLinhas').children.length===0){
    calcAddSomaLinha(); calcAddSomaLinha();
    calcAddSubLinha();
  }
}
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});
document.querySelectorAll('[data-sub]').forEach(card=>{
  card.addEventListener('click', ()=> switchView(card.dataset.sub));
});
document.querySelectorAll('[data-sub-back]').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.subBack));
});

document.getElementById('fabAdd').addEventListener('click', ()=>{
  if(currentView === 'cartoes') abrirModalCartao();
  else if(currentView === 'contasfixas') abrirModalContaFixa();
  else if(currentView === 'dividas') abrirModalDivida();
  else if(currentView === 'caixinhas') abrirModalCaixinha();
  else if(currentView === 'investimentos') abrirModalInvestimento();
  else abrirModalTransacao();
});
document.querySelectorAll('[data-close]').forEach(btn=>{
  btn.addEventListener('click', ()=> fecharModal(btn.dataset.close));
});
document.querySelectorAll('.modal-overlay').forEach(ov=>{
  ov.addEventListener('click', (e)=>{ if(e.target === ov) fecharModal(ov.id); });
});
function fecharModal(id){ document.getElementById(id).classList.remove('open'); }

/* ================================================================
   APRENDIZADO DE CATEGORIAS
   Guarda descrição -> categoria mais usada, para sugerir automático
   na próxima vez (ex: "Drogasil" sempre vira Farmácia).
   ================================================================ */
function aprenderCategoria(descricao, categoria){
  if(!descricao) return;
  const mapa = DB.get('aprendizado_categorias')[0] || {};
  const chave = descricao.trim().toLowerCase();
  mapa[chave] = categoria;
  salvarAprendizadoCategorias(mapa);
}
function sugerirCategoria(descricao){
  const mapa = DB.get('aprendizado_categorias')[0] || {};
  return mapa[descricao.trim().toLowerCase()] || null;
}

/* ================================================================
   MODAL: TRANSAÇÃO (receita/despesa)
   ================================================================ */
let tipoAtual = 'despesa';

function popularSelects(){
  const catSelect = document.getElementById('txCategoriaDespesa');
  const cats = DB.get('categorias');
  catSelect.innerHTML = cats.map(c=>`<option value="${c.nome}">${c.emoji} ${c.nome}</option>`).join('');

  const cartSelect = document.getElementById('txCartao');
  const cartoes = DB.get('cartoes');
  cartSelect.innerHTML = '<option value="">Conta / dinheiro</option>' +
    cartoes.map(c=>`<option value="${c.id}">${c.tipo==='debito'?'🏧':'💳'} ${c.banco} - ${c.nome}</option>`).join('');
}

function abrirModalTransacao(){
  popularSelects();
  document.getElementById('txDescricao').value='';
  document.getElementById('txValor').value='';
  document.getElementById('txData').value = new Date().toISOString().slice(0,10);
  document.getElementById('txParticipantes').value='';
  document.getElementById('txParcelado').checked=false;
  document.getElementById('txDividir').checked=false;
  document.getElementById('txAprendizadoHint').classList.add('hidden');
  document.getElementById('fieldParcelas').classList.add('hidden');
  document.getElementById('fieldParticipantes').classList.add('hidden');
  document.getElementById('txDivisaoPreview').textContent='';
  setTipo('despesa');
  document.getElementById('modalTransacao').classList.add('open');
}

function setTipo(tipo){
  tipoAtual = tipo;
  document.querySelectorAll('#segTipo button').forEach(b=> b.classList.toggle('active', b.dataset.tipo===tipo));
  const isDespesa = tipo==='despesa';
  document.getElementById('fieldCategoriaDespesa').classList.toggle('hidden', !isDespesa);
  document.getElementById('fieldCategoriaReceita').classList.toggle('hidden', isDespesa);
  document.getElementById('fieldFormaPagamento').classList.toggle('hidden', !isDespesa);
  document.getElementById('lineDividir').classList.toggle('hidden', !isDespesa);
  if(!isDespesa){
    document.getElementById('lineParcelado').classList.add('hidden');
    document.getElementById('fieldParcelas').classList.add('hidden');
  } else {
    const cartaoSel = DB.get('cartoes').find(c=>c.id===document.getElementById('txCartao').value);
    const podeParcelar = !!document.getElementById('txCartao').value && (!cartaoSel || cartaoSel.tipo!=='debito');
    document.getElementById('lineParcelado').classList.toggle('hidden', !podeParcelar);
  }
}
document.querySelectorAll('#segTipo button').forEach(b=>{
  b.addEventListener('click', ()=> setTipo(b.dataset.tipo));
});

document.getElementById('txDescricao').addEventListener('blur', function(){
  const sugestao = sugerirCategoria(this.value);
  const hint = document.getElementById('txAprendizadoHint');
  if(sugestao && tipoAtual==='despesa'){
    document.getElementById('txCategoriaDespesa').value = sugestao;
    hint.textContent = '🧠 Você sempre categoriza "' + this.value.trim() + '" como ' + sugestao;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
});

document.getElementById('txCartao').addEventListener('change', function(){
  const cartao = DB.get('cartoes').find(c=>c.id===this.value);
  const podeParcelar = !!this.value && (!cartao || cartao.tipo!=='debito');
  document.getElementById('lineParcelado').classList.toggle('hidden', !podeParcelar);
  if(!podeParcelar){
    document.getElementById('txParcelado').checked=false;
    document.getElementById('fieldParcelas').classList.add('hidden');
  }
});
document.getElementById('txParcelado').addEventListener('change', function(){
  document.getElementById('fieldParcelas').classList.toggle('hidden', !this.checked);
});
document.getElementById('txDividir').addEventListener('change', function(){
  document.getElementById('fieldParticipantes').classList.toggle('hidden', !this.checked);
  atualizarPreviaDivisao();
});
document.getElementById('txParticipantes').addEventListener('input', atualizarPreviaDivisao);
document.getElementById('txValor').addEventListener('input', atualizarPreviaDivisao);

function atualizarPreviaDivisao(){
  const valor = parseFloat(document.getElementById('txValor').value)||0;
  const participantes = document.getElementById('txParticipantes').value.split(',').map(s=>s.trim()).filter(Boolean);
  const preview = document.getElementById('txDivisaoPreview');
  if(participantes.length===0 || valor<=0){ preview.textContent=''; return; }
  const partes = participantes.length + 1;
  const porPessoa = valor/partes;
  preview.textContent = `💸 ${money(porPessoa)} para cada (você + ${participantes.length} pessoa${participantes.length>1?'s':''})`;
}

document.getElementById('btnSalvarTx').addEventListener('click', ()=>{
  const descricao = document.getElementById('txDescricao').value.trim();
  const valor = parseFloat(document.getElementById('txValor').value);
  const data = document.getElementById('txData').value || new Date().toISOString().slice(0,10);
  if(!valor || valor<=0){ alert('Informe um valor válido.'); return; }

  if(tipoAtual === 'receita'){
    const categoria = document.getElementById('txCategoriaReceita').value;
    DB.add('transacoes', { tipo:'receita', valor, categoria, data, descricao });
  } else {
    const categoria = document.getElementById('txCategoriaDespesa').value;
    const cartaoId = document.getElementById('txCartao').value || null;
    const cartaoSelecionado = cartaoId ? DB.get('cartoes').find(c=>c.id===cartaoId) : null;
    const parcelado = document.getElementById('txParcelado').checked && !!cartaoId && (!cartaoSelecionado || cartaoSelecionado.tipo!=='debito');
    const numParcelas = parcelado ? Math.max(2, parseInt(document.getElementById('txNumParcelas').value)||2) : 1;

    if(descricao) aprenderCategoria(descricao, categoria);

    const transacao = DB.add('transacoes', { tipo:'despesa', valor, categoria, data, cartaoId, descricao });

    // Compra no cartão: compromete o limite disponível imediatamente
    if(cartaoId){
      const cartoes = DB.get('cartoes');
      const cartao = cartoes.find(c=>c.id===cartaoId);
      if(cartao){
        cartao.limiteDisponivel = Math.max(0, (cartao.limiteDisponivel||0) - valor);
        DB.save('cartoes', cartoes);
      }
    }

    // Parcelamento: gera as parcelas futuras automaticamente
    if(parcelado){
      const cartoes = DB.get('cartoes');
      const cartao = cartoes.find(c=>c.id===cartaoId);
      const diaVenc = cartao ? cartao.vencimento : 10;
      const valorParcela = Math.round((valor/numParcelas)*100)/100;
      const dataBase = new Date(data);
      for(let i=1;i<=numParcelas;i++){
        const venc = new Date(dataBase.getFullYear(), dataBase.getMonth()+i, diaVenc||10);
        DB.add('parcelas', {
          transacaoOrigemId: transacao.id, numero:i, totalParcelas:numParcelas,
          valor: valorParcela, vencimento: venc.toISOString().slice(0,10),
          cartaoId, status:'pendente'
        });
      }
    }

    // Divisão de despesa: gera dívida "me_devem" para cada participante
    if(document.getElementById('txDividir').checked){
      const participantes = document.getElementById('txParticipantes').value.split(',').map(s=>s.trim()).filter(Boolean);
      if(participantes.length){
        const porPessoa = Math.round((valor/(participantes.length+1))*100)/100;
        participantes.forEach(nome=>{
          DB.add('dividas', {
            tipo:'me_devem', pessoa:nome, telefone:'', valorTotal:porPessoa, valorPago:0,
            motivo: descricao || categoria, data, vencimento:'', observacoes:'Divisão de despesa'
          });
        });
      }
    }
  }

  fecharModal('modalTransacao');
  renderDashboard();
  if(currentView==='lancamentos') renderListaLancamentos();
  if(currentView==='cartoes') renderListaCartoes();
});

function renderListaLancamentos(){
  const transacoes = [...DB.get('transacoes')].sort((a,b)=> new Date(b.data)-new Date(a.data));
  const list = document.getElementById('txList');
  if(transacoes.length===0){
    list.innerHTML = '<div class="empty-note">Nenhum lançamento ainda. Toque no + para adicionar o primeiro.</div>';
    return;
  }
  const catMeta = DB.get('categorias');
  const cartoes = DB.get('cartoes');
  list.innerHTML = transacoes.map(t=>{
    const isDespesa = t.tipo==='despesa';
    const meta = catMeta.find(m=>m.nome===t.categoria);
    const emoji = isDespesa ? (meta ? meta.emoji : '🧾') : '💵';
    const cartao = t.cartaoId ? cartoes.find(c=>c.id===t.cartaoId) : null;
    const metaTxt = [t.categoria, cartao ? cartao.nome : null, new Date(t.data).toLocaleDateString('pt-BR')].filter(Boolean).join(' · ');
    return `<div class="tx-item">
      <div class="tx-left">
        <div class="tx-emoji">${emoji}</div>
        <div class="tx-info">
          <div class="tx-desc">${t.descricao || t.categoria}</div>
          <div class="tx-meta">${metaTxt}</div>
        </div>
      </div>
      <div class="tx-right">
        <div class="tx-value ${isDespesa?'neg':'pos'}">${isDespesa?'-':'+'}${money(t.valor)}</div>
        <button class="tx-del" data-id="${t.id}" title="Excluir">🗑️</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.tx-del').forEach(btn=>{
    btn.addEventListener('click', ()=> excluirTransacao(btn.dataset.id));
  });
}

function excluirTransacao(id){
  const transacoes = DB.get('transacoes');
  const t = transacoes.find(x=>x.id===id);
  if(!t) return;
  if(!confirm('Excluir este lançamento?')) return;
  // Se era compra no cartão, devolve o limite
  if(t.cartaoId){
    const cartoes = DB.get('cartoes');
    const cartao = cartoes.find(c=>c.id===t.cartaoId);
    if(cartao){
      cartao.limiteDisponivel = Math.min(cartao.limite, (cartao.limiteDisponivel||0) + t.valor);
      DB.save('cartoes', cartoes);
    }
  }
  DB.save('transacoes', transacoes.filter(x=>x.id!==id));
  renderListaLancamentos();
  renderDashboard();
}

/* ================================================================
   MODAL: CARTÃO
   ================================================================ */
let cartaoTipoAtual = 'credito';
let cartaoEditandoId = null;

document.querySelectorAll('#segCartaoTipo button').forEach(b=>{
  b.addEventListener('click', ()=>{
    cartaoTipoAtual = b.dataset.tipo;
    document.querySelectorAll('#segCartaoTipo button').forEach(x=>x.classList.toggle('active', x===b));
    const isDebito = cartaoTipoAtual==='debito';
    document.getElementById('cbLimiteLabel').textContent = isDebito ? 'Limite diário/mensal (R$)' : 'Limite total (R$)';
    document.getElementById('fieldCbFechamento').classList.toggle('hidden', isDebito);
  });
});

function abrirModalCartao(cartaoId){
  cartaoEditandoId = cartaoId || null;
  const cartao = cartaoId ? DB.get('cartoes').find(c=>c.id===cartaoId) : null;
  document.getElementById('modalCartaoTitulo').textContent = cartao ? 'Editar cartão' : 'Novo cartão';
  document.getElementById('cbBanco').value = cartao ? cartao.banco : '';
  document.getElementById('cbNome').value = cartao ? cartao.nome : '';
  document.getElementById('cbLimite').value = cartao ? cartao.limite : '';
  document.getElementById('cbFechamento').value = cartao ? (cartao.fechamento||'') : '';
  document.getElementById('cbVencimento').value = cartao ? (cartao.vencimento||'') : '';
  document.getElementById('cbBandeira').value = cartao ? cartao.bandeira : 'Visa';
  cartaoTipoAtual = cartao ? (cartao.tipo||'credito') : 'credito';
  document.querySelectorAll('#segCartaoTipo button').forEach(b=> b.classList.toggle('active', b.dataset.tipo===cartaoTipoAtual));
  const isDebito = cartaoTipoAtual==='debito';
  document.getElementById('cbLimiteLabel').textContent = isDebito ? 'Limite diário/mensal (R$)' : 'Limite total (R$)';
  document.getElementById('fieldCbFechamento').classList.toggle('hidden', isDebito);
  document.getElementById('modalCartao').classList.add('open');
}

document.getElementById('btnSalvarCartao').addEventListener('click', ()=>{
  const banco = document.getElementById('cbBanco').value.trim();
  const nome = document.getElementById('cbNome').value.trim();
  const limite = parseFloat(document.getElementById('cbLimite').value);
  if(!banco || !nome || !limite || limite<=0){ alert('Preencha banco, nome e limite.'); return; }
  const bandeira = document.getElementById('cbBandeira').value;
  const fechamento = parseInt(document.getElementById('cbFechamento').value)||null;
  const vencimento = parseInt(document.getElementById('cbVencimento').value)||null;

  if(cartaoEditandoId){
    const cartoes = DB.get('cartoes');
    const c = cartoes.find(x=>x.id===cartaoEditandoId);
    if(c){
      const delta = limite - c.limite; // preserva o quanto já foi comprometido do limite
      c.banco=banco; c.nome=nome; c.bandeira=bandeira; c.tipo=cartaoTipoAtual;
      c.limite=limite; c.limiteDisponivel = Math.max(0, (c.limiteDisponivel||0) + delta);
      c.fechamento=fechamento; c.vencimento=vencimento;
      DB.save('cartoes', cartoes);
    }
  } else {
    DB.add('cartoes', { banco, nome, bandeira, tipo:cartaoTipoAtual, limite, limiteDisponivel:limite, fechamento, vencimento });
  }
  fecharModal('modalCartao');
  renderListaCartoes();
  renderDashboard();
});

function renderListaCartoes(){
  const cartoes = DB.get('cartoes');
  const list = document.getElementById('cardList');
  if(cartoes.length===0){
    list.innerHTML = '<div class="empty-note">Nenhum cartão cadastrado. Toque no + para adicionar.</div>';
    return;
  }
  list.innerHTML = cartoes.map(c=>{
    const pct = c.limite>0 ? Math.round(((c.limite-c.limiteDisponivel)/c.limite)*100) : 0;
    const isDebito = c.tipo==='debito';
    return `<div class="card-visual">
      <button class="cv-del" data-id="${c.id}" data-action="excluir" title="Excluir" style="right:52px;">✕</button>
      <button class="cv-del" data-id="${c.id}" data-action="editar" title="Editar">✏️</button>
      <div class="cv-top"><span>${isDebito?'🏧 Débito':'💳 Crédito'} · ${c.banco}</span><span>${c.bandeira}</span></div>
      <div class="cv-nome">${c.nome}</div>
      <div class="cv-limite">${money(c.limiteDisponivel)} <span style="font-size:12px;font-weight:600;opacity:0.75;">disponível</span></div>
      <div class="cv-bar"><div class="cv-bar-fill" style="width:${100-pct}%"></div></div>
      <div class="cv-foot">
        <span>Limite: ${money(c.limite)}</span>
        <span>${isDebito ? 'Vence dia '+(c.vencimento||'-') : 'Fecha dia '+(c.fechamento||'-')+' · Vence dia '+(c.vencimento||'-')}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir este cartão?')) return;
      DB.save('cartoes', DB.get('cartoes').filter(c=>c.id!==btn.dataset.id));
      renderListaCartoes();
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-action="editar"]').forEach(btn=>{
    btn.addEventListener('click', ()=> abrirModalCartao(btn.dataset.id));
  });
}

/* ================================================================
   MODAL: CONTA FIXA
   ================================================================ */
let contaFixaEditandoId = null;
function abrirModalContaFixa(contaFixaId){
  contaFixaEditandoId = contaFixaId || null;
  const cf = contaFixaId ? DB.get('contas_fixas').find(c=>c.id===contaFixaId) : null;
  document.getElementById('modalContaFixaTitulo').textContent = cf ? 'Editar conta fixa' : 'Nova conta fixa';
  document.getElementById('cfNome').value = cf ? cf.nome : '';
  document.getElementById('cfValor').value = cf ? cf.valor : '';
  document.getElementById('cfPrimeiraData').value = cf ? cf.primeiraData : new Date().toISOString().slice(0,10);
  document.getElementById('cfNumParcelas').value = cf ? cf.numParcelas : 12;
  const catSelect = document.getElementById('cfCategoria');
  catSelect.innerHTML = DB.get('categorias').map(c=>`<option value="${c.nome}">${c.emoji} ${c.nome}</option>`).join('');
  if(cf) catSelect.value = cf.categoria;
  document.getElementById('modalContaFixa').classList.add('open');
}

function gerarParcelasFixas(contaFixaId, valor, primeiraData, numParcelas){
  const dataBase = new Date(primeiraData+'T00:00:00');
  for(let i=1;i<=numParcelas;i++){
    const venc = new Date(dataBase.getFullYear(), dataBase.getMonth()+(i-1), dataBase.getDate());
    DB.add('parcelas_fixas', {
      contaFixaId, numero:i, totalParcelas:numParcelas, valor,
      vencimento: venc.toISOString().slice(0,10), status:'pendente'
    });
  }
}

document.getElementById('btnSalvarContaFixa').addEventListener('click', ()=>{
  const nome = document.getElementById('cfNome').value.trim();
  const valor = parseFloat(document.getElementById('cfValor').value);
  const categoria = document.getElementById('cfCategoria').value;
  const primeiraData = document.getElementById('cfPrimeiraData').value;
  const numParcelas = Math.max(1, parseInt(document.getElementById('cfNumParcelas').value)||1);
  if(!nome || !valor || valor<=0 || !primeiraData){ alert('Preencha nome, valor e a 1ª data de vencimento.'); return; }

  if(contaFixaEditandoId){
    const contasFixas = DB.get('contas_fixas');
    const cf = contasFixas.find(c=>c.id===contaFixaEditandoId);
    if(cf){
      cf.nome = nome; cf.valor = valor; cf.categoria = categoria;
      cf.primeiraData = primeiraData; cf.numParcelas = numParcelas;
      DB.save('contas_fixas', contasFixas);
      // Regenera só as parcelas ainda não pagas — o histórico do que já foi pago é preservado
      const parcelasFixas = DB.get('parcelas_fixas');
      DB.save('parcelas_fixas', parcelasFixas.filter(p=> !(p.contaFixaId===cf.id && p.status!=='pago')));
      gerarParcelasFixas(cf.id, valor, primeiraData, numParcelas);
    }
  } else {
    const nova = DB.add('contas_fixas', { nome, valor, categoria, primeiraData, numParcelas });
    gerarParcelasFixas(nova.id, valor, primeiraData, numParcelas);
  }
  fecharModal('modalContaFixa');
  renderListaContasFixas();
  renderDashboard();
});

function renderListaContasFixas(){
  const contasFixas = DB.get('contas_fixas');
  const list = document.getElementById('fixasList');
  if(contasFixas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma conta fixa cadastrada. Toque no + para adicionar (aluguel, internet, academia...).</div>';
    return;
  }
  const todasParcelas = DB.get('parcelas_fixas');
  const catMeta = DB.get('categorias');
  const hoje = new Date(); hoje.setHours(0,0,0,0);

  list.innerHTML = contasFixas.map(cf=>{
    const meta = catMeta.find(m=>m.nome===cf.categoria);
    const parcelas = todasParcelas.filter(p=>p.contaFixaId===cf.id).sort((a,b)=>a.numero-b.numero);
    const pendentes = parcelas.filter(p=>p.status!=='pago');
    const proxima = pendentes.find(p=> new Date(p.vencimento+'T00:00:00') >= hoje) || pendentes[0];
    const statusTxt = !proxima ? '✅ Todas as parcelas pagas'
      : (new Date(proxima.vencimento+'T00:00:00') < hoje ? '⚠️ Vencida' : '📅 Próxima em ' + new Date(proxima.vencimento+'T00:00:00').toLocaleDateString('pt-BR'));

    const parcelasHtml = `<div style="width:100%; margin-top:10px; padding-top:10px; border-top:1px dashed var(--stone-dark); display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;">` +
      parcelas.map(p=>{
        const paga = p.status==='pago';
        return `<div style="display:flex; align-items:center; justify-content:space-between; font-size:12.5px;">
          <span>${paga?'✅':'⏳'} Parcela ${p.numero}/${p.totalParcelas} · ${new Date(p.vencimento+'T00:00:00').toLocaleDateString('pt-BR')}</span>
          <span style="display:flex; align-items:center; gap:8px;">
            <strong>${money(p.valor)}</strong>
            <button data-parcela-fixa="${p.id}" style="font-size:11px; color:var(--rose-deep); font-weight:700; background:none; border:none; cursor:pointer;">${paga?'Desfazer':'Marcar paga'}</button>
          </span>
        </div>`;
      }).join('') + `</div>`;

    return `<div class="tx-item" style="flex-wrap:wrap;">
      <div class="tx-left">
        <div class="tx-emoji">${meta?meta.emoji:'📅'}</div>
        <div class="tx-info">
          <div class="tx-desc">${cf.nome}</div>
          <div class="tx-meta">${statusTxt} · ${cf.numParcelas}x de ${money(cf.valor)}</div>
        </div>
      </div>
      <div class="tx-right">
        <button class="tx-del" data-id="${cf.id}" data-action="editar" title="Editar">✏️</button>
        <button class="tx-del" data-id="${cf.id}" data-action="excluir" title="Excluir">🗑️</button>
      </div>
      ${parcelasHtml}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="editar"]').forEach(btn=>{
    btn.addEventListener('click', ()=> abrirModalContaFixa(btn.dataset.id));
  });
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta conta fixa e todas as suas parcelas?')) return;
      DB.save('contas_fixas', DB.get('contas_fixas').filter(c=>c.id!==btn.dataset.id));
      DB.save('parcelas_fixas', DB.get('parcelas_fixas').filter(p=>p.contaFixaId!==btn.dataset.id));
      renderListaContasFixas();
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-parcela-fixa]').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleParcelaFixaPaga(btn.dataset.parcelaFixa));
  });
}

function toggleParcelaFixaPaga(parcelaId){
  const parcelas = DB.get('parcelas_fixas');
  const p = parcelas.find(x=>x.id===parcelaId);
  if(!p) return;
  const vaiMarcarPaga = p.status!=='pago';
  p.status = vaiMarcarPaga ? 'pago' : 'pendente';
  DB.save('parcelas_fixas', parcelas);
  if(vaiMarcarPaga){
    const cf = DB.get('contas_fixas').find(c=>c.id===p.contaFixaId);
    if(cf){
      DB.add('transacoes', { tipo:'despesa', valor:p.valor, categoria:cf.categoria, data:new Date().toISOString().slice(0,10), cartaoId:null, descricao:cf.nome });
    }
  }
  renderListaContasFixas();
  renderDashboard();
}

/* ================================================================
   MODAL: DÍVIDA
   ================================================================ */
let dividaTipoAtual = 'devo';
document.querySelectorAll('#segDividaTipo button').forEach(b=>{
  b.addEventListener('click', ()=>{
    dividaTipoAtual = b.dataset.tipo;
    document.querySelectorAll('#segDividaTipo button').forEach(x=>x.classList.toggle('active', x===b));
  });
});

document.getElementById('dvParcelar').addEventListener('change', function(){
  document.getElementById('fieldDvParcelas').classList.toggle('hidden', !this.checked);
  document.querySelector('#fieldDvVencimento label').textContent = this.checked ? 'Vencimento da 1ª parcela' : 'Vencimento (opcional)';
  atualizarPreviaParcelasDivida();
});
document.getElementById('dvNumParcelas').addEventListener('input', atualizarPreviaParcelasDivida);
document.getElementById('dvValor').addEventListener('input', atualizarPreviaParcelasDivida);

function atualizarPreviaParcelasDivida(){
  const preview = document.getElementById('dvParcelasPreview');
  if(!document.getElementById('dvParcelar').checked){ preview.textContent=''; return; }
  const valor = parseFloat(document.getElementById('dvValor').value)||0;
  const n = Math.max(2, parseInt(document.getElementById('dvNumParcelas').value)||2);
  if(valor<=0){ preview.textContent=''; return; }
  preview.textContent = `📆 ${n}x de ${money(Math.round((valor/n)*100)/100)}, uma por mês`;
}

function abrirModalDivida(){
  ['dvPessoa','dvTelefone','dvValor','dvMotivo','dvVencimento','dvObservacoes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('dvData').value = new Date().toISOString().slice(0,10);
  document.getElementById('dvParcelar').checked = false;
  document.getElementById('dvNumParcelas').value = 2;
  document.getElementById('fieldDvParcelas').classList.add('hidden');
  document.getElementById('dvParcelasPreview').textContent = '';
  document.querySelector('#fieldDvVencimento label').textContent = 'Vencimento (opcional)';
  dividaTipoAtual = 'devo';
  document.querySelectorAll('#segDividaTipo button').forEach(b=>b.classList.toggle('active', b.dataset.tipo==='devo'));
  document.getElementById('modalDivida').classList.add('open');
}

document.getElementById('btnSalvarDivida').addEventListener('click', ()=>{
  const pessoa = document.getElementById('dvPessoa').value.trim();
  const valor = parseFloat(document.getElementById('dvValor').value);
  if(!pessoa || !valor || valor<=0){ alert('Informe a pessoa e o valor.'); return; }
  const parcelado = document.getElementById('dvParcelar').checked;
  const numParcelas = parcelado ? Math.max(2, parseInt(document.getElementById('dvNumParcelas').value)||2) : 1;
  const data = document.getElementById('dvData').value;
  const vencimento = document.getElementById('dvVencimento').value;

  const divida = DB.add('dividas', {
    tipo: dividaTipoAtual, pessoa, telefone: document.getElementById('dvTelefone').value.trim(),
    valorTotal: valor, valorPago: 0, motivo: document.getElementById('dvMotivo').value.trim(),
    data, vencimento, observacoes: document.getElementById('dvObservacoes').value.trim(),
    parcelado, numParcelas: parcelado ? numParcelas : null
  });

  // Parcelamento: gera automaticamente as parcelas futuras, uma por mês
  if(parcelado){
    const valorParcela = Math.round((valor/numParcelas)*100)/100;
    const dataBase = new Date(vencimento || data);
    for(let i=0;i<numParcelas;i++){
      const venc = new Date(dataBase.getFullYear(), dataBase.getMonth()+i, dataBase.getDate());
      DB.add('parcelas_divida', {
        dividaId: divida.id, numero:i+1, totalParcelas:numParcelas,
        valor: valorParcela, vencimento: venc.toISOString().slice(0,10), status:'pendente'
      });
    }
  }

  fecharModal('modalDivida');
  renderListaDividas();
  renderDashboard();
});

let filtroDividaAtual = 'devo';
document.querySelectorAll('#segDividaFiltro button').forEach(b=>{
  b.addEventListener('click', ()=>{
    filtroDividaAtual = b.dataset.filtro;
    document.querySelectorAll('#segDividaFiltro button').forEach(x=>x.classList.toggle('active', x===b));
    renderListaDividas();
  });
});

function renderListaDividas(){
  const dividas = DB.get('dividas').filter(d=>d.tipo===filtroDividaAtual);
  const list = document.getElementById('dividasList');
  if(dividas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma dívida por aqui.</div>';
    return;
  }
  const todasParcelas = DB.get('parcelas_divida');
  list.innerHTML = dividas.map(d=>{
    const restante = (d.valorTotal||0) - (d.valorPago||0);
    const quitada = restante <= 0;
    const emoji = d.tipo==='devo' ? '📤' : '📥';
    const parcelasInfo = d.parcelado ? `parcelado em ${d.numParcelas}x` : null;
    const metaTxt = [d.motivo, parcelasInfo, (!d.parcelado && d.vencimento) ? ('vence '+new Date(d.vencimento).toLocaleDateString('pt-BR')) : null].filter(Boolean).join(' · ');

    let parcelasHtml = '';
    if(d.parcelado){
      const parcelas = todasParcelas.filter(p=>p.dividaId===d.id).sort((a,b)=>a.numero-b.numero);
      parcelasHtml = `<div style="width:100%; margin-top:10px; padding-top:10px; border-top:1px dashed var(--stone-dark); display:flex; flex-direction:column; gap:6px;">` +
        parcelas.map(p=>{
          const paga = p.status==='paga';
          return `<div style="display:flex; align-items:center; justify-content:space-between; font-size:12.5px;">
            <span>${paga?'✅':'⏳'} Parcela ${p.numero}/${p.totalParcelas} · ${new Date(p.vencimento).toLocaleDateString('pt-BR')}</span>
            <span style="display:flex; align-items:center; gap:8px;">
              <strong>${money(p.valor)}</strong>
              ${paga?'':`<button data-parcela="${p.id}" style="font-size:11px; color:var(--rose-deep); font-weight:700; background:none; border:none; cursor:pointer;">Marcar paga</button>`}
            </span>
          </div>`;
        }).join('') + `</div>`;
    }

    return `<div class="tx-item" style="flex-wrap:wrap;">
      <div class="tx-left">
        <div class="tx-emoji">${emoji}</div>
        <div class="tx-info">
          <div class="tx-desc">${d.pessoa}</div>
          <div class="tx-meta">${metaTxt || '—'}</div>
        </div>
      </div>
      <div class="tx-right" style="flex-direction:column; align-items:flex-end; gap:4px;">
        <div class="tx-value ${quitada?'pos':'neg'}">${quitada?'Quitada':money(restante)+' rest.'}</div>
        ${(quitada||d.parcelado)?'':`<button class="tx-del" data-id="${d.id}" data-action="pagar" style="font-size:11px; color:var(--rose-deep); font-weight:700;">Registrar pagamento</button>`}
        <button class="tx-del" data-id="${d.id}" data-action="excluir">🗑️</button>
      </div>
      ${parcelasHtml}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-action="pagar"]').forEach(btn=>{
    btn.addEventListener('click', ()=> registrarPagamentoDivida(btn.dataset.id));
  });
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta dívida? As parcelas relacionadas também serão removidas.')) return;
      DB.save('dividas', DB.get('dividas').filter(d=>d.id!==btn.dataset.id));
      DB.save('parcelas_divida', DB.get('parcelas_divida').filter(p=>p.dividaId!==btn.dataset.id));
      renderListaDividas();
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-parcela]').forEach(btn=>{
    btn.addEventListener('click', ()=> marcarParcelaDividaPaga(btn.dataset.parcela));
  });
}

function marcarParcelaDividaPaga(parcelaId){
  const parcelas = DB.get('parcelas_divida');
  const p = parcelas.find(x=>x.id===parcelaId);
  if(!p || p.status==='paga') return;
  p.status = 'paga';
  DB.save('parcelas_divida', parcelas);
  const dividas = DB.get('dividas');
  const d = dividas.find(x=>x.id===p.dividaId);
  if(d){
    d.valorPago = Math.min(d.valorTotal, (d.valorPago||0) + p.valor);
    DB.save('dividas', dividas);
  }
  renderListaDividas();
  renderDashboard();
}

function registrarPagamentoDivida(id){
  const dividas = DB.get('dividas');
  const d = dividas.find(x=>x.id===id);
  if(!d) return;
  const restante = (d.valorTotal||0) - (d.valorPago||0);
  const valorStr = prompt(`Valor recebido/pago agora (restam ${money(restante)}):`, restante.toFixed(2));
  if(valorStr===null) return;
  const valor = parseFloat(valorStr.replace(',','.'));
  if(!valor || valor<=0) return;
  d.valorPago = Math.min(d.valorTotal, (d.valorPago||0) + valor);
  DB.save('dividas', dividas);
  renderListaDividas();
  renderDashboard();
}

/* ================================================================
   MODAL: CAIXINHA
   ================================================================ */
function abrirModalCaixinha(){
  ['cxNome','cxObjetivo','cxValorAtual','cxValorMeta'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('modalCaixinha').classList.add('open');
}

document.getElementById('btnSalvarCaixinha').addEventListener('click', ()=>{
  const nome = document.getElementById('cxNome').value.trim();
  const valorMeta = parseFloat(document.getElementById('cxValorMeta').value);
  const valorAtual = parseFloat(document.getElementById('cxValorAtual').value) || 0;
  if(!nome || !valorMeta || valorMeta<=0){ alert('Informe o nome e a meta.'); return; }
  DB.add('caixinhas', { nome, objetivo: document.getElementById('cxObjetivo').value.trim(), valorAtual, valorMeta });
  fecharModal('modalCaixinha');
  renderListaCaixinhas();
  renderDashboard();
});

function renderListaCaixinhas(){
  const caixinhas = DB.get('caixinhas');
  const list = document.getElementById('caixinhasList');
  if(caixinhas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma caixinha ainda. Toque no + para criar sua primeira meta.</div>';
    return;
  }
  list.innerHTML = caixinhas.map(c=>{
    const pct = c.valorMeta>0 ? Math.min(100, Math.round((c.valorAtual/c.valorMeta)*100)) : 0;
    return `<div class="card-visual" style="background:linear-gradient(135deg, var(--rose-deep), var(--sun-deep));">
      <button class="cv-del" data-id="${c.id}" data-action="excluir" title="Excluir">✕</button>
      <div class="cv-top"><span>🐷 CAIXINHA</span><span>${pct}%</span></div>
      <div class="cv-nome">${c.nome}</div>
      <div class="cv-limite">${money(c.valorAtual)} <span style="font-size:12px;font-weight:600;opacity:0.8;">de ${money(c.valorMeta)}</span></div>
      <div class="cv-bar"><div class="cv-bar-fill" style="width:${pct}%"></div></div>
      <div class="cv-foot">
        <span>${c.objetivo||'Sem objetivo definido'}</span>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button data-id="${c.id}" data-action="depositar" style="flex:1; background:rgba(255,255,255,0.22); border:none; color:#fff; padding:8px; border-radius:10px; font-weight:700; font-size:12.5px; cursor:pointer;">+ Depositar</button>
        <button data-id="${c.id}" data-action="resgatar" style="flex:1; background:rgba(255,255,255,0.22); border:none; color:#fff; padding:8px; border-radius:10px; font-weight:700; font-size:12.5px; cursor:pointer;">- Resgatar</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-action="depositar"]').forEach(btn=> btn.addEventListener('click', ()=> movimentarCaixinha(btn.dataset.id, 1)));
  list.querySelectorAll('[data-action="resgatar"]').forEach(btn=> btn.addEventListener('click', ()=> movimentarCaixinha(btn.dataset.id, -1)));
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta caixinha?')) return;
      DB.save('caixinhas', DB.get('caixinhas').filter(c=>c.id!==btn.dataset.id));
      renderListaCaixinhas();
      renderDashboard();
    });
  });
}

function movimentarCaixinha(id, sinal){
  const caixinhas = DB.get('caixinhas');
  const c = caixinhas.find(x=>x.id===id);
  if(!c) return;
  const valorStr = prompt(sinal>0 ? 'Quanto deseja depositar?' : 'Quanto deseja resgatar?', '');
  if(valorStr===null) return;
  const valor = parseFloat(valorStr.replace(',','.'));
  if(!valor || valor<=0) return;
  c.valorAtual = Math.max(0, c.valorAtual + sinal*valor);
  DB.save('caixinhas', caixinhas);
  renderListaCaixinhas();
  renderDashboard();
}

/* ================================================================
   MODAL: INVESTIMENTO
   ================================================================ */
function abrirModalInvestimento(){
  ['ivNome','ivValorAplicado','ivValorAtual'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('ivTipo').selectedIndex = 0;
  document.getElementById('modalInvestimento').classList.add('open');
}

document.getElementById('btnSalvarInvestimento').addEventListener('click', ()=>{
  const nome = document.getElementById('ivNome').value.trim();
  const valorAtual = parseFloat(document.getElementById('ivValorAtual').value);
  const valorAplicado = parseFloat(document.getElementById('ivValorAplicado').value) || valorAtual;
  if(!nome || !valorAtual || valorAtual<=0){ alert('Informe o nome e o valor atual.'); return; }
  DB.add('investimentos', { tipo: document.getElementById('ivTipo').value, nome, valorAtual, valorAplicado });
  fecharModal('modalInvestimento');
  renderListaInvestimentos();
  renderDashboard();
});

const EMOJI_INVESTIMENTO = {
  'Tesouro Direto':'🏛️', 'CDB':'🏦', 'Fundos Imobiliários':'🏢',
  'Ações':'📈', 'Poupança':'🐖', 'Outros':'💼'
};

function renderListaInvestimentos(){
  const investimentos = DB.get('investimentos');
  document.getElementById('totalInvestidoLabel').textContent = money(investimentos.reduce((s,i)=>s+(i.valorAtual||0),0));
  const list = document.getElementById('investimentosList');
  if(investimentos.length===0){
    list.innerHTML = '<div class="empty-note">Nenhum investimento cadastrado ainda.</div>';
    return;
  }
  list.innerHTML = investimentos.map(i=>{
    const rendimento = (i.valorAtual||0) - (i.valorAplicado||0);
    return `<div class="tx-item">
      <div class="tx-left">
        <div class="tx-emoji">${EMOJI_INVESTIMENTO[i.tipo]||'💼'}</div>
        <div class="tx-info">
          <div class="tx-desc">${i.nome}</div>
          <div class="tx-meta">${i.tipo} · ${rendimento>=0?'+':''}${money(rendimento)}</div>
        </div>
      </div>
      <div class="tx-right">
        <div class="tx-value pos">${money(i.valorAtual)}</div>
        <button class="tx-del" data-id="${i.id}" title="Excluir">🗑️</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.tx-del').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir este investimento?')) return;
      DB.save('investimentos', DB.get('investimentos').filter(i=>i.id!==btn.dataset.id));
      renderListaInvestimentos();
      renderDashboard();
    });
  });
}

/* ================================================================
   CALENDÁRIO
   Reúne parcelas de cartão, parcelas de dívida, contas fixas,
   transações (receitas/despesas) e aniversários em uma agenda.
   ================================================================ */
let calRef = new Date();
let calDiaSelecionado = null;

document.getElementById('calPrev').addEventListener('click', ()=>{ calRef.setMonth(calRef.getMonth()-1); renderCalendario(); });
document.getElementById('calNext').addEventListener('click', ()=>{ calRef.setMonth(calRef.getMonth()+1); renderCalendario(); });

document.getElementById('btnAddAniversario').addEventListener('click', ()=>{
  const nome = prompt('Nome do aniversariante:');
  if(!nome) return;
  const data = prompt('Data de nascimento (AAAA-MM-DD):', new Date().toISOString().slice(0,10));
  if(!data) return;
  DB.add('aniversarios', { nome: nome.trim(), data });
  renderCalendario();
});

function coletarEventosDoDia(dateStr){
  const eventos = [];
  const [ano,mes,dia] = dateStr.split('-').map(Number);

  DB.get('transacoes').filter(t=>t.data===dateStr).forEach(t=>{
    eventos.push({ tipo:t.tipo==='receita'?'receita':'despesa', label:(t.descricao||t.categoria), valor:t.valor, cor:t.tipo==='receita'?'var(--green)':'var(--plum-soft)' });
  });

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const diaData = new Date(ano, mes-1, dia);

  DB.get('parcelas').filter(p=>p.vencimento===dateStr && p.status!=='pago').forEach(p=>{
    const cartao = DB.get('cartoes').find(c=>c.id===p.cartaoId);
    eventos.push({ tipo:'conta', label:`Parcela ${p.numero}/${p.totalParcelas}${cartao?' · '+cartao.nome:''}`, valor:p.valor, cor: diaData<hoje?'var(--red)':'var(--rose-deep)' });
  });

  DB.get('parcelas_divida').filter(p=>p.vencimento===dateStr && p.status!=='paga').forEach(p=>{
    const divida = DB.get('dividas').find(d=>d.id===p.dividaId);
    if(!divida || divida.tipo!=='devo') return;
    eventos.push({ tipo:'conta', label:`Parcela ${p.numero}/${p.totalParcelas} · ${divida.pessoa}`, valor:p.valor, cor: diaData<hoje?'var(--red)':'var(--rose-deep)' });
  });

  DB.get('parcelas_fixas').filter(p=>p.vencimento===dateStr && p.status!=='pago').forEach(p=>{
    const cf = DB.get('contas_fixas').find(c=>c.id===p.contaFixaId);
    eventos.push({ tipo:'conta', label:cf?cf.nome:'Conta fixa', valor:p.valor, cor: diaData<hoje?'var(--red)':'var(--rose-deep)' });
  });

  DB.get('aniversarios').forEach(a=>{
    const [,am,ad] = a.data.split('-').map(Number);
    if(am===mes && ad===dia) eventos.push({ tipo:'aniversario', label:'🎂 ' + a.nome, valor:null, cor:'var(--sun-deep)' });
  });

  return eventos;
}

function renderCalendario(){
  const ano = calRef.getFullYear(), mes = calRef.getMonth();
  document.getElementById('calMesLabel').textContent = calRef.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });

  const primeiroDia = new Date(ano, mes, 1);
  const offset = primeiroDia.getDay();
  const diasNoMes = new Date(ano, mes+1, 0).getDate();
  const hojeStr = new Date().toISOString().slice(0,10);

  let celulas = [];
  for(let i=0;i<offset;i++) celulas.push(null);
  for(let d=1; d<=diasNoMes; d++) celulas.push(d);

  const grid = document.getElementById('calGrid');
  grid.innerHTML = celulas.map(d=>{
    if(!d) return '<div class="cal-day other-month"></div>';
    const dateStr = ano+'-'+String(mes+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const eventos = coletarEventosDoDia(dateStr);
    const cores = [...new Set(eventos.map(e=>e.cor))].slice(0,3);
    const isToday = dateStr===hojeStr;
    const isSel = dateStr===calDiaSelecionado;
    return `<div class="cal-day ${isToday?'today':''} ${isSel?'selected':''}" data-date="${dateStr}">
      <span>${d}</span>
      <div class="cal-dots">${cores.map(c=>`<span style="background:${c}"></span>`).join('')}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.cal-day[data-date]').forEach(cel=>{
    cel.addEventListener('click', ()=>{ calDiaSelecionado = cel.dataset.date; renderCalendario(); renderAgendaDia(cel.dataset.date); });
  });

  if(calDiaSelecionado) renderAgendaDia(calDiaSelecionado);
}

function renderAgendaDia(dateStr){
  const eventos = coletarEventosDoDia(dateStr);
  document.getElementById('calAgendaLabel').textContent = 'Eventos em ' + new Date(dateStr+'T00:00:00').toLocaleDateString('pt-BR');
  const list = document.getElementById('calAgendaList');
  if(eventos.length===0){
    list.innerHTML = '<div class="empty-note">Nada por aqui neste dia.</div>';
    return;
  }
  list.innerHTML = eventos.map(e=>`<div class="resumo-item">
    <span class="tag"><span style="width:8px;height:8px;border-radius:50%;background:${e.cor};display:inline-block;"></span> ${e.label}</span>
    <span class="amt">${e.valor!=null ? money(e.valor) : ''}</span>
  </div>`).join('');
}

/* ================================================================
   NOTIFICAÇÕES
   Central em app (sino) sempre disponível + notificações reais do
   navegador (Notification API) quando o usuário autoriza. Como é
   uma página local, os alertas do navegador disparam enquanto o
   app estiver aberto; para alertas em segundo plano seria preciso
   publicar isto como PWA com service worker.
   ================================================================ */
function coletarAlertas(){
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const amanha = new Date(hoje); amanha.setDate(amanha.getDate()+1);
  const alertas = [];

  function classificar(venc){
    const d = new Date(venc+'T00:00:00');
    if(d < hoje) return 'vencida';
    if(d.getTime()===hoje.getTime()) return 'hoje';
    if(d.getTime()===amanha.getTime()) return 'amanha';
    return null;
  }

  DB.get('parcelas').filter(p=>p.status!=='pago').forEach(p=>{
    const st = classificar(p.vencimento);
    if(st){
      const cartao = DB.get('cartoes').find(c=>c.id===p.cartaoId);
      alertas.push({ id:'parc-'+p.id, status:st, texto:`Parcela ${p.numero}/${p.totalParcelas}${cartao?' · '+cartao.nome:''}`, valor:p.valor });
    }
  });
  DB.get('parcelas_divida').filter(p=>p.status!=='paga').forEach(p=>{
    const divida = DB.get('dividas').find(d=>d.id===p.dividaId);
    if(!divida || divida.tipo!=='devo') return;
    const st = classificar(p.vencimento);
    if(st) alertas.push({ id:'pdiv-'+p.id, status:st, texto:`Parcela ${p.numero}/${p.totalParcelas} · ${divida.pessoa}`, valor:p.valor });
  });
  DB.get('parcelas_fixas').filter(p=>p.status!=='pago').forEach(p=>{
    const st = classificar(p.vencimento);
    if(st){
      const cf = DB.get('contas_fixas').find(c=>c.id===p.contaFixaId);
      alertas.push({ id:'fixa-'+p.id, status:st, texto: cf?cf.nome:'Conta fixa', valor:p.valor });
    }
  });

  const ordem = { vencida:0, hoje:1, amanha:2 };
  return alertas.sort((a,b)=>ordem[a.status]-ordem[b.status]);
}

const STATUS_LABEL = { vencida:'⚠️ Vencida', hoje:'🔴 Vence hoje', amanha:'🟡 Vence amanhã' };

function renderNotificacoes(){
  const alertas = coletarAlertas();
  const badge = document.getElementById('sinoBadge');
  if(alertas.length===0){ badge.classList.add('hidden'); }
  else { badge.textContent = alertas.length>9?'9+':alertas.length; badge.classList.remove('hidden'); }

  const list = document.getElementById('listaNotificacoes');
  if(alertas.length===0){
    list.innerHTML = '<div class="empty-note">Tudo em dia por aqui 🌸</div>';
    return;
  }
  list.innerHTML = alertas.map(a=>`<div class="resumo-item">
    <span class="tag">${STATUS_LABEL[a.status]} · ${a.texto}</span>
    <span class="amt">${money(a.valor)}</span>
  </div>`).join('');
}

document.getElementById('btnSino').addEventListener('click', ()=>{
  document.getElementById('painelNotificacoes').classList.toggle('hidden');
});
document.addEventListener('click', (e)=>{
  const painel = document.getElementById('painelNotificacoes');
  if(!painel.classList.contains('hidden') && !painel.contains(e.target) && e.target.id!=='btnSino' && !e.target.closest('#btnSino')){
    painel.classList.add('hidden');
  }
});

document.getElementById('btnAtivarNotif').addEventListener('click', ()=>{
  if(!('Notification' in window)){ alert('Este navegador não suporta notificações.'); return; }
  Notification.requestPermission().then(perm=>{
    if(perm==='granted'){ alert('Notificações ativadas! Você será avisado sobre contas do dia e atrasadas enquanto o app estiver aberto.'); dispararNotificacoesNavegador(); }
  });
});

function dispararNotificacoesNavegador(){
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  const hojeStr = new Date().toISOString().slice(0,10);
  const jaEnviadas = JSON.parse(localStorage.getItem('financeiro_notif_enviadas_'+hojeStr) || '[]');
  const urgentes = coletarAlertas().filter(a=>a.status==='vencida'||a.status==='hoje');
  const novas = urgentes.filter(a=>!jaEnviadas.includes(a.id));
  novas.forEach(a=>{
    new Notification(a.status==='vencida' ? '⚠️ Conta vencida' : '🔔 Vence hoje', { body: `${a.texto} — ${money(a.valor)}` });
  });
  if(novas.length){
    localStorage.setItem('financeiro_notif_enviadas_'+hojeStr, JSON.stringify([...jaEnviadas, ...novas.map(n=>n.id)]));
  }
}

/* ================================================================
   CALCULADORA FINANCEIRA
   ================================================================ */
let calcModoAtual = 'soma';
function calcSetModo(modo){
  calcModoAtual = modo;
  document.querySelectorAll('#segCalcModo button, #segCalcModo2 button').forEach(b=> b.classList.toggle('active', b.dataset.modo===modo));
  ['calcSoma','calcPercentual','calcDesconto','calcJurosSimples','calcJurosCompostos','calcDividir'].forEach(id=>{});
  document.getElementById('calcSoma').classList.toggle('hidden', modo!=='soma');
  document.getElementById('calcSubtracao').classList.toggle('hidden', modo!=='subtracao');
  document.getElementById('calcPercentual').classList.toggle('hidden', modo!=='percentual');
  document.getElementById('calcDesconto').classList.toggle('hidden', modo!=='desconto');
  document.getElementById('calcJurosSimples').classList.toggle('hidden', modo!=='jurossimples');
  document.getElementById('calcJurosCompostos').classList.toggle('hidden', modo!=='juroscompostos');
  document.getElementById('calcDividir').classList.toggle('hidden', modo!=='dividir');
}
document.querySelectorAll('#segCalcModo button, #segCalcModo2 button').forEach(b=>{
  b.addEventListener('click', ()=> calcSetModo(b.dataset.modo));
});

function calcAddSomaLinha(){
  const wrap = document.getElementById('calcSomaLinhas');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px;';
  row.innerHTML = `<input type="number" step="0.01" placeholder="0,00" class="calc-soma-input" style="flex:1; padding:11px 13px; border-radius:10px; border:1.5px solid var(--stone-dark); background:var(--cream); font-family:'Manrope',sans-serif; font-size:14px;">
    <button data-remove style="background:var(--stone); border:none; border-radius:10px; width:38px; font-size:14px; cursor:pointer; color:var(--plum-soft);">✕</button>`;
  wrap.appendChild(row);
  row.querySelector('input').addEventListener('input', calcAtualizarSoma);
  row.querySelector('[data-remove]').addEventListener('click', ()=>{ row.remove(); calcAtualizarSoma(); });
}
document.getElementById('calcSomaAdd').addEventListener('click', calcAddSomaLinha);
function calcAtualizarSoma(){
  const total = [...document.querySelectorAll('.calc-soma-input')].reduce((s,i)=> s + (parseFloat(i.value)||0), 0);
  document.getElementById('calcSomaResultado').textContent = money(total);
}

function calcAddSubLinha(){
  const wrap = document.getElementById('calcSubLinhas');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px;';
  row.innerHTML = `<input type="number" step="0.01" placeholder="0,00" class="calc-sub-input" style="flex:1; padding:11px 13px; border-radius:10px; border:1.5px solid var(--stone-dark); background:var(--cream); font-family:'Manrope',sans-serif; font-size:14px;">
    <button data-remove style="background:var(--stone); border:none; border-radius:10px; width:38px; font-size:14px; cursor:pointer; color:var(--plum-soft);">✕</button>`;
  wrap.appendChild(row);
  row.querySelector('input').addEventListener('input', calcAtualizarSubtracao);
  row.querySelector('[data-remove]').addEventListener('click', ()=>{ row.remove(); calcAtualizarSubtracao(); });
}
document.getElementById('calcSubAdd').addEventListener('click', calcAddSubLinha);
document.getElementById('subValorInicial').addEventListener('input', calcAtualizarSubtracao);
function calcAtualizarSubtracao(){
  const inicial = parseFloat(document.getElementById('subValorInicial').value)||0;
  const totalSubtrair = [...document.querySelectorAll('.calc-sub-input')].reduce((s,i)=> s + (parseFloat(i.value)||0), 0);
  document.getElementById('calcSubResultado').textContent = money(inicial - totalSubtrair);
}

function calcNum(id){ return parseFloat(document.getElementById(id).value) || 0; }

['pctPercentual','pctValor'].forEach(id=> document.getElementById(id).addEventListener('input', ()=>{
  const resultado = calcNum('pctValor') * (calcNum('pctPercentual')/100);
  document.getElementById('pctResultado').textContent = money(resultado);
}));

['dscValor','dscPercentual'].forEach(id=> document.getElementById(id).addEventListener('input', ()=>{
  const valor = calcNum('dscValor'), pct = calcNum('dscPercentual');
  const economia = valor * (pct/100);
  document.getElementById('dscResultado').textContent = money(valor - economia);
  document.getElementById('dscEconomia').textContent = money(economia);
}));

['jsCapital','jsTaxa','jsPeriodo'].forEach(id=> document.getElementById(id).addEventListener('input', ()=>{
  const c = calcNum('jsCapital'), i = calcNum('jsTaxa')/100, t = calcNum('jsPeriodo');
  const juros = c*i*t;
  document.getElementById('jsResultado').textContent = money(c+juros);
  document.getElementById('jsJuros').textContent = money(juros);
}));

['jcCapital','jcTaxa','jcPeriodo'].forEach(id=> document.getElementById(id).addEventListener('input', ()=>{
  const c = calcNum('jcCapital'), i = calcNum('jcTaxa')/100, t = calcNum('jcPeriodo');
  const montante = c*Math.pow(1+i, t);
  document.getElementById('jcResultado').textContent = money(montante);
  document.getElementById('jcJuros').textContent = money(montante-c);
}));

['dvdValor','dvdPessoas','dvdTaxa'].forEach(id=> document.getElementById(id).addEventListener('input', ()=>{
  const valor = calcNum('dvdValor'), pessoas = Math.max(1, calcNum('dvdPessoas')||1), taxa = calcNum('dvdTaxa');
  const totalComTaxa = valor * (1 + taxa/100);
  document.getElementById('dvdResultado').textContent = money(totalComTaxa/pessoas);
}));

/* ================================================================
   SNAPSHOT DE PATRIMÔNIO
   Guarda um ponto por dia para alimentar os gráficos de evolução
   (dashboard e relatórios) com histórico real ao longo do tempo.
   ================================================================ */
function registrarSnapshotPatrimonio(valor){
  const hojeStr = new Date().toISOString().slice(0,10);
  const historico = DB.get('historico_patrimonio');
  const existente = historico.find(h=>h.data===hojeStr);
  if(existente){
    if(existente.valor === valor) return; // já está gravado — evita reescrever e realimentar o listener
    existente.valor = valor;
  } else {
    historico.push({ data:hojeStr, valor });
  }
  DB.save('historico_patrimonio', historico);
}

/* ================================================================
   INSIGHTS (Inteligência financeira)
   Analisa os dados já calculados e aponta padrões relevantes.
   ================================================================ */
function renderInsights(d){
  const insights = [];

  // Categoria que mais cresceu em relação ao mês anterior
  let maiorAumento = null;
  Object.keys(d.porCategoria).forEach(cat=>{
    const atual = d.porCategoria[cat];
    const anterior = d.porCategoriaMesAnterior[cat] || 0;
    if(anterior>0 && atual > anterior*1.2){
      const aumentoPct = Math.round(((atual-anterior)/anterior)*100);
      if(!maiorAumento || aumentoPct>maiorAumento.pct) maiorAumento = { cat, pct:aumentoPct };
    }
  });
  if(maiorAumento){
    insights.push(`📈 Você gastou <strong>${maiorAumento.pct}% a mais</strong> com <strong>${maiorAumento.cat}</strong> em relação ao mês passado.`);
  }

  // Limite de cartão quase esgotado
  (d.cartoes||[]).forEach(c=>{
    if(c.limite>0 && (c.limiteDisponivel/c.limite) < 0.15){
      insights.push(`💳 O limite do cartão <strong>${c.nome}</strong> está quase esgotado (${Math.round((c.limiteDisponivel/c.limite)*100)}% disponível).`);
    }
  });

  // Gasto do mês acima da média
  if(d.mediaGastoMesesAnteriores>0 && d.gastoMes > d.mediaGastoMesesAnteriores*1.1){
    const pct = Math.round(((d.gastoMes-d.mediaGastoMesesAnteriores)/d.mediaGastoMesesAnteriores)*100);
    insights.push(`⚠️ Você já ultrapassou sua média mensal de gastos em <strong>${pct}%</strong>.`);
  }

  // Contas vencidas
  if(d.contasVencidas>0){
    insights.push(`🔴 Você tem <strong>${money(d.contasVencidas)}</strong> em contas vencidas — dá uma olhada no sino de notificações.`);
  }

  const panel = document.getElementById('insightsPanel');
  if(insights.length===0){
    panel.innerHTML = '<div class="empty-note">Sem avisos por enquanto — continue registrando seus lançamentos 🌸</div>';
  } else {
    panel.innerHTML = insights.map(txt=>`<div class="resumo-item" style="border-bottom:1px solid var(--stone);"><span class="tag" style="font-weight:500;">${txt}</span></div>`).join('');
  }
}

/* ================================================================
   RELATÓRIOS
   ================================================================ */
function renderRelatorios(){
  const transacoes = DB.get('transacoes');
  const hoje = new Date();

  // Receitas x Despesas — últimos 6 meses
  const labels = [], receitas = [], despesas = [];
  for(let i=5;i>=0;i--){
    const ref = new Date(hoje.getFullYear(), hoje.getMonth()-i, 1);
    labels.push(ref.toLocaleDateString('pt-BR', { month:'short' }));
    const doMes = transacoes.filter(t=>{
      const dt = new Date(t.data);
      return dt.getMonth()===ref.getMonth() && dt.getFullYear()===ref.getFullYear();
    });
    receitas.push(doMes.filter(t=>t.tipo==='receita').reduce((s,t)=>s+t.valor,0));
    despesas.push(doMes.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+t.valor,0));
  }
  criarGrafico('chartReceitasDespesas', {
    type:'bar',
    data:{ labels, datasets:[
      { label:'Receitas', data:receitas, backgroundColor:'#7BAE8F', borderRadius:6 },
      { label:'Despesas', data:despesas, backgroundColor:'#E58AA6', borderRadius:6 }
    ]},
    options:{ maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{ size:11 } } } }, scales:{ y:{ beginAtZero:true } } }
  });

  // Gastos por cartão — mês atual
  const mesAtual = hoje.getMonth(), anoAtual = hoje.getFullYear();
  const despesasMes = transacoes.filter(t=>{
    const dt = new Date(t.data);
    return t.tipo==='despesa' && t.cartaoId && dt.getMonth()===mesAtual && dt.getFullYear()===anoAtual;
  });
  const porCartao = {};
  despesasMes.forEach(t=>{ porCartao[t.cartaoId] = (porCartao[t.cartaoId]||0) + t.valor; });
  const cartaoNote = document.getElementById('chartCartoesEmptyNote');
  if(Object.keys(porCartao).length===0){
    cartaoNote.style.display = 'block';
  } else {
    cartaoNote.style.display = 'none';
    const cartoes = DB.get('cartoes');
    const labelsCartao = Object.keys(porCartao).map(id=>{
      const c = cartoes.find(x=>x.id===id);
      return c ? (c.banco+' · '+c.nome) : 'Cartão';
    });
    criarGrafico('chartGastosCartao', {
      type:'doughnut',
      data:{ labels:labelsCartao, datasets:[{ data:Object.values(porCartao), backgroundColor:['#4A3A42','#E58AA6','#FBE7A1','#8A7680','#7BAE8F'], borderWidth:0 }] },
      options:{ maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{ size:11 } } } } }
    });
  }

  // Evolução patrimonial completa
  const historico = DB.get('historico_patrimonio').sort((a,b)=>a.data.localeCompare(b.data));
  const patNote = document.getElementById('chartPatrimonioEmptyNote');
  if(historico.length<2){
    patNote.style.display = 'block';
  } else {
    patNote.style.display = 'none';
    criarGrafico('chartPatrimonioHistorico', {
      type:'line',
      data:{ labels:historico.map(h=>new Date(h.data+'T00:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})),
        datasets:[{ label:'Patrimônio', data:historico.map(h=>h.valor), borderColor:'#E58AA6', backgroundColor:'rgba(229,138,166,0.15)', fill:true, tension:0.4 }] },
      options:{ maintainAspectRatio:false, plugins:{ legend:{ display:false } } }
    });
  }
}

/* ================================================================
   CATEGORIAS EDITÁVEIS
   ================================================================ */
document.getElementById('btnAddCategoria').addEventListener('click', ()=>{
  const nome = document.getElementById('catNovoNome').value.trim();
  const emoji = document.getElementById('catNovoEmoji').value.trim() || '🏷️';
  if(!nome){ alert('Digite o nome da categoria.'); return; }
  DB.add('categorias', { tipo:'despesa', nome, emoji });
  document.getElementById('catNovoNome').value = '';
  document.getElementById('catNovoEmoji').value = '';
  renderListaCategorias();
});

function renderListaCategorias(){
  const categorias = DB.get('categorias');
  const list = document.getElementById('categoriasList');
  list.innerHTML = categorias.map(c=>`<div class="tx-item">
    <div class="tx-left">
      <div class="tx-emoji">${c.emoji}</div>
      <div class="tx-info"><div class="tx-desc">${c.nome}</div></div>
    </div>
    <div class="tx-right">
      <button class="tx-del" data-id="${c.id}" data-action="renomear" title="Renomear">✏️</button>
      <button class="tx-del" data-id="${c.id}" data-action="excluir" title="Excluir">🗑️</button>
    </div>
  </div>`).join('');
  list.querySelectorAll('[data-action="renomear"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const categorias = DB.get('categorias');
      const c = categorias.find(x=>x.id===btn.dataset.id);
      if(!c) return;
      const novoNome = prompt('Novo nome da categoria:', c.nome);
      if(!novoNome) return;
      const novoEmoji = prompt('Novo emoji (opcional):', c.emoji) || c.emoji;
      c.nome = novoNome.trim(); c.emoji = novoEmoji.trim();
      DB.save('categorias', categorias);
      renderListaCategorias();
    });
  });
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta categoria? Lançamentos já feitos com ela não serão apagados.')) return;
      DB.save('categorias', DB.get('categorias').filter(c=>c.id!==btn.dataset.id));
      renderListaCategorias();
    });
  });
}

/* ================================================================
   MODO ESCURO
   ================================================================ */
function aplicarModoEscuro(ativo){
  document.body.classList.toggle('dark-mode', ativo);
  document.getElementById('toggleModoEscuroTrack').style.background = ativo ? 'var(--rose-deep)' : 'var(--stone-dark)';
  document.getElementById('toggleModoEscuroKnob').style.transform = ativo ? 'translateX(20px)' : 'translateX(0)';
  document.getElementById('toggleModoEscuro').checked = ativo;
  localStorage.setItem('financeiro_tema', ativo ? 'dark' : 'light');
}
document.getElementById('toggleModoEscuro').addEventListener('change', function(){ aplicarModoEscuro(this.checked); });
aplicarModoEscuro(localStorage.getItem('financeiro_tema') === 'dark');

/* ================================================================
   CONTAS BANCÁRIAS
   ================================================================ */
document.getElementById('btnAddContaBancaria').addEventListener('click', ()=>{
  const nome = document.getElementById('cbaNome').value.trim();
  const saldo = parseFloat(document.getElementById('cbaSaldo').value) || 0;
  if(!nome){ alert('Digite o nome da conta.'); return; }
  DB.add('contas_bancarias', { nome, saldo });
  document.getElementById('cbaNome').value = '';
  document.getElementById('cbaSaldo').value = '';
  renderListaContasBancarias();
  renderDashboard();
});

function renderListaContasBancarias(){
  const contas = DB.get('contas_bancarias');
  const list = document.getElementById('contasBancariasList');
  if(contas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma conta cadastrada ainda.</div>';
    return;
  }
  list.innerHTML = contas.map(c=>`<div class="tx-item">
    <div class="tx-left">
      <div class="tx-emoji">🏦</div>
      <div class="tx-info"><div class="tx-desc">${c.nome}</div></div>
    </div>
    <div class="tx-right">
      <div class="tx-value pos">${money(c.saldo)}</div>
      <button class="tx-del" data-id="${c.id}" data-action="editar" title="Editar saldo">✏️</button>
      <button class="tx-del" data-id="${c.id}" data-action="excluir" title="Excluir">🗑️</button>
    </div>
  </div>`).join('');
  list.querySelectorAll('[data-action="editar"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const contas = DB.get('contas_bancarias');
      const c = contas.find(x=>x.id===btn.dataset.id);
      if(!c) return;
      const novoSaldo = prompt('Novo saldo de "'+c.nome+'":', c.saldo);
      if(novoSaldo===null) return;
      c.saldo = parseFloat(novoSaldo.replace(',','.')) || 0;
      DB.save('contas_bancarias', contas);
      renderListaContasBancarias();
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta conta?')) return;
      DB.save('contas_bancarias', DB.get('contas_bancarias').filter(c=>c.id!==btn.dataset.id));
      renderListaContasBancarias();
      renderDashboard();
    });
  });
}

/* ================================================================
   BACKUP: exportar / importar / apagar tudo
   Complementar ao sync automático — útil para uma cópia local extra.
   ================================================================ */
const COLECOES_BACKUP = [
  'contas_bancarias','cartoes','transacoes','parcelas','contas_fixas','parcelas_fixas',
  'dividas','parcelas_divida','caixinhas','investimentos','categorias',
  'historico_patrimonio','aniversarios'
];

document.getElementById('btnExportar').addEventListener('click', ()=>{
  const dump = {};
  COLECOES_BACKUP.forEach(col=> dump[col] = DB.get(col));
  dump.aprendizado_categorias = DB.get('aprendizado_categorias')[0] || {};
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meu-financeiro-backup-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('btnImportar').addEventListener('click', ()=>{
  document.getElementById('inputImportar').click();
});
document.getElementById('inputImportar').addEventListener('change', function(){
  const file = this.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const dump = JSON.parse(e.target.result);
      if(!confirm('Isso vai substituir os dados atuais pelos do arquivo. Continuar?')) return;
      COLECOES_BACKUP.forEach(col=>{
        if(Array.isArray(dump[col])) DB.save(col, dump[col]);
      });
      if(dump.aprendizado_categorias) salvarAprendizadoCategorias(dump.aprendizado_categorias);
      alert('Dados importados com sucesso!');
      location.reload();
    }catch(err){
      alert('Não consegui ler esse arquivo. Confira se é um backup válido.');
    }
  };
  reader.readAsText(file);
  this.value = '';
});

document.getElementById('btnLimparDados').addEventListener('click', ()=>{
  if(!confirm('Isso vai apagar TODOS os dados do app permanentemente neste aparelho. Tem certeza?')) return;
  if(!confirm('Última confirmação: apagar tudo mesmo? Não tem como desfazer.')) return;
  Object.keys(localStorage).filter(k=>k.startsWith('financeiro_')).forEach(k=>localStorage.removeItem(k));
  location.reload();
});

/* ================================================================
   ASSISTENTE FINANCEIRA
   Não é um modelo de linguagem: interpreta a pergunta por padrões
   de palavras-chave e calcula a resposta em cima dos dados reais
   do app (mesmas funções usadas pelo dashboard). Cobre as perguntas
   do escopo e mais algumas variações razoáveis.
   ================================================================ */
const PERGUNTAS_SUGERIDAS = [
  'Quanto posso gastar até o fim do mês?',
  'Quanto gastei em cada categoria?',
  'Quem ainda me deve dinheiro?',
  'Qual cartão tem mais limite disponível?',
  'Quanto falta para minhas metas?',
  'Quanto vou receber este mês?',
  'Quais contas vencem esta semana?'
];

function normalizar(txt){
  return txt.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}

function initAssistente(){
  const chips = document.getElementById('assistenteChips');
  if(chips.children.length===0){
    chips.innerHTML = PERGUNTAS_SUGERIDAS.map(p=>`<button class="chip-pergunta" style="white-space:nowrap; background:var(--stone); border:none; border-radius:999px; padding:8px 14px; font-size:12px; font-weight:700; color:var(--plum-ink); cursor:pointer;">${p}</button>`).join('');
    chips.querySelectorAll('.chip-pergunta').forEach(btn=>{
      btn.addEventListener('click', ()=> enviarPerguntaAssistente(btn.textContent));
    });
  }
  const chat = document.getElementById('assistenteChat');
  if(chat.children.length===0){
    adicionarMensagemAssistente('Oi! Pode me perguntar sobre saldo, gastos por categoria, dívidas, cartões, metas, contas da semana ou até simular uma compra parcelada. 🌸', 'bot');
  }
}

function adicionarMensagemAssistente(texto, quem){
  const chat = document.getElementById('assistenteChat');
  const bolha = document.createElement('div');
  bolha.style.cssText = quem==='user'
    ? 'align-self:flex-end; background:var(--plum-ink); color:var(--sun-soft); padding:10px 14px; border-radius:14px 14px 4px 14px; max-width:82%; font-size:13.5px;'
    : 'align-self:flex-start; background:var(--stone); color:var(--plum-ink); padding:10px 14px; border-radius:14px 14px 14px 4px; max-width:88%; font-size:13.5px; line-height:1.5;';
  bolha.innerHTML = texto;
  chat.appendChild(bolha);
  chat.scrollTop = chat.scrollHeight;
}

document.getElementById('assistenteEnviar').addEventListener('click', ()=>{
  const input = document.getElementById('assistenteInput');
  if(!input.value.trim()) return;
  enviarPerguntaAssistente(input.value.trim());
  input.value = '';
});
document.getElementById('assistenteInput').addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ document.getElementById('assistenteEnviar').click(); }
});

function enviarPerguntaAssistente(pergunta){
  adicionarMensagemAssistente(pergunta, 'user');
  setTimeout(()=> adicionarMensagemAssistente(responderPergunta(pergunta), 'bot'), 200);
}

function responderPergunta(perguntaOriginal){
  const p = normalizar(perguntaOriginal);
  const d = calcularDashboard();

  // 8. Simulação de compra parcelada
  if(p.includes('parcel')){
    const mParcelas = perguntaOriginal.match(/(\d+)\s*(x|vezes|parcelas)/i);
    const numeros = (perguntaOriginal.match(/\d+[.,]?\d*/g)||[]).map(n=>parseFloat(n.replace(',','.')));
    const parcelasQtd = mParcelas ? parseInt(mParcelas[1]) : (numeros.find(n=>n<=48 && Number.isInteger(n) && n>1) || null);
    const valor = numeros.find(n=> n !== parcelasQtd && n>1);
    if(valor && parcelasQtd){
      const valorParcela = valor/parcelasQtd;
      const hoje = new Date();
      let linhas = [];
      for(let i=1;i<=Math.min(parcelasQtd,4);i++){
        const ref = new Date(hoje.getFullYear(), hoje.getMonth()+i, 1);
        const existentes = DB.get('parcelas').filter(pc=>{
          const v = new Date(pc.vencimento);
          return pc.status!=='pago' && v.getMonth()===ref.getMonth() && v.getFullYear()===ref.getFullYear();
        }).reduce((s,pc)=>s+pc.valor,0);
        linhas.push(`${ref.toLocaleDateString('pt-BR',{month:'short'})}: ${money(existentes)} + <strong>${money(valorParcela)}</strong> = ${money(existentes+valorParcela)}`);
      }
      return `Parcelando ${money(valor)} em ${parcelasQtd}x, cada parcela fica em <strong>${money(valorParcela)}</strong>.<br>Impacto nas próximas faturas:<br>${linhas.join('<br>')}${parcelasQtd>4?'<br>...':''}`;
    }
    return 'Me diga o valor e o número de parcelas, ex: "como uma compra de R$600 em 6x afeta minhas faturas?"';
  }

  // 7. Contas que vencem esta semana
  if(p.includes('vence') && (p.includes('semana') || p.includes('proximos dias'))){
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const limite = new Date(hoje); limite.setDate(limite.getDate()+7);
    const itens = [];
    DB.get('parcelas').filter(pc=>pc.status!=='pago').forEach(pc=>{
      const v = new Date(pc.vencimento+'T00:00:00');
      if(v>=hoje && v<=limite) itens.push(`Parcela ${pc.numero}/${pc.totalParcelas} — ${money(pc.valor)} (${v.toLocaleDateString('pt-BR')})`);
    });
    DB.get('parcelas_fixas').filter(pc=>pc.status!=='pago').forEach(pc=>{
      const v = new Date(pc.vencimento+'T00:00:00');
      if(v>=hoje && v<=limite){
        const cf = DB.get('contas_fixas').find(c=>c.id===pc.contaFixaId);
        itens.push(`${cf?cf.nome:'Conta fixa'} — ${money(pc.valor)} (${v.toLocaleDateString('pt-BR')})`);
      }
    });
    if(itens.length===0) return 'Nenhuma conta vence nos próximos 7 dias. 🌸';
    return 'Vencem esta semana:<br>' + itens.join('<br>');
  }

  // 6. Quanto vou receber este mês
  if(p.includes('receber')){
    return `Você já registrou <strong>${money(d.receitaMes)}</strong> em receitas este mês.`;
  }

  // 5. Metas / caixinhas
  if(p.includes('meta') || p.includes('caixinha')){
    const caixinhas = DB.get('caixinhas');
    if(caixinhas.length===0) return 'Você ainda não tem caixinhas cadastradas.';
    const nomeadaAlvo = caixinhas.find(c=> p.includes(normalizar(c.nome)));
    const lista = nomeadaAlvo ? [nomeadaAlvo] : caixinhas;
    return lista.map(c=>{
      const falta = Math.max(0, c.valorMeta - c.valorAtual);
      return falta<=0 ? `🎉 "${c.nome}" já atingiu a meta!` : `Faltam <strong>${money(falta)}</strong> para "${c.nome}" (${money(c.valorAtual)} de ${money(c.valorMeta)}).`;
    }).join('<br>');
  }

  // 4. Cartão com mais limite
  if(p.includes('cartao') && (p.includes('limite') || p.includes('mais'))){
    const cartoes = DB.get('cartoes');
    if(cartoes.length===0) return 'Você ainda não cadastrou nenhum cartão.';
    const melhor = [...cartoes].sort((a,b)=>b.limiteDisponivel-a.limiteDisponivel)[0];
    return `O cartão com mais limite disponível é <strong>${melhor.banco} ${melhor.nome}</strong>, com ${money(melhor.limiteDisponivel)} de ${money(melhor.limite)}.`;
  }

  // 3b. Quanto eu devo
  if(p.includes('eu devo') || (p.includes('devo') && !p.includes('devem'))){
    if(d.devoOutros<=0) return 'Você não tem dívidas pendentes com ninguém. 🌸';
    const lista = DB.get('dividas').filter(dv=>dv.tipo==='devo' && (dv.valorTotal-dv.valorPago)>0)
      .map(dv=>`${dv.pessoa}: ${money(dv.valorTotal-dv.valorPago)}`);
    return `No total você deve <strong>${money(d.devoOutros)}</strong>:<br>${lista.join('<br>')}`;
  }

  // 3. Quem me deve
  if(p.includes('deve') || p.includes('devem')){
    if(d.meDevem<=0) return 'Ninguém te deve dinheiro no momento. 🌸';
    const lista = DB.get('dividas').filter(dv=>dv.tipo==='me_devem' && (dv.valorTotal-dv.valorPago)>0)
      .map(dv=>`${dv.pessoa}: ${money(dv.valorTotal-dv.valorPago)}`);
    return `No total te devem <strong>${money(d.meDevem)}</strong>:<br>${lista.join('<br>')}`;
  }

  // 2. Gastos por categoria
  if(p.includes('categoria')){
    const cats = Object.entries(d.porCategoria).sort((a,b)=>b[1]-a[1]);
    if(cats.length===0) return 'Ainda não há despesas registradas este mês.';
    const categoriaMencionada = DB.get('categorias').find(c=>p.includes(normalizar(c.nome)));
    if(categoriaMencionada){
      const valor = d.porCategoria[categoriaMencionada.nome] || 0;
      return `Você gastou <strong>${money(valor)}</strong> com ${categoriaMencionada.emoji} ${categoriaMencionada.nome} este mês.`;
    }
    return 'Gastos por categoria este mês:<br>' + cats.map(([cat,val])=>`${cat}: ${money(val)}`).join('<br>');
  }

  // 1. Quanto posso gastar até o fim do mês
  if(p.includes('posso gastar') || p.includes('sobra') || (p.includes('gastar') && p.includes('mes'))){
    const disponivelReal = d.saldoDisponivel - d.contasAVencer;
    return `Seu saldo disponível é <strong>${money(d.saldoDisponivel)}</strong>. Descontando as contas que ainda vão vencer (${money(d.contasAVencer)}), sobram cerca de <strong>${money(disponivelReal)}</strong> livres até o fim do mês.`;
  }

  // Quanto gastei (total, sem categoria específica)
  if(p.includes('gastei') || (p.includes('quanto') && p.includes('gast'))){
    return `Você gastou <strong>${money(d.gastoMes)}</strong> este mês.`;
  }

  // Saldo / patrimônio genéricos
  if(p.includes('patrimonio')){
    return `Seu patrimônio total é <strong>${money(d.patrimonio)}</strong>.`;
  }
  if(p.includes('saldo')){
    return `Seu saldo disponível é <strong>${money(d.saldoDisponivel)}</strong>.`;
  }

  return 'Não entendi bem 🌸 Tente perguntar sobre saldo, gastos por categoria, dívidas, cartões, metas, contas da semana, ou simular uma compra parcelada.';
}

renderDashboard();
renderNotificacoes();
if('Notification' in window && Notification.permission==='granted'){ dispararNotificacoesNavegador(); }
