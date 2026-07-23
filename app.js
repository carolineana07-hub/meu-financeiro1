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

/* Calcula pago/restante de uma dívida. Para dívidas parceladas, soma os
   valores reais de cada parcela (que podem ter sido editados individualmente),
   em vez de confiar num valorTotal fixo — assim uma conta "fixa" que varia
   de valor mês a mês continua sendo somada corretamente. */
function restanteEPagoDivida(divida, todasParcelasDivida){
  if(divida.parcelado){
    const parcelas = todasParcelasDivida.filter(p=>p.dividaId===divida.id);
    const pago = parcelas.filter(p=>p.status==='paga').reduce((s,p)=>s+(p.valor||0),0);
    const restante = parcelas.filter(p=>p.status!=='paga').reduce((s,p)=>s+(p.valor||0),0);
    return { pago, restante, total: pago+restante };
  }
  const restante = Math.max(0, (divida.valorTotal||0) - (divida.valorPago||0));
  return { pago: divida.valorPago||0, restante, total: divida.valorTotal||0 };
}

/* Helper de gráficos: o Chart.js exige destruir o gráfico anterior
   antes de desenhar um novo no mesmo <canvas>. */
const chartInstances = {};
function criarGrafico(canvasId, config){
  if(chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(document.getElementById(canvasId), config);
}

/* ================================================================
   PERÍODO SELECIONADO
   Estado global usado por Dashboard, Lançamentos, Relatórios e
   Assistente. "Saldo disponível" (hero) continua sempre o saldo
   real de agora — o que muda com o período são os cartões de
   gasto/receita/contas a vencer/vencidas e os relatórios, porque
   um saldo bancário é um fato do presente, não algo que "varia"
   conforme o mês que você está consultando.
   ================================================================ */
let periodoTipo = 'mes-atual';
let periodoAncora = new Date(); // mês/ano usado quando tipo === 'escolher'
let periodoPersonalizado = { inicio:null, fim:null };

function getPeriodoAtual(){
  const hoje = new Date();
  let inicio, fim, label;
  switch(periodoTipo){
    case 'mes-anterior': {
      const ref = new Date(hoje.getFullYear(), hoje.getMonth()-1, 1);
      inicio = new Date(ref.getFullYear(), ref.getMonth(), 1);
      fim = new Date(ref.getFullYear(), ref.getMonth()+1, 0);
      label = capitalizar(ref.toLocaleDateString('pt-BR', {month:'long', year:'numeric'}));
      break;
    }
    case 'proximo-mes': {
      const ref = new Date(hoje.getFullYear(), hoje.getMonth()+1, 1);
      inicio = new Date(ref.getFullYear(), ref.getMonth(), 1);
      fim = new Date(ref.getFullYear(), ref.getMonth()+1, 0);
      label = capitalizar(ref.toLocaleDateString('pt-BR', {month:'long', year:'numeric'}));
      break;
    }
    case 'escolher': {
      inicio = new Date(periodoAncora.getFullYear(), periodoAncora.getMonth(), 1);
      fim = new Date(periodoAncora.getFullYear(), periodoAncora.getMonth()+1, 0);
      label = capitalizar(periodoAncora.toLocaleDateString('pt-BR', {month:'long', year:'numeric'}));
      break;
    }
    case 'ultimos-3': {
      fim = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0);
      inicio = new Date(hoje.getFullYear(), hoje.getMonth()-2, 1);
      label = 'Últimos 3 meses';
      break;
    }
    case 'ultimos-6': {
      fim = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0);
      inicio = new Date(hoje.getFullYear(), hoje.getMonth()-5, 1);
      label = 'Últimos 6 meses';
      break;
    }
    case 'este-ano': {
      inicio = new Date(hoje.getFullYear(), 0, 1);
      fim = new Date(hoje.getFullYear(), 11, 31);
      label = 'Ano de ' + hoje.getFullYear();
      break;
    }
    case 'personalizado': {
      inicio = periodoPersonalizado.inicio ? new Date(periodoPersonalizado.inicio+'T00:00:00') : new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      fim = periodoPersonalizado.fim ? new Date(periodoPersonalizado.fim+'T00:00:00') : hoje;
      label = inicio.toLocaleDateString('pt-BR') + ' – ' + fim.toLocaleDateString('pt-BR');
      break;
    }
    case 'geral': {
      inicio = new Date(2000,0,1);
      fim = new Date(2100,0,1);
      label = 'Visão geral (acumulado)';
      break;
    }
    default: { // mes-atual
      inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      fim = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0);
      label = 'Este mês';
    }
  }
  fim = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate(), 23,59,59,999);
  return { tipo:periodoTipo, inicio, fim, label };
}

function capitalizar(txt){ return txt.charAt(0).toUpperCase() + txt.slice(1); }

function dataDentroDoPeriodo(dataStr, periodo){
  if(!dataStr) return false;
  const d = new Date(dataStr+'T00:00:00');
  return d >= periodo.inicio && d <= periodo.fim;
}

function aplicarPeriodoNaUI(){
  const p = getPeriodoAtual();
  document.querySelectorAll('.periodo-select').forEach(sel=>{ sel.value = periodoTipo; });
  document.querySelectorAll('.periodo-mesano').forEach(inp=>{
    inp.classList.toggle('hidden', periodoTipo!=='escolher');
    if(periodoTipo==='escolher') inp.value = periodoAncora.getFullYear()+'-'+String(periodoAncora.getMonth()+1).padStart(2,'0');
  });
  document.querySelectorAll('.periodo-de').forEach(inp=>{
    inp.classList.toggle('hidden', periodoTipo!=='personalizado');
    if(periodoTipo==='personalizado' && periodoPersonalizado.inicio) inp.value = periodoPersonalizado.inicio;
  });
  document.querySelectorAll('.periodo-ate').forEach(inp=>{
    inp.classList.toggle('hidden', periodoTipo!=='personalizado');
    if(periodoTipo==='personalizado' && periodoPersonalizado.fim) inp.value = periodoPersonalizado.fim;
  });
  return p;
}

function onPeriodoAlterado(){
  aplicarPeriodoNaUI();
  renderDashboard();
  if(currentView==='lancamentos') renderListaLancamentos();
  if(currentView==='relatorios') renderRelatorios();
  if(currentView==='cartoes') renderListaCartoes();
  if(currentView==='contasfixas') renderListaContasFixas();
  if(currentView==='dividas') renderListaPessoasDividas();
  if(currentView==='divida-pessoa') renderComprasPessoa(pessoaAtualDivida);
  if(currentView==='caixinhas') renderListaCaixinhas();
  if(currentView==='investimentos') renderListaInvestimentos();
  if(typeof atualizarContextoAssistente==='function') atualizarContextoAssistente();
}

document.querySelectorAll('.periodo-select').forEach(sel=>{
  sel.addEventListener('change', function(){
    periodoTipo = this.value;
    onPeriodoAlterado();
  });
});
document.querySelectorAll('.periodo-mesano').forEach(inp=>{
  inp.addEventListener('change', function(){
    if(!this.value) return;
    const [ano, mes] = this.value.split('-').map(Number);
    periodoAncora = new Date(ano, mes-1, 1);
    onPeriodoAlterado();
  });
});
document.querySelectorAll('.periodo-de').forEach(inp=>{
  inp.addEventListener('change', function(){ periodoPersonalizado.inicio = this.value; onPeriodoAlterado(); });
});
document.querySelectorAll('.periodo-ate').forEach(inp=>{
  inp.addEventListener('change', function(){ periodoPersonalizado.fim = this.value; onPeriodoAlterado(); });
});

function calcularDashboard(periodoParam){
  const periodo = periodoParam || getPeriodoAtual();
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

  // "Devo"/"Me devem" são saldos em aberto (ledger corrido) — não mudam
  // conforme o período navegado, só quando uma parcela é paga/editada.
  const devoOutros = dividas.filter(d=>d.tipo==='devo').reduce((s,d)=>s+restanteEPagoDivida(d, parcelasDivida).restante,0);
  const meDevem = dividas.filter(d=>d.tipo==='me_devem').reduce((s,d)=>s+restanteEPagoDivida(d, parcelasDivida).restante,0);

  // Saldo disponível (hero): sempre o mês real de hoje, é um fato do presente.
  const transacoesMesReal = transacoes.filter(t=>{
    const dt = new Date(t.data);
    return dt.getMonth()===mesAtual && dt.getFullYear()===anoAtual;
  });
  const gastoMesReal = transacoesMesReal.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+(t.valor||0),0);
  const receitaMesReal = transacoesMesReal.filter(t=>t.tipo==='receita').reduce((s,t)=>s+(t.valor||0),0);
  const saldoDisponivel = dinheiroConta + receitaMesReal - gastoMesReal;
  const patrimonio = dinheiroConta + totalInvestido + totalCaixinhas;

  // Finanças pessoais (contas a vencer/vencidas) dentro do PERÍODO selecionado.
  // Só consideram compromissos próprios (cartão, contas fixas) — dívidas
  // entre pessoas nunca entram aqui.
  let contasAVencer = 0, contasVencidas = 0;
  [...parcelas, ...parcelasFixas].forEach(p=>{
    if(p.status==='pago') return;
    if(!dataDentroDoPeriodo(p.vencimento, periodo)) return;
    const venc = new Date(p.vencimento);
    if(venc < hoje) contasVencidas += p.valor||0;
    else contasAVencer += p.valor||0;
  });

  // Receita/despesa/categoria do PERÍODO selecionado
  const transacoesPeriodo = transacoes.filter(t=> dataDentroDoPeriodo(t.data, periodo));
  const gastoMes = transacoesPeriodo.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+(t.valor||0),0);
  const receitaMes = transacoesPeriodo.filter(t=>t.tipo==='receita').reduce((s,t)=>s+(t.valor||0),0);

  const porCategoria = {};
  transacoesPeriodo.filter(t=>t.tipo==='despesa').forEach(t=>{
    porCategoria[t.categoria] = (porCategoria[t.categoria]||0) + t.valor;
  });

  // Terceiros: quanto está previsto entrar/sair NESTE período (parcelas de dívida com vencimento no período)
  const previstoReceberPeriodo = parcelasDivida.filter(p=>{
    if(p.status==='paga') return false;
    const divida = dividas.find(d=>d.id===p.dividaId);
    return divida && divida.tipo==='me_devem' && dataDentroDoPeriodo(p.vencimento, periodo);
  }).reduce((s,p)=>s+(p.valor||0),0);
  const previstoPagarPeriodo = parcelasDivida.filter(p=>{
    if(p.status==='paga') return false;
    const divida = dividas.find(d=>d.id===p.dividaId);
    return divida && divida.tipo==='devo' && dataDentroDoPeriodo(p.vencimento, periodo);
  }).reduce((s,p)=>s+(p.valor||0),0);

  // Insights de inteligência financeira: sempre olham o mês REAL (hoje),
  // independente do período que está sendo navegado nos relatórios.
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
    periodo, saldoDisponivel, dinheiroConta, totalCaixinhas, totalInvestido, limiteDisponivel,
    devoOutros, meDevem, previstoReceberPeriodo, previstoPagarPeriodo,
    contasAVencer, contasVencidas, gastoMes, receitaMes,
    patrimonio, porCategoria, porCategoriaMesAnterior, mediaGastoMesesAnteriores, cartoes
  };
}

function renderDashboard(){
  const periodo = aplicarPeriodoNaUI();
  const d = calcularDashboard(periodo);

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

  const labelGasto = document.getElementById('labelGastoPeriodo');
  const labelReceita = document.getElementById('labelReceitaPeriodo');
  const labelResumo = document.getElementById('labelResumoEyebrow');
  if(labelGasto) labelGasto.textContent = periodo.tipo==='mes-atual' ? 'Gasto no mês' : 'Gasto no período';
  if(labelReceita) labelReceita.textContent = periodo.tipo==='mes-atual' ? 'Receita no mês' : 'Receita no período';
  if(labelResumo) labelResumo.textContent = periodo.label;

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
    const alvo = (view==='caixinhas'||view==='investimentos'||view==='calendario'||view==='calculadora'||view==='relatorios'||view==='categorias'||view==='configuracoes'||view==='assistente') ? 'mais'
      : (view==='divida-pessoa') ? 'dividas' : view;
    b.classList.toggle('active', b.dataset.view===alvo);
  });
  document.getElementById('fabAdd').style.display = (view==='mais'||view==='calendario'||view==='calculadora'||view==='relatorios'||view==='categorias'||view==='configuracoes'||view==='assistente'||view==='divida-pessoa') ? 'none' : 'flex';
  if(view==='lancamentos') renderListaLancamentos();
  if(view==='cartoes') renderListaCartoes();
  if(view==='contasfixas') renderListaContasFixas();
  if(view==='dividas') renderListaPessoasDividas();
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
  const periodo = aplicarPeriodoNaUI();
  const cartoes = DB.get('cartoes');

  // Resumo por período: quanto foi gasto em cada cartão dentro do período selecionado
  const transacoes = DB.get('transacoes');
  const resumoPanel = document.getElementById('resumoPeriodoCartoes');
  if(cartoes.length===0){
    resumoPanel.innerHTML = '';
  } else {
    const porCartaoPeriodo = {};
    transacoes.filter(t=>t.tipo==='despesa' && t.cartaoId && dataDentroDoPeriodo(t.data, periodo)).forEach(t=>{
      porCartaoPeriodo[t.cartaoId] = (porCartaoPeriodo[t.cartaoId]||0) + t.valor;
    });
    const linhas = cartoes.map(c=>{
      const gasto = porCartaoPeriodo[c.id] || 0;
      return `<div class="resumo-item"><span class="tag">💳 ${c.nome}</span><span class="amt">${money(gasto)}</span></div>`;
    }).join('');
    resumoPanel.innerHTML = `<div class="label" style="margin-bottom:8px;">Gasto por cartão · ${periodo.label}</div>${linhas}`;
  }

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
  const periodo = aplicarPeriodoNaUI();
  const contasFixas = DB.get('contas_fixas');
  const todasParcelas = DB.get('parcelas_fixas');

  const resumoPanel = document.getElementById('resumoPeriodoFixas');
  const parcelasNoPeriodo = todasParcelas.filter(p=> dataDentroDoPeriodo(p.vencimento, periodo));
  const totalPeriodo = parcelasNoPeriodo.reduce((s,p)=>s+p.valor,0);
  const pagasPeriodo = parcelasNoPeriodo.filter(p=>p.status==='pago').length;
  resumoPanel.innerHTML = contasFixas.length===0 ? '' : `
    <div class="label" style="margin-bottom:6px;">${periodo.label}</div>
    <div class="resumo-item"><span class="tag">🧾 Total de contas fixas no período</span><span class="amt">${money(totalPeriodo)}</span></div>
    <div class="resumo-item"><span class="tag">✅ Já pagas</span><span class="amt">${pagasPeriodo} de ${parcelasNoPeriodo.length}</span></div>
  `;

  const list = document.getElementById('fixasList');
  if(contasFixas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma conta fixa cadastrada. Toque no + para adicionar (aluguel, internet, academia...).</div>';
    return;
  }
  const catMeta = DB.get('categorias');
  const hoje = new Date(); hoje.setHours(0,0,0,0);

  function proximaParcela(cf){
    const pendentes = todasParcelas.filter(p=>p.contaFixaId===cf.id && p.status!=='pago').sort((a,b)=> new Date(a.vencimento)-new Date(b.vencimento));
    return pendentes.find(p=> new Date(p.vencimento+'T00:00:00') >= hoje) || pendentes[0] || null;
  }

  // Ordem crescente pela próxima data de vencimento (contas sem pendências ficam no fim)
  const contasOrdenadas = [...contasFixas].sort((a,b)=>{
    const pa = proximaParcela(a), pb = proximaParcela(b);
    if(!pa && !pb) return 0;
    if(!pa) return 1;
    if(!pb) return -1;
    return new Date(pa.vencimento) - new Date(pb.vencimento);
  });

  list.innerHTML = contasOrdenadas.map(cf=>{
    const meta = catMeta.find(m=>m.nome===cf.categoria);
    const parcelas = todasParcelas.filter(p=>p.contaFixaId===cf.id).sort((a,b)=> new Date(a.vencimento)-new Date(b.vencimento));
    const proxima = proximaParcela(cf);
    const statusTxt = !proxima ? '✅ Todas as parcelas pagas'
      : (new Date(proxima.vencimento+'T00:00:00') < hoje ? '⚠️ Vencida' : '📅 Próxima em ' + new Date(proxima.vencimento+'T00:00:00').toLocaleDateString('pt-BR'));

    const parcelasHtml = `<div style="width:100%; margin-top:10px; padding-top:10px; border-top:1px dashed var(--stone-dark); display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;">` +
      parcelas.map(p=>{
        const paga = p.status==='pago';
        return `<div style="display:flex; align-items:center; justify-content:space-between; font-size:12.5px;">
          <span>${paga?'✅':'⏳'} Parcela ${p.numero}/${p.totalParcelas} · ${new Date(p.vencimento+'T00:00:00').toLocaleDateString('pt-BR')}</span>
          <span style="display:flex; align-items:center; gap:6px;">
            <strong>${money(p.valor)}</strong>
            <button data-parcela-fixa-editar="${p.id}" title="Editar valor" style="font-size:11px; background:none; border:none; cursor:pointer;">✏️</button>
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
  list.querySelectorAll('[data-parcela-fixa-editar]').forEach(btn=>{
    btn.addEventListener('click', ()=> editarValorParcelaFixa(btn.dataset.parcelaFixaEditar));
  });
}

function editarValorParcelaFixa(parcelaId){
  const parcelas = DB.get('parcelas_fixas');
  const p = parcelas.find(x=>x.id===parcelaId);
  if(!p) return;
  const novoValorStr = prompt('Novo valor desta parcela (R$) — útil quando a conta é fixa mas o valor varia:', p.valor);
  if(novoValorStr===null) return;
  const novoValor = parseFloat(novoValorStr.replace(',','.'));
  if(!novoValor || novoValor<=0) return;
  p.valor = novoValor;
  DB.save('parcelas_fixas', parcelas);
  renderListaContasFixas();
  renderDashboard();
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
   MODAL: DÍVIDA (compra)
   ================================================================ */
let dividaTipoAtual = 'devo';
let dividaEditandoId = null;
let pessoaAtualDivida = null;

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

function abrirModalDivida(pessoaPrefill, compraId){
  dividaEditandoId = compraId || null;
  const compra = compraId ? DB.get('dividas').find(d=>d.id===compraId) : null;

  document.getElementById('modalDividaTitulo').textContent = compra ? 'Editar compra' : 'Nova compra';
  document.getElementById('dvPessoa').value = compra ? compra.pessoa : (pessoaPrefill || '');
  document.getElementById('dvTelefone').value = compra ? (compra.telefone||'') : '';
  document.getElementById('dvValor').value = compra ? compra.valorTotal : '';
  document.getElementById('dvValor').disabled = !!(compra && compra.parcelado);
  document.getElementById('dvMotivo').value = compra ? (compra.motivo||'') : '';
  document.getElementById('dvData').value = compra ? compra.data : new Date().toISOString().slice(0,10);
  document.getElementById('dvVencimento').value = compra ? (compra.vencimento||'') : '';
  document.getElementById('dvObservacoes').value = compra ? (compra.observacoes||'') : '';
  document.getElementById('dvParcelar').checked = compra ? !!compra.parcelado : false;
  document.getElementById('dvParcelar').disabled = !!compra;
  document.getElementById('dvNumParcelas').value = compra ? (compra.numParcelas||2) : 2;
  document.getElementById('dvNumParcelas').disabled = !!compra;
  document.getElementById('fieldDvParcelas').classList.toggle('hidden', !(compra && compra.parcelado));
  document.getElementById('dvParcelasPreview').textContent = (compra && compra.parcelado) ? 'As parcelas já geradas não mudam — edite o valor de cada uma na tela da compra.' : '';
  document.querySelector('#fieldDvVencimento label').textContent = (compra && compra.parcelado) ? 'Vencimento da 1ª parcela' : 'Vencimento (opcional)';

  dividaTipoAtual = compra ? compra.tipo : filtroDividaAtual;
  document.querySelectorAll('#segDividaTipo button').forEach(b=>b.classList.toggle('active', b.dataset.tipo===dividaTipoAtual));

  document.getElementById('modalDivida').classList.add('open');
}

document.getElementById('btnSalvarDivida').addEventListener('click', ()=>{
  const pessoa = document.getElementById('dvPessoa').value.trim();
  const motivo = document.getElementById('dvMotivo').value.trim();
  const telefone = document.getElementById('dvTelefone').value.trim();
  const data = document.getElementById('dvData').value;
  const vencimento = document.getElementById('dvVencimento').value;
  const observacoes = document.getElementById('dvObservacoes').value.trim();
  if(!pessoa){ alert('Informe a pessoa.'); return; }

  if(dividaEditandoId){
    const dividas = DB.get('dividas');
    const d = dividas.find(x=>x.id===dividaEditandoId);
    if(d){
      d.pessoa = pessoa; d.telefone = telefone; d.motivo = motivo;
      d.data = data; d.observacoes = observacoes;
      if(!d.parcelado){
        const valor = parseFloat(document.getElementById('dvValor').value);
        if(!valor || valor<=0){ alert('Informe um valor válido.'); return; }
        d.valorTotal = valor;
        d.vencimento = vencimento;
      }
      DB.save('dividas', dividas);
    }
    fecharModal('modalDivida');
    renderComprasPessoa(pessoa);
    renderListaPessoasDividas();
    renderDashboard();
    return;
  }

  const valor = parseFloat(document.getElementById('dvValor').value);
  if(!valor || valor<=0){ alert('Informe um valor válido.'); return; }
  const parcelado = document.getElementById('dvParcelar').checked;
  const numParcelas = parcelado ? Math.max(2, parseInt(document.getElementById('dvNumParcelas').value)||2) : 1;

  const divida = DB.add('dividas', {
    tipo: dividaTipoAtual, pessoa, telefone,
    valorTotal: valor, valorPago: 0, motivo,
    data, vencimento, observacoes,
    parcelado, numParcelas: parcelado ? numParcelas : null
  });

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
  if(currentView==='divida-pessoa') renderComprasPessoa(pessoaAtualDivida);
  else renderListaPessoasDividas();
  renderDashboard();
});

document.getElementById('btnNovaCompraPessoa').addEventListener('click', ()=>{
  abrirModalDivida(pessoaAtualDivida);
});

let filtroDividaAtual = 'devo';
document.querySelectorAll('#segDividaFiltro button').forEach(b=>{
  b.addEventListener('click', ()=>{
    filtroDividaAtual = b.dataset.filtro;
    document.querySelectorAll('#segDividaFiltro button').forEach(x=>x.classList.toggle('active', x===b));
    renderListaPessoasDividas();
  });
});

/* ================================================================
   LISTA DE PESSOAS — nível 1 da tela de Dívidas
   ================================================================ */
function dadosResumoPessoa(pessoa, tipo){
  const dividas = DB.get('dividas').filter(d=>d.tipo===tipo && d.pessoa===pessoa);
  const todasParcelas = DB.get('parcelas_divida');
  let totalAberto = 0, comprasAberto = 0, parcelasPendentes = 0, proximoVencimento = null;

  dividas.forEach(d=>{
    const {restante} = restanteEPagoDivida(d, todasParcelas);
    if(restante > 0){
      totalAberto += restante;
      comprasAberto++;
      if(d.parcelado){
        const pendentes = todasParcelas.filter(p=>p.dividaId===d.id && p.status!=='paga');
        parcelasPendentes += pendentes.length;
        pendentes.forEach(p=>{
          if(!proximoVencimento || new Date(p.vencimento) < new Date(proximoVencimento)) proximoVencimento = p.vencimento;
        });
      } else {
        parcelasPendentes += 1;
        if(d.vencimento && (!proximoVencimento || new Date(d.vencimento) < new Date(proximoVencimento))) proximoVencimento = d.vencimento;
      }
    }
  });

  return { totalAberto, comprasAberto, parcelasPendentes, proximoVencimento };
}

function renderListaPessoasDividas(){
  const periodo = aplicarPeriodoNaUI();
  const dividas = DB.get('dividas').filter(d=>d.tipo===filtroDividaAtual);
  const list = document.getElementById('pessoasList');
  const pessoas = [...new Set(dividas.map(d=>d.pessoa))].sort((a,b)=>a.localeCompare(b,'pt-BR'));

  if(pessoas.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma dívida por aqui.</div>';
    return;
  }
  const todasParcelasPeriodo = DB.get('parcelas_divida');

  list.innerHTML = pessoas.map(pessoa=>{
    const r = dadosResumoPessoa(pessoa, filtroDividaAtual);
    const idsDividasPessoa = dividas.filter(d=>d.pessoa===pessoa).map(d=>d.id);
    const parcelasNoPeriodo = todasParcelasPeriodo.filter(p=> idsDividasPessoa.includes(p.dividaId) && p.status!=='paga' && dataDentroDoPeriodo(p.vencimento, periodo));
    const totalPeriodo = parcelasNoPeriodo.reduce((s,p)=>s+p.valor,0);
    if(r.comprasAberto===0){
      return `<div class="panel" data-pessoa="${pessoa}" style="cursor:pointer; margin-bottom:12px; opacity:0.65;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <span>✅ <strong>${pessoa}</strong> — tudo quitado</span>
          <span style="font-size:11px; color:var(--plum-soft);">›</span>
        </div>
      </div>`;
    }
    const vencTxt = r.proximoVencimento ? new Date(r.proximoVencimento+'T00:00:00').toLocaleDateString('pt-BR') : '—';
    return `<div class="panel" data-pessoa="${pessoa}" style="cursor:pointer; margin-bottom:12px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <strong style="font-family:'Fraunces',serif; font-size:16px;">${pessoa}</strong>
        <span style="font-size:13px; color:var(--plum-soft);">›</span>
      </div>
      <div class="label" style="margin-bottom:2px;">Total em aberto</div>
      <div class="hero-value" style="font-size:22px; margin-bottom:10px;">${money(r.totalAberto)}</div>
      <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--plum-soft); font-weight:600;">
        <span>🧾 ${r.comprasAberto} compra${r.comprasAberto!==1?'s':''}</span>
        <span>⏳ ${r.parcelasPendentes} parcela${r.parcelasPendentes!==1?'s':''} restante${r.parcelasPendentes!==1?'s':''}</span>
        <span>📅 Próx.: ${vencTxt}</span>
      </div>
      ${parcelasNoPeriodo.length>0 ? `<div style="margin-top:8px; font-size:11.5px; font-weight:700; color:var(--rose-deep);">🗓️ ${periodo.label}: ${parcelasNoPeriodo.length} parcela${parcelasNoPeriodo.length!==1?'s':''} · ${money(totalPeriodo)}</div>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-pessoa]').forEach(el=>{
    el.addEventListener('click', ()=> abrirPessoaDivida(el.dataset.pessoa));
  });
}

function abrirPessoaDivida(pessoa){
  pessoaAtualDivida = pessoa;
  document.getElementById('pessoaEyebrow').textContent = filtroDividaAtual==='devo' ? 'Eu devo' : 'Me devem';
  switchView('divida-pessoa');
  renderComprasPessoa(pessoa);
}

/* ================================================================
   COMPRAS DA PESSOA — nível 2 (parcelas ficam escondidas até tocar em "Ver parcelas")
   ================================================================ */
let comprasExpandidas = new Set();

function renderComprasPessoa(pessoa){
  document.getElementById('pessoaNomeTitulo').textContent = pessoa;
  const r = dadosResumoPessoa(pessoa, filtroDividaAtual);
  const vencTxt = r.proximoVencimento ? new Date(r.proximoVencimento+'T00:00:00').toLocaleDateString('pt-BR') : '—';

  document.getElementById('pessoaResumoPanel').innerHTML = `
    <div class="label" style="margin-bottom:2px;">Total em aberto</div>
    <div class="hero-value" style="font-size:26px; margin-bottom:12px;">${money(r.totalAberto)}</div>
    <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--plum-soft); font-weight:600; margin-bottom:12px;">
      <span>🧾 ${r.comprasAberto} compra${r.comprasAberto!==1?'s':''}</span>
      <span>⏳ ${r.parcelasPendentes} parcela${r.parcelasPendentes!==1?'s':''} restante${r.parcelasPendentes!==1?'s':''}</span>
      <span>📅 Próx.: ${vencTxt}</span>
    </div>
    <button id="btnExcluirPessoaDivida" style="background:none; border:none; color:var(--red); font-size:11.5px; font-weight:700; cursor:pointer; padding:0;">🗑️ Excluir ${pessoa} e todas as compras</button>
  `;
  document.getElementById('btnExcluirPessoaDivida').addEventListener('click', ()=>{
    if(!confirm(`Excluir ${pessoa} e todas as compras/parcelas? Não tem como desfazer.`)) return;
    const idsDaPessoa = DB.get('dividas').filter(d=>d.tipo===filtroDividaAtual && d.pessoa===pessoa).map(d=>d.id);
    DB.save('dividas', DB.get('dividas').filter(d=>!idsDaPessoa.includes(d.id)));
    DB.save('parcelas_divida', DB.get('parcelas_divida').filter(p=>!idsDaPessoa.includes(p.dividaId)));
    renderDashboard();
    switchView('dividas');
  });

  const todasParcelas = DB.get('parcelas_divida');
  const compras = DB.get('dividas').filter(d=>d.tipo===filtroDividaAtual && d.pessoa===pessoa)
    .sort((a,b)=>{
      const ra = restanteEPagoDivida(a, todasParcelas).restante, rb = restanteEPagoDivida(b, todasParcelas).restante;
      if((ra>0) !== (rb>0)) return ra>0 ? -1 : 1;
      return new Date(a.data) - new Date(b.data);
    });

  const list = document.getElementById('comprasList');
  if(compras.length===0){
    list.innerHTML = '<div class="empty-note">Nenhuma compra cadastrada ainda. Toque em "+ Nova compra".</div>';
    return;
  }

  list.innerHTML = compras.map(d=>{
    const {restante} = restanteEPagoDivida(d, todasParcelas);
    const quitada = restante <= 0;
    const parcelas = d.parcelado ? todasParcelas.filter(p=>p.dividaId===d.id).sort((a,b)=> new Date(a.vencimento)-new Date(b.vencimento)) : [];
    const pagas = parcelas.filter(p=>p.status==='paga').length;
    const proxima = parcelas.find(p=>p.status!=='paga');
    const vencTxtCompra = d.parcelado ? (proxima ? new Date(proxima.vencimento+'T00:00:00').toLocaleDateString('pt-BR') : '—')
      : (d.vencimento ? new Date(d.vencimento+'T00:00:00').toLocaleDateString('pt-BR') : '—');
    const expandida = comprasExpandidas.has(d.id);

    const parcelasHtml = (d.parcelado && expandida) ? `
      <div style="width:100%; margin-top:10px; padding-top:10px; border-top:1px dashed var(--stone-dark); display:flex; flex-direction:column; gap:8px;">
        ${parcelas.map(p=>{
          const paga = p.status==='paga';
          return `<div style="display:flex; align-items:center; justify-content:space-between; font-size:12.5px;">
            <span>${paga?'✔':'⏳'} Parcela ${p.numero} · ${new Date(p.vencimento+'T00:00:00').toLocaleDateString('pt-BR')}</span>
            <span style="display:flex; align-items:center; gap:6px;">
              <strong>${money(p.valor)}</strong>
              <button data-parcela-divida-editar="${p.id}" title="Editar valor" style="font-size:11px; background:none; border:none; cursor:pointer;">✏️</button>
              <button data-parcela-divida-toggle="${p.id}" style="font-size:11px; color:var(--rose-deep); font-weight:700; background:none; border:none; cursor:pointer;">${paga?'Desfazer':'Marcar paga'}</button>
            </span>
          </div>`;
        }).join('')}
      </div>` : '';

    return `<div class="panel" style="margin-bottom:12px;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
        <div>
          <div style="font-weight:700; font-size:14.5px; margin-bottom:6px;">📦 ${d.motivo || 'Sem descrição'}</div>
          <div class="label" style="margin-bottom:0;">Restante</div>
          <div style="font-family:'Fraunces',serif; font-weight:700; font-size:18px; color:${quitada?'var(--green)':'var(--plum-ink)'};">${quitada?'Quitada':money(restante)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button data-compra-editar="${d.id}" title="Editar compra" style="background:var(--stone); border:none; width:30px; height:30px; border-radius:50%; cursor:pointer;">✏️</button>
          <button data-compra-excluir="${d.id}" title="Excluir compra" style="background:var(--stone); border:none; width:30px; height:30px; border-radius:50%; cursor:pointer;">🗑️</button>
        </div>
      </div>
      <div style="font-size:12px; color:var(--plum-soft); font-weight:600; margin-top:8px;">
        ${d.parcelado ? `${pagas} de ${d.numParcelas} parcelas pagas` : (quitada?'Pagamento único quitado':'Pagamento único')} · Próx.: ${vencTxtCompra}
      </div>
      ${!d.parcelado && !quitada ? `<button data-compra-pagar="${d.id}" style="margin-top:8px; background:none; border:none; color:var(--rose-deep); font-weight:700; font-size:12.5px; cursor:pointer; padding:0;">Registrar pagamento</button>` : ''}
      ${d.parcelado ? `<button data-compra-toggle="${d.id}" style="margin-top:8px; background:none; border:none; color:var(--rose-deep); font-weight:700; font-size:12.5px; cursor:pointer; padding:0;">${expandida?'▼ Ocultar':'▶ Ver'} parcelas</button>` : ''}
      ${parcelasHtml}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-compra-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.compraToggle;
      if(comprasExpandidas.has(id)) comprasExpandidas.delete(id); else comprasExpandidas.add(id);
      renderComprasPessoa(pessoa);
    });
  });
  list.querySelectorAll('[data-compra-editar]').forEach(btn=>{
    btn.addEventListener('click', ()=> abrirModalDivida(pessoa, btn.dataset.compraEditar));
  });
  list.querySelectorAll('[data-compra-excluir]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir esta compra e suas parcelas?')) return;
      DB.save('dividas', DB.get('dividas').filter(d=>d.id!==btn.dataset.compraExcluir));
      DB.save('parcelas_divida', DB.get('parcelas_divida').filter(p=>p.dividaId!==btn.dataset.compraExcluir));
      renderComprasPessoa(pessoa);
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-compra-pagar]').forEach(btn=>{
    btn.addEventListener('click', ()=> registrarPagamentoDivida(btn.dataset.compraPagar, pessoa));
  });
  list.querySelectorAll('[data-parcela-divida-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleParcelaDividaPaga(btn.dataset.parcelaDividaToggle, pessoa));
  });
  list.querySelectorAll('[data-parcela-divida-editar]').forEach(btn=>{
    btn.addEventListener('click', ()=> editarValorParcelaDivida(btn.dataset.parcelaDividaEditar, pessoa));
  });
}

function toggleParcelaDividaPaga(parcelaId, pessoa){
  const parcelas = DB.get('parcelas_divida');
  const p = parcelas.find(x=>x.id===parcelaId);
  if(!p) return;
  p.status = p.status==='paga' ? 'pendente' : 'paga';
  DB.save('parcelas_divida', parcelas);
  renderComprasPessoa(pessoa);
  renderDashboard();
}

function editarValorParcelaDivida(parcelaId, pessoa){
  const parcelas = DB.get('parcelas_divida');
  const p = parcelas.find(x=>x.id===parcelaId);
  if(!p) return;
  const novoValorStr = prompt('Novo valor desta parcela (R$):', p.valor);
  if(novoValorStr===null) return;
  const novoValor = parseFloat(novoValorStr.replace(',','.'));
  if(!novoValor || novoValor<=0) return;
  p.valor = novoValor;
  DB.save('parcelas_divida', parcelas);
  renderComprasPessoa(pessoa);
  renderDashboard();
}

function registrarPagamentoDivida(id, pessoa){
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
  renderComprasPessoa(pessoa);
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
  const periodo = aplicarPeriodoNaUI();
  const caixinhas = DB.get('caixinhas');
  const movimentacoes = DB.get('caixinha_movimentacoes');

  const resumoPanel = document.getElementById('resumoPeriodoCaixinhas');
  if(caixinhas.length===0){
    resumoPanel.innerHTML = '';
  } else {
    const doPeriodo = movimentacoes.filter(m=> dataDentroDoPeriodo(m.data, periodo));
    const depositado = doPeriodo.filter(m=>m.tipo==='deposito').reduce((s,m)=>s+m.valor,0);
    const resgatado = doPeriodo.filter(m=>m.tipo==='resgate').reduce((s,m)=>s+m.valor,0);
    resumoPanel.innerHTML = `
      <div class="label" style="margin-bottom:6px;">${periodo.label}</div>
      <div class="resumo-item"><span class="tag">➕ Depositado no período</span><span class="amt">${money(depositado)}</span></div>
      <div class="resumo-item"><span class="tag">➖ Resgatado no período</span><span class="amt">${money(resgatado)}</span></div>
    `;
  }

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
  DB.add('caixinha_movimentacoes', { caixinhaId:id, tipo: sinal>0?'deposito':'resgate', valor, data:new Date().toISOString().slice(0,10) });
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
  const periodo = aplicarPeriodoNaUI();
  const investimentos = DB.get('investimentos');
  const movimentacoes = DB.get('investimento_movimentacoes');
  document.getElementById('totalInvestidoLabel').textContent = money(investimentos.reduce((s,i)=>s+(i.valorAtual||0),0));

  const resumoPanel = document.getElementById('resumoPeriodoInvestimentos');
  if(investimentos.length===0){
    resumoPanel.innerHTML = '';
  } else {
    const doPeriodo = movimentacoes.filter(m=> dataDentroDoPeriodo(m.data, periodo));
    const variacaoPeriodo = doPeriodo.reduce((s,m)=>s+(m.valorNovo-m.valorAnterior),0);
    resumoPanel.innerHTML = `
      <div class="label" style="margin-bottom:6px;">${periodo.label}</div>
      <div class="resumo-item"><span class="tag">${variacaoPeriodo>=0?'📈':'📉'} Variação registrada no período</span><span class="amt">${variacaoPeriodo>=0?'+':''}${money(variacaoPeriodo)}</span></div>
      <div class="hint" style="margin-top:6px;">Só conta se você atualizar o valor atual (✏️) com o rendimento — o app não busca cotações sozinho.</div>
    `;
  }

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
        <button class="tx-del" data-id="${i.id}" data-action="atualizar" title="Atualizar valor">✏️</button>
        <button class="tx-del" data-id="${i.id}" data-action="excluir" title="Excluir">🗑️</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-action="excluir"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Excluir este investimento?')) return;
      DB.save('investimentos', DB.get('investimentos').filter(i=>i.id!==btn.dataset.id));
      renderListaInvestimentos();
      renderDashboard();
    });
  });
  list.querySelectorAll('[data-action="atualizar"]').forEach(btn=>{
    btn.addEventListener('click', ()=> atualizarValorInvestimento(btn.dataset.id));
  });
}

function atualizarValorInvestimento(id){
  const investimentos = DB.get('investimentos');
  const i = investimentos.find(x=>x.id===id);
  if(!i) return;
  const novoValorStr = prompt(`Novo valor atual de "${i.nome}" (era ${money(i.valorAtual)}):`, i.valorAtual);
  if(novoValorStr===null) return;
  const novoValor = parseFloat(novoValorStr.replace(',','.'));
  if(!novoValor || novoValor<=0) return;
  const valorAnterior = i.valorAtual;
  i.valorAtual = novoValor;
  DB.save('investimentos', investimentos);
  DB.add('investimento_movimentacoes', { investimentoId:id, valorAnterior, valorNovo:novoValor, data:new Date().toISOString().slice(0,10) });
  renderListaInvestimentos();
  renderDashboard();
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
    eventos.push({ tipo:'divida-pagar', label:`🤝 Devo a ${divida.pessoa} · parcela ${p.numero}/${p.totalParcelas}`, valor:p.valor, cor: diaData<hoje?'var(--red)':'var(--sun-deep)' });
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

  // Notificações seguem exatamente a mesma regra do Dashboard: só contas
  // pessoais (cartão e contas fixas). Dívidas entre pessoas nunca notificam.
  DB.get('parcelas').filter(p=>p.status!=='pago').forEach(p=>{
    const st = classificar(p.vencimento);
    if(st){
      const cartao = DB.get('cartoes').find(c=>c.id===p.cartaoId);
      alertas.push({ id:'parc-'+p.id, status:st, texto:`Parcela ${p.numero}/${p.totalParcelas}${cartao?' · '+cartao.nome:''}`, valor:p.valor });
    }
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
  const periodo = aplicarPeriodoNaUI();
  const transacoes = DB.get('transacoes');
  const hoje = new Date();

  // Resumo do período selecionado
  const d = calcularDashboard(periodo);
  const saldoPeriodo = d.receitaMes - d.gastoMes;
  document.getElementById('resumoPeriodoRelatorio').innerHTML = `
    <div class="resumo-item"><span class="tag">💵 Receitas</span><span class="amt">${money(d.receitaMes)}</span></div>
    <div class="resumo-item"><span class="tag">🧾 Despesas</span><span class="amt">${money(d.gastoMes)}</span></div>
    <div class="resumo-item"><span class="tag">${saldoPeriodo>=0?'✅':'⚠️'} Saldo do período</span><span class="amt">${money(saldoPeriodo)}</span></div>
    <div class="resumo-item"><span class="tag">📅 Contas a vencer</span><span class="amt">${money(d.contasAVencer)}</span></div>
    <div class="resumo-item"><span class="tag">⚠️ Contas vencidas</span><span class="amt">${money(d.contasVencidas)}</span></div>
    <div class="resumo-item"><span class="tag">📥 Vou receber de terceiros</span><span class="amt">${money(d.previstoReceberPeriodo)}</span></div>
    <div class="resumo-item"><span class="tag">📤 Vou pagar a terceiros</span><span class="amt">${money(d.previstoPagarPeriodo)}</span></div>
  `;

  // Comparativo mês a mês — granularidade conforme o período escolhido
  const qtdMeses = periodo.tipo==='ultimos-3' ? 3 : periodo.tipo==='este-ano' ? 12 : periodo.tipo==='geral' ? 12 : 6;
  const comparativo = document.getElementById('comparativoMensal');
  let linhasComparativo = [];
  for(let i=qtdMeses-1;i>=0;i--){
    const ref = new Date(hoje.getFullYear(), hoje.getMonth()-i, 1);
    const doMes = transacoes.filter(t=>{
      const dt = new Date(t.data);
      return dt.getMonth()===ref.getMonth() && dt.getFullYear()===ref.getFullYear();
    });
    const rec = doMes.filter(t=>t.tipo==='receita').reduce((s,t)=>s+t.valor,0);
    const desp = doMes.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+t.valor,0);
    const saldo = rec - desp;
    const nomeMes = capitalizar(ref.toLocaleDateString('pt-BR', {month:'long', year:'numeric'}));
    linhasComparativo.push(`<div class="resumo-item">
      <span class="tag">${nomeMes}</span>
      <span class="amt" style="text-align:right;">
        <span style="color:var(--green);">${money(rec)}</span> ·
        <span style="color:var(--rose-deep);">${money(desp)}</span> ·
        <strong style="color:${saldo>=0?'var(--green)':'var(--red)'};">${saldo>=0?'+':''}${money(saldo)}</strong>
      </span>
    </div>`);
  }
  comparativo.innerHTML = `<div class="resumo-item" style="font-size:11px; color:var(--plum-soft); font-weight:700;"><span>Mês</span><span>Receita · Despesa · Saldo</span></div>` + linhasComparativo.join('');

  // Receitas x Despesas — últimos 6 meses (tendência fixa, independe do seletor)
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

  // Gastos por cartão — dentro do período selecionado
  const despesasPeriodo = transacoes.filter(t=> t.tipo==='despesa' && t.cartaoId && dataDentroDoPeriodo(t.data, periodo));
  const porCartao = {};
  despesasPeriodo.forEach(t=>{ porCartao[t.cartaoId] = (porCartao[t.cartaoId]||0) + t.valor; });
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
  'historico_patrimonio','aniversarios','caixinha_movimentacoes','investimento_movimentacoes'
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
  atualizarContextoAssistente();
}

function atualizarContextoAssistente(){
  const el = document.getElementById('assistenteContextoPeriodo');
  if(el) el.textContent = getPeriodoAtual().label;
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

const MESES_PT = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

function extrairPeriodoDaPergunta(textoNormalizado){
  const hoje = new Date();
  let mesEncontrado = -1;
  for(let i=0;i<MESES_PT.length;i++){
    if(textoNormalizado.includes(MESES_PT[i])){ mesEncontrado = i; break; }
  }
  if(mesEncontrado===-1) return null;
  const mAno = textoNormalizado.match(/\b(20\d{2})\b/);
  const ano = mAno ? parseInt(mAno[1]) : hoje.getFullYear();
  const inicio = new Date(ano, mesEncontrado, 1);
  const fim = new Date(ano, mesEncontrado+1, 0, 23,59,59,999);
  const label = capitalizar(inicio.toLocaleDateString('pt-BR', {month:'long', year:'numeric'}));
  return { tipo:'escolher', inicio, fim, label };
}

function responderPergunta(perguntaOriginal){
  const p = normalizar(perguntaOriginal);
  const periodoMencionado = extrairPeriodoDaPergunta(p);
  const periodo = periodoMencionado || getPeriodoAtual();
  const d = calcularDashboard(periodo);
  const contextoTxt = periodoMencionado ? ` em ${periodo.label}` : (periodo.tipo==='mes-atual' ? ' este mês' : ` em ${periodo.label}`);

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
    return `Você ${periodoMencionado?'registrou':'já registrou'} <strong>${money(d.receitaMes)}</strong> em receitas${contextoTxt}.`;
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
    const parcelasDividaAssist = DB.get('parcelas_divida');
    const lista = DB.get('dividas').filter(dv=>dv.tipo==='devo').map(dv=>({dv, r:restanteEPagoDivida(dv, parcelasDividaAssist).restante})).filter(x=>x.r>0)
      .map(x=>`${x.dv.pessoa}: ${money(x.r)}`);
    return `No total você deve <strong>${money(d.devoOutros)}</strong>:<br>${lista.join('<br>')}`;
  }

  // 3. Quem me deve
  if(p.includes('deve') || p.includes('devem')){
    if(d.meDevem<=0) return 'Ninguém te deve dinheiro no momento. 🌸';
    const parcelasDividaAssist2 = DB.get('parcelas_divida');
    const lista = DB.get('dividas').filter(dv=>dv.tipo==='me_devem').map(dv=>({dv, r:restanteEPagoDivida(dv, parcelasDividaAssist2).restante})).filter(x=>x.r>0)
      .map(x=>`${x.dv.pessoa}: ${money(x.r)}`);
    return `No total te devem <strong>${money(d.meDevem)}</strong>:<br>${lista.join('<br>')}`;
  }

  // 2. Gastos por categoria
  const categoriaMencionadaGeral = DB.get('categorias').find(c=> p.includes(normalizar(c.nome)));
  if(categoriaMencionadaGeral && (p.includes('gast') || p.includes('pag') || p.includes('categoria'))){
    const valor = d.porCategoria[categoriaMencionadaGeral.nome] || 0;
    return `Você gastou <strong>${money(valor)}</strong> com ${categoriaMencionadaGeral.emoji} ${categoriaMencionadaGeral.nome}${contextoTxt}.`;
  }

  if(p.includes('categoria')){
    const cats = Object.entries(d.porCategoria).sort((a,b)=>b[1]-a[1]);
    if(cats.length===0) return `Ainda não há despesas registradas${contextoTxt}.`;
    return `Gastos por categoria${contextoTxt}:<br>` + cats.map(([cat,val])=>`${cat}: ${money(val)}`).join('<br>');
  }

  // 1. Quanto posso gastar até o fim do mês
  if(p.includes('posso gastar') || p.includes('sobra') || (p.includes('gastar') && p.includes('mes'))){
    const disponivelReal = d.saldoDisponivel - d.contasAVencer;
    return `Seu saldo disponível é <strong>${money(d.saldoDisponivel)}</strong>. Descontando as contas que ainda vão vencer (${money(d.contasAVencer)}), sobram cerca de <strong>${money(disponivelReal)}</strong> livres até o fim do mês.`;
  }

  // Quanto gastei (total, sem categoria específica)
  if(p.includes('gastei') || p.includes('paguei') || (p.includes('quanto') && p.includes('gast'))){
    return `Você gastou <strong>${money(d.gastoMes)}</strong>${contextoTxt}.`;
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
