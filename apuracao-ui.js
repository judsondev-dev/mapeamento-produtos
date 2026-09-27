/* Aba "Apuração assistida" — interface. Depende de apuracao.js, JSZip e das globais DATA / esc do index.html. */
(function () {
  var DB_NOME = "farma-apuracao", db = null, iniciado = false;
  var notasMes = [], canceladas = {}, ultimo = null;
  var $ = function (id) { return document.getElementById(id); };

  function brl(v) { return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function num(s) {
    if (typeof s === "number") return s;
    s = String(s || "").replace(/[^\d,.-]/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var v = parseFloat(s); return isNaN(v) ? 0 : v;
  }
  function fmtIn(v) { return v ? v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""; }
  function mesAnterior(c) { var p = c.split("-"), d = new Date(+p[0], +p[1] - 2, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function nomeMes(c) { var p = c.split("-"); return ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"][+p[1] - 1] + "/" + p[0]; }

  // ---------- armazenamento local ----------
  function ls(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null");
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function cfg() { return ls("apur:" + $("comp").value) || {}; }
  function setCfg(c) { ls("apur:" + $("comp").value, c); }

  function abrirDB() {
    return new Promise(function (ok, erro) {
      if (db) return ok(db);
      if (!window.indexedDB) return erro(new Error("Navegador sem IndexedDB"));
      var rq = indexedDB.open(DB_NOME, 1);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        var s = d.createObjectStore("notas", { keyPath: "chave" });
        s.createIndex("mes", "mes"); s.createIndex("imp", "imp");
        d.createObjectStore("cancel", { keyPath: "chave" });
      };
      rq.onsuccess = function () { db = rq.result; ok(db); };
      rq.onerror = function () { erro(rq.error); };
    });
  }
  function gravar(notas, cancs) {
    return abrirDB().then(function (d) {
      return new Promise(function (ok, erro) {
        var tx = d.transaction(["notas", "cancel"], "readwrite");
        notas.forEach(function (n) { tx.objectStore("notas").put(n); });
        cancs.forEach(function (c) { tx.objectStore("cancel").put({ chave: c }); });
        tx.oncomplete = ok; tx.onerror = function () { erro(tx.error); };
      });
    });
  }
  function porIndice(idx, valor) {
    return abrirDB().then(function (d) {
      return new Promise(function (ok, erro) {
        var rq = d.transaction("notas").objectStore("notas").index(idx).getAll(valor);
        rq.onsuccess = function () { ok(rq.result); }; rq.onerror = function () { erro(rq.error); };
      });
    });
  }
  function todasCanceladas() {
    return abrirDB().then(function (d) {
      return new Promise(function (ok) {
        var rq = d.transaction("cancel").objectStore("cancel").getAllKeys();
        rq.onsuccess = function () { var o = {}; rq.result.forEach(function (k) { o[k] = 1; }); ok(o); };
        rq.onerror = function () { ok({}); };
      });
    });
  }

  // ---------- importação ----------
  function progresso(p, t) {
    $("prog").style.display = p === null ? "none" : "block";
    if (p !== null) $("prog").firstChild.style.width = Math.round(p * 100) + "%";
    $("progtxt").textContent = t || "";
  }
  function pausa() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function importar(arquivos) {
    var comp = $("comp").value, fila = [], lidas = 0, novas = [], cancs = [], ignor = 0;
    arquivos = Array.prototype.slice.call(arquivos);
    progresso(0, "Abrindo arquivos…");
    // monta a fila de XMLs (dentro de zips, inclusive zip dentro de zip)
    function abrirZip(dado, nome) {
      return JSZip.loadAsync(dado).then(function (z) {
        var ps = [];
        z.forEach(function (caminho, f) {
          if (f.dir) return;
          if (/\.xml$/i.test(caminho)) fila.push(function () { return f.async("string"); });
          else if (/\.zip$/i.test(caminho)) ps.push(f.async("arraybuffer").then(function (b) { return abrirZip(b, caminho); }));
        });
        return Promise.all(ps);
      }).catch(function () { throw new Error("Não consegui abrir " + nome); });
    }
    return Promise.all(arquivos.map(function (a) {
      if (/\.zip$/i.test(a.name)) return abrirZip(a, a.name);
      if (/\.xml$/i.test(a.name)) fila.push(function () { return a.text(); });
      return null;
    })).then(function () {
      if (!fila.length) throw new Error("Nenhum XML encontrado nos arquivos.");
      var i = 0;
      function lote() {
        var fim = Math.min(i + 150, fila.length), ps = [];
        for (; i < fim; i++) ps.push(fila[i]());
        return Promise.all(ps).then(function (strs) {
          strs.forEach(function (s) {
            var n = null;
            try { n = Apuracao.parseXml(s); } catch (e) { n = null; }
            if (!n) { ignor++; return; }
            if (n.tipo === "cancelamento") { cancs.push(n.chave); return; }
            n.mes = n.data.slice(0, 7); n.imp = comp; n.papel = Apuracao.papel(n);
            novas.push(n);
          });
          lidas = i;
          progresso(lidas / fila.length * 0.9, "Lendo XMLs… " + lidas.toLocaleString("pt-BR") + " de " + fila.length.toLocaleString("pt-BR"));
          return pausa().then(function () { return i < fila.length ? lote() : null; });
        });
      }
      return lote();
    }).then(function () {
      progresso(0.95, "Salvando notas neste computador…");
      return gravar(novas, cancs);
    }).then(function () {
      var noMes = novas.filter(function (n) { return n.mes === comp; }).length;
      var msg = novas.length.toLocaleString("pt-BR") + " notas lidas (" + noMes.toLocaleString("pt-BR") + " de " + nomeMes(comp) + ")";
      if (cancs.length) msg += " · " + cancs.length + " cancelamentos";
      if (ignor) msg += " · " + ignor + " arquivos ignorados (não são NF-e)";
      progresso(null, "✓ " + msg);
      return carregar();
    }).catch(function (e) { progresso(null, "❌ " + e.message); });
  }

  // ---------- cálculo e tela ----------
  function carregar() {
    var comp = $("comp").value;
    return Promise.all([porIndice("mes", comp), porIndice("imp", comp), todasCanceladas()]).then(function (r) {
      var vistos = {};
      notasMes = [];
      r[0].forEach(function (n) { vistos[n.chave] = 1; notasMes.push(n); });
      // entradas de meses anteriores importadas nesta competência (nota chegou agora)
      r[1].forEach(function (n) {
        if (!vistos[n.chave] && n.mes < comp && (n.papel === "entrada" || n.papel === "dev_compra")) { vistos[n.chave] = 1; notasMes.push(n); }
      });
      canceladas = r[2];
      calcular();
    }).catch(function (e) { progresso(null, "❌ " + e.message); });
  }

  function calcular() {
    var comp = $("comp").value, c = cfg();
    var ant = ls("apur:" + mesAnterior(comp));
    var sug = ant && ant.fechamento ? ant.fechamento.saldoCredor : null;
    if (c.saldoAnterior === undefined && sug !== null) { c.saldoAnterior = sug; setCfg(c); }

    // chips de contagem
    var k = { nfce: 0, nfeS: 0, ent: 0, canc: 0 };
    notasMes.forEach(function (n) {
      if (canceladas[n.chave]) k.canc++;
      else if (n.papel === "saida") n.mod === "65" ? k.nfce++ : k.nfeS++;
      else if (n.mes === comp) k.ent++;
    });
    $("apChips").innerHTML =
      '<span class="chip"><b>' + k.nfce.toLocaleString("pt-BR") + "</b> NFC-e</span>" +
      '<span class="chip"><b>' + k.nfeS + "</b> NF-e saída</span>" +
      '<span class="chip"><b>' + k.ent + "</b> entradas</span>" +
      (k.canc ? '<span class="chip"><b>' + k.canc + "</b> canceladas</span>" : "");

    var tem = notasMes.some(function (n) { return n.mes === comp; });
    $("apVazio").style.display = tem ? "none" : "";
    $("apRes").style.display = tem ? "" : "none";
    if (!tem) return;

    var R = Apuracao.apurar(notasMes, canceladas, {
      competencia: comp, produtos: window.DATA || [],
      incluirForaMes: !!c.incluirForaMes, excluirCredST: !!c.excluirCredST,
      saldoAnterior: c.saldoAnterior, antecipacaoPaga: c.antecipacaoPaga, estornos: c.estornos,
      outrosCreditos: c.outrosCreditos, outrosDebitos: c.outrosDebitos
    });
    ultimo = R;

    // campos editáveis
    var ins = document.querySelectorAll("#tab-apur [data-k]");
    for (var i = 0; i < ins.length; i++) {
      var el = ins[i], key = el.getAttribute("data-k");
      if (el.type === "checkbox") el.checked = !!c[key];
      else if (document.activeElement !== el) el.value = fmtIn(c[key]);
    }

    var ajuste = (num(c.estornos) + num(c.outrosDebitos)) - (num(c.saldoAnterior) + num(c.antecipacaoPaga) + num(c.outrosCreditos));
    $("kDeb").textContent = brl(R.debito);
    $("kCred").textContent = brl(R.credito);
    $("kAj").textContent = (ajuste > 0 ? "+" : "") + brl(ajuste);
    $("kResL").textContent = R.saldoCredor > 0 ? "Saldo credor p/ " + nomeMes(proxMes(comp)) : "ICMS a recolher";
    $("kRes").textContent = brl(R.saldoCredor > 0 ? R.saldoCredor : R.aRecolher);
    $("q1").textContent = brl(R.debito);
    $("q4").textContent = brl(R.totalDebitos);
    $("q5").textContent = brl(R.credito);
    $("q9").textContent = brl(R.totalCreditos);
    $("q10l").textContent = R.saldoCredor > 0 ? "Saldo credor a transportar" : "ICMS a recolher";
    $("q10").textContent = brl(R.saldoCredor > 0 ? R.saldoCredor : R.aRecolher);
    var credor = R.saldoCredor > 0;
    $("kHero").classList.toggle("credor", credor);
    $("qFin").classList.toggle("credor", credor);
    $("kResD").textContent = credor ? "Crédito a transportar para o próximo mês" : "Prévia gerencial de " + nomeMes(comp);

    var pe = R.alertas.perdas;
    $("hEst").innerHTML = pe.valorTrib > 0 ? "Perdas (5927) de itens tributados: " + brl(pe.valorTrib) + ". Estorne o ICMS creditado na compra deles (≈ " + brl(pe.valorTrib * Apuracao.ALIQ_MA) + " se foi a 23%). <a data-usa='estornos' data-v='" + (pe.valorTrib * Apuracao.ALIQ_MA).toFixed(2) + "'>usar</a>" : "";
    $("hAnt").innerHTML = R.antecipacaoEstimada > 0 ? "Estimativa pelas compras interestaduais: " + brl(R.antecipacaoEstimada) + ". Informe o valor pago no DARE. <a data-usa='antecipacaoPaga' data-v='" + R.antecipacaoEstimada.toFixed(2) + "'>usar estimativa</a>" : "Sem compras interestaduais tributadas no mês.";
    $("hSal").innerHTML = sug !== null ? "Fechamento de " + nomeMes(mesAnterior(comp)) + ": " + brl(sug) + ". <a data-usa='saldoAnterior' data-v='" + sug.toFixed(2) + "'>usar</a>" : "Primeiro mês no sistema: informe o saldo credor da última apuração oficial, se houver.";
    $("hST").textContent = R.creditoSTsuspeito > 0 ? "(" + brl(R.creditoSTsuspeito) + " neste mês)" : "";
    var fora = R.alertas.foraMes.filter(function (f) { return f.papel === "entrada" || f.papel === "dev_compra"; }).length;
    $("hFora").textContent = fora ? "(" + fora + " notas)" : "(nenhuma)";

    tabela("tDeb", R.debitos, "Débito");
    tabela("tCred", R.creditos, "Crédito");
    alertas(R);
    var f = c.fechamento;
    $("apSalvo").textContent = f ? "✓ Mês fechado em " + new Date(f.em).toLocaleString("pt-BR") + (Math.abs(f.saldoCredor - R.saldoCredor) > 0.005 || Math.abs(f.aRecolher - R.aRecolher) > 0.005 ? " (valores mudaram depois — feche de novo)" : "") : "";
  }
  function proxMes(c) { var p = c.split("-"), d = new Date(+p[0], +p[1], 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }

  function tabela(id, grupos, rot) {
    var ks = Object.keys(grupos).sort(function (a, b) { return grupos[b].valor - grupos[a].valor || a.localeCompare(b); });
    var h = "<tr><th>CFOP · CST</th><th class='val'>Itens</th><th class='val'>Base</th><th class='val'>" + rot + "</th></tr>";
    ks.forEach(function (k) {
      var g = grupos[k];
      h += "<tr" + (g.valor ? "" : " class='z'") + "><td>" + esc(k) + "</td><td class='val'>" + g.itens.toLocaleString("pt-BR") + "</td><td class='val'>" + brl(g.base) + "</td><td class='val'>" + brl(g.valor) + "</td></tr>";
    });
    $(id).innerHTML = h;
  }

  function bloco(nivel, titulo, cnt, corpo, aberto) {
    return "<details class='al'" + (aberto ? " open" : "") + "><summary><span class='lv " + nivel + "'></span>" + titulo + "<span class='cnt'>" + cnt + "</span></summary><div class='body'>" + corpo + "</div></details>";
  }
  function alertas(R) {
    var A = R.alertas, h = "";
    var cs = Object.values(A.credSTsuspeitos).sort(function (a, b) { return b.credito - a.credito; });
    if (cs.length) h += bloco("r", "Crédito tomado em produto que sai com ST", brl(R.creditoSTsuspeito),
      "<p>O fornecedor destacou ICMS, mas o mapeamento classifica o produto como ST (saída 5405). Na venda não há débito, então esse crédito tende a ser indevido. Confira o produto; se for mesmo ST, marque a opção de não aproveitar o crédito.</p>" +
      mini(["Produto", "EAN", "Fornecedor", "Crédito"], cs.map(function (x) { return [x.nome, x.ean, x.fornecedor, brl(x.credito)]; })), true);
    var dv = Object.values(A.divergencia).sort(function (a, b) { return b.vezes - a.vezes; });
    if (dv.length) h += bloco("a", "Vendas com CFOP diferente do mapeamento", dv.length + " produtos",
      "<p>O PDV emitiu o produto com um CFOP diferente do cadastrado no mapeamento. Se a nota estiver errada, o débito do mês fica errado.</p>" +
      mini(["Código", "Produto", "Mapeado", "Na nota", "Vendas", "ICMS debitado"], dv.map(function (x) { return [x.codigo, x.nome, x.mapeado, x.nota, x.vezes, brl(x.icms)]; })));
    if (A.aliquota.length) h += bloco("a", "Vendas tributadas com alíquota diferente de 23%", A.aliquota.length + " itens",
      mini(["NF", "Data", "Produto", "CFOP", "Alíq.", "ICMS"], A.aliquota.map(function (x) { return [x.nNF, x.data.split("-").reverse().join("/"), x.prod, x.cfop, x.pICMS + "%", brl(x.vICMS)]; })));
    if (A.perdas.qtd) h += bloco("a", "Baixas por perda / deterioração (CFOP 5927)", A.perdas.qtd + " itens · " + brl(A.perdas.valorTotal),
      "<p>Itens tributados: " + brl(A.perdas.valorTrib) + ". O crédito tomado na compra desses itens deve ser estornado (linha 003 do quadro).</p>");
    if (A.stSemCredito) h += bloco("i", "ICMS próprio em compras com ST (não creditado)", brl(A.stSemCredito),
      "<p>Notas com CST 10/70 trazem ICMS próprio do fornecedor. Como o produto sai com ST, esse valor não entra como crédito.</p>");
    var nm = Object.values(A.naoMapeados);
    if (nm.length) h += bloco("i", "Produtos vendidos que não estão no mapeamento", nm.length + " produtos",
      "<p><button class='btn-sec' onclick='apExportarNaoMapeados()'>⬇ Exportar lista (CSV)</button></p>" +
      mini(["Código", "Produto", "NCM", "CFOP"], nm.slice(0, 200).map(function (x) { return [x.codigo, x.nome, x.ncm, x.cfop]; })));
    if (R.fcp) h += bloco("i", "FCP / FUMACOP destacado nas saídas", brl(R.fcp), "<p>Adicional de combate à pobreza destacado nas notas. É recolhido à parte e não entra no saldo acima.</p>");
    var fora = A.foraMes.filter(function (f) { return f.papel !== "saida"; });
    if (fora.length) h += bloco("i", "Entradas emitidas em mês anterior", fora.length + " notas",
      "<p>Só entram na apuração se você marcar a opção no quadro. Não inclua se já foram creditadas no mês anterior.</p>" +
      mini(["NF", "Data", "Emitente"], fora.map(function (x) { return [x.nNF, x.data.split("-").reverse().join("/"), x.emit]; })));
    var c = R.contagem;
    if (c.cancelada || c.invalida) h += bloco("i", "Notas desconsideradas", (c.cancelada + c.invalida) + " notas", "<p>" + c.cancelada + " canceladas e " + c.invalida + " sem autorização. Não entram no cálculo.</p>");
    $("alertas").innerHTML = h || "<p class='sub'>Nenhum ponto de atenção encontrado. 🎉</p>";
  }
  function mini(cab, linhas) {
    var h = "<table class='mini'><tr>" + cab.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
    linhas.forEach(function (l) { h += "<tr>" + l.map(function (v) { return "<td>" + esc(v) + "</td>"; }).join("") + "</tr>"; });
    return h + "</table>";
  }

  // ---------- ações ----------
  function csv(linhas, nome) {
    var txt = linhas.map(function (l) {
      return l.map(function (v) {
        v = v === undefined || v === null ? "" : String(v);
        if (/^[=+\-@]/.test(v)) v = "'" + v;
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(";");
    }).join("\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + txt], { type: "text/csv;charset=utf-8;" }));
    a.download = nome; a.click();
  }
  function n2(v) { return (v || 0).toFixed(2).replace(".", ","); }

  window.apExportar = function () {
    if (!ultimo) return;
    var R = ultimo, c = cfg(), comp = $("comp").value, L = [];
    L.push(["Apuração assistida de ICMS — Farma Center", "Competência " + nomeMes(comp)]);
    L.push([]);
    L.push(["Linha", "Descrição", "Valor"]);
    L.push(["001", "Débito por saídas", n2(R.debito)]);
    L.push(["002", "Outros débitos", n2(num(c.outrosDebitos))]);
    L.push(["003", "Estornos de créditos", n2(num(c.estornos))]);
    L.push(["004", "Total de débitos", n2(R.totalDebitos)]);
    L.push(["005", "Crédito por entradas", n2(R.credito)]);
    L.push(["006", "Outros créditos", n2(num(c.outrosCreditos))]);
    L.push(["007", "Antecipação parcial paga", n2(num(c.antecipacaoPaga))]);
    L.push(["008", "Saldo credor do mês anterior", n2(num(c.saldoAnterior))]);
    L.push(["009", "Total de créditos", n2(R.totalCreditos)]);
    L.push(["010", R.saldoCredor > 0 ? "Saldo credor a transportar" : "ICMS a recolher", n2(R.saldoCredor || R.aRecolher)]);
    L.push([]);
    L.push(["Débitos", "Itens", "Base", "ICMS"]);
    Object.keys(R.debitos).forEach(function (k) { var g = R.debitos[k]; L.push([k, g.itens, n2(g.base), n2(g.valor)]); });
    L.push([]);
    L.push(["Créditos", "Itens", "Base", "ICMS"]);
    Object.keys(R.creditos).forEach(function (k) { var g = R.creditos[k]; L.push([k, g.itens, n2(g.base), n2(g.valor)]); });
    L.push([]);
    L.push(["Dia", "Débito", "Crédito"]);
    Object.keys(R.porDia).sort().forEach(function (d) { L.push([d.split("-").reverse().join("/"), n2(R.porDia[d].debito), n2(R.porDia[d].credito)]); });
    csv(L, "apuracao_icms_" + comp + ".csv");
  };
  window.apExportarNaoMapeados = function () {
    if (!ultimo) return;
    var L = [["Código", "Produto", "EAN", "NCM", "CFOP"]];
    Object.values(ultimo.alertas.naoMapeados).forEach(function (x) { L.push([x.codigo, x.nome, x.ean, x.ncm, x.cfop]); });
    csv(L, "produtos_nao_mapeados_" + $("comp").value + ".csv");
  };
  window.apSalvar = function () {
    if (!ultimo) return;
    var c = cfg();
    c.fechamento = { saldoCredor: ultimo.saldoCredor, aRecolher: ultimo.aRecolher, debito: ultimo.debito, credito: ultimo.credito, em: Date.now() };
    setCfg(c);
    calcular();
  };
  window.apLimpar = function () {
    var comp = $("comp").value;
    if (!confirm("Remover deste computador todas as notas de " + nomeMes(comp) + "? Você poderá importar de novo depois.")) return;
    abrirDB().then(function (d) {
      return new Promise(function (ok) {
        var tx = d.transaction("notas", "readwrite"), st = tx.objectStore("notas");
        notasMes.forEach(function (n) { if (n.mes === comp || n.imp === comp) st.delete(n.chave); });
        tx.oncomplete = ok; tx.onerror = ok;
      });
    }).then(carregar);
  };

  window.apRecalc = function () { if (iniciado && notasMes.length) calcular(); };

  window.apAbrir = function () {
    if (iniciado) return;
    iniciado = true;
    var hoje = new Date();
    $("comp").value = ls("apur:ultimaComp") || (hoje.getFullYear() + "-" + String(hoje.getMonth() + 1).padStart(2, "0"));
    $("comp").addEventListener("change", function () { if ($("comp").value) { ls("apur:ultimaComp", $("comp").value); carregar(); } });

    var drop = $("drop"), arq = $("arq");
    drop.addEventListener("click", function (e) { if (e.target !== arq) arq.click(); });
    arq.addEventListener("change", function () { if (arq.files.length) importar(arq.files); arq.value = ""; });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files.length) importar(e.dataTransfer.files); });

    var tab = $("tab-apur");
    tab.addEventListener("change", function (e) {
      var k = e.target.getAttribute && e.target.getAttribute("data-k");
      if (!k) return;
      var c = cfg();
      c[k] = e.target.type === "checkbox" ? e.target.checked : num(e.target.value);
      setCfg(c); calcular();
    });
    tab.addEventListener("click", function (e) {
      var k = e.target.getAttribute && e.target.getAttribute("data-usa");
      if (!k) return;
      var c = cfg(); c[k] = parseFloat(e.target.getAttribute("data-v")); setCfg(c); calcular();
    });
    carregar();
  };
})();
