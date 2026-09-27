/* Apuração assistida de ICMS — Farma Center (MA)
 * Motor de cálculo. Roda 100% no navegador: os XMLs nunca saem do computador.
 * Também pode ser carregado no Node (para testes) passando um DOMParser.
 */
(function (root) {
  var CNPJ = "10862380000127";
  var ALIQ_MA = 0.23; // alíquota interna geral MA desde 23/02/2025 (Lei 12.426/2024)
  var CSTAT_OK = { "100": 1, "150": 1 };
  var CSTAT_CANC = { "101": 1, "135": 1, "151": 1, "155": 1 };
  var CST_CREDITO = { "00": 1, "20": 1, "51": 1, "90": 1 };
  var CST_ST = { "10": 1, "30": 1, "60": 1, "70": 1, "201": 1, "202": 1, "203": 1, "500": 1 };

  function txt(el, tag) {
    if (!el) return "";
    var n = el.getElementsByTagName(tag)[0];
    return n && n.textContent ? n.textContent.trim() : "";
  }
  function num(el, tag) { var v = parseFloat(txt(el, tag)); return isNaN(v) ? 0 : v; }
  function r2(v) { return Math.round(v * 100) / 100; }

  // Converte um XML (string) em nota ou evento. Retorna null se não for NF-e/NFC-e.
  function parseXml(str, DOMParserImpl) {
    var P = DOMParserImpl || root.DOMParser;
    var doc = new P().parseFromString(str, "text/xml");
    var evento = doc.getElementsByTagName("infEvento")[0];
    if (evento && !doc.getElementsByTagName("infNFe")[0]) {
      var retEv = doc.getElementsByTagName("retEvento")[0];
      var st = retEv ? txt(retEv, "cStat") : "";
      if (txt(evento, "tpEvento") === "110111" && (st === "135" || st === "155" || st === ""))
        return { tipo: "cancelamento", chave: txt(evento, "chNFe") };
      return null;
    }
    var inf = doc.getElementsByTagName("infNFe")[0];
    if (!inf) return null;
    var ide = inf.getElementsByTagName("ide")[0];
    var emit = inf.getElementsByTagName("emit")[0];
    var dest = inf.getElementsByTagName("dest")[0];
    var prot = doc.getElementsByTagName("infProt")[0];
    var nota = {
      tipo: "nota",
      chave: (inf.getAttribute("Id") || "").replace(/^NFe/, ""),
      mod: txt(ide, "mod"),
      nNF: txt(ide, "nNF"),
      serie: txt(ide, "serie"),
      data: (txt(ide, "dhEmi") || txt(ide, "dEmi")).slice(0, 10),
      tpNF: txt(ide, "tpNF"),
      natOp: txt(ide, "natOp"),
      emitCNPJ: txt(emit, "CNPJ") || txt(emit, "CPF"),
      emitNome: txt(emit, "xNome"),
      emitUF: txt(emit.getElementsByTagName("enderEmit")[0], "UF"),
      emitCRT: txt(emit, "CRT"),
      destCNPJ: dest ? (txt(dest, "CNPJ") || txt(dest, "CPF")) : "",
      cStat: prot ? txt(prot, "cStat") : "",
      vNF: num(inf.getElementsByTagName("ICMSTot")[0], "vNF"),
      itens: []
    };
    var dets = inf.getElementsByTagName("det");
    for (var i = 0; i < dets.length; i++) {
      var d = dets[i];
      var prod = d.getElementsByTagName("prod")[0];
      var icms = d.getElementsByTagName("ICMS")[0];
      var g = null;
      if (icms) for (var k = 0; k < icms.childNodes.length; k++) if (icms.childNodes[k].nodeType === 1) { g = icms.childNodes[k]; break; }
      nota.itens.push({
        cProd: txt(prod, "cProd"),
        xProd: txt(prod, "xProd"),
        ean: txt(prod, "cEAN"),
        ncm: txt(prod, "NCM"),
        cfop: txt(prod, "CFOP"),
        vProd: num(prod, "vProd"),
        vDesc: num(prod, "vDesc"),
        cst: g ? (txt(g, "CST") || txt(g, "CSOSN")) : "",
        vBC: num(g, "vBC"),
        pICMS: num(g, "pICMS"),
        vICMS: num(g, "vICMS"),
        vFCP: num(g, "vFCP"),
        vICMSST: num(g, "vICMSST"),
        vCredSN: num(g, "vCredICMSSN")
      });
    }
    return nota;
  }

  // Papel da nota do ponto de vista da Farma Center.
  function papel(n) {
    var propria = n.emitCNPJ === CNPJ;
    if (propria && n.tpNF === "1") return "saida";
    if (propria && n.tpNF === "0") return "entrada_propria";      // ex.: devolução de venda emitida por nós
    if (n.destCNPJ !== CNPJ) return "outra";
    if (n.tpNF === "1") return "entrada";                         // compra de fornecedor
    return "dev_compra";                                          // fornecedor emitiu entrada da nossa devolução
  }

  function limpaCod(c) { return String(c || "").replace(/^0+/, ""); }
  function eanValido(e) { return /^\d{8}$|^\d{12,14}$/.test(e || ""); }

  function indexarMapeamento(produtos) {
    var porEan = {}, porCod = {};
    (produtos || []).forEach(function (p) {
      if (eanValido(p.ean)) porEan[p.ean] = p;
      porCod[limpaCod(p.codigo)] = p;
    });
    return { porEan: porEan, porCod: porCod };
  }
  function ehST(cfop) { return /^[56]40[1-5]$/.test(cfop); }

  /* Calcula a apuração.
   * notas: lista de notas (parseXml) já deduplicadas por chave
   * canceladas: {chave:1}
   * opts: { competencia:"2026-09", produtos:[...], incluirForaMes:false, excluirCredST:false,
   *         saldoAnterior, antecipacaoPaga, estornos, outrosCreditos, outrosDebitos }
   */
  function apurar(notas, canceladas, opts) {
    opts = opts || {};
    var comp = opts.competencia;
    var mapa = indexarMapeamento(opts.produtos);
    var R = {
      debito: 0, credito: 0, fcp: 0,
      debitos: {}, creditos: {},
      creditoSTsuspeito: 0, antecipacaoEstimada: 0,
      contagem: { saida: 0, entrada: 0, entrada_propria: 0, dev_compra: 0, outra: 0, cancelada: 0, invalida: 0, foraMes: 0 },
      alertas: { foraMes: [], aliquota: [], divergencia: {}, naoMapeados: {}, perdas: { qtd: 0, valorTrib: 0, valorTotal: 0 }, stSemCredito: 0, credSTsuspeitos: {} },
      porDia: {}
    };
    function soma(obj, chave, v, base) {
      var o = obj[chave] || (obj[chave] = { valor: 0, base: 0, itens: 0 });
      o.valor += v; o.base += base || 0; o.itens++;
    }
    function dia(n, campo, v) {
      var o = R.porDia[n.data] || (R.porDia[n.data] = { debito: 0, credito: 0 });
      o[campo] += v;
    }

    notas.forEach(function (n) {
      if (canceladas[n.chave] || CSTAT_CANC[n.cStat]) { R.contagem.cancelada++; return; }
      if (n.cStat && !CSTAT_OK[n.cStat]) { R.contagem.invalida++; return; }
      var pp = papel(n);
      if (comp && n.data.slice(0, 7) !== comp) {
        R.contagem.foraMes++;
        R.alertas.foraMes.push({ chave: n.chave, data: n.data, papel: pp, emit: n.emitNome, nNF: n.nNF });
        var aceita = opts.incluirForaMes && (pp === "entrada" || pp === "dev_compra") && n.data < comp;
        if (!aceita) return;
      }
      R.contagem[pp]++;

      n.itens.forEach(function (it) {
        var chaveGrupo = it.cfop + " · CST " + it.cst;
        if (pp === "saida") {
          if (it.vICMS) { R.debito += it.vICMS; dia(n, "debito", it.vICMS); }
          R.fcp += it.vFCP;
          soma(R.debitos, chaveGrupo, it.vICMS, it.vBC);
          // conferências
          if (it.cst === "00" && it.vICMS > 0 && Math.abs(it.pICMS - ALIQ_MA * 100) > 0.01 && /^5/.test(it.cfop))
            R.alertas.aliquota.push({ nNF: n.nNF, data: n.data, prod: it.xProd, cfop: it.cfop, pICMS: it.pICMS, vICMS: it.vICMS });
          if (it.cfop === "5927") {
            R.alertas.perdas.qtd++; R.alertas.perdas.valorTotal += it.vProd;
            var pm = mapa.porCod[limpaCod(it.cProd)] || (eanValido(it.ean) && mapa.porEan[it.ean]);
            if (!pm || !ehST(pm.cfop)) R.alertas.perdas.valorTrib += it.vProd;
          }
          if (it.cfop === "5102" || it.cfop === "5405") {
            var m = mapa.porCod[limpaCod(it.cProd)] || (eanValido(it.ean) && mapa.porEan[it.ean]);
            var k = limpaCod(it.cProd);
            if (!m) R.alertas.naoMapeados[k] = R.alertas.naoMapeados[k] || { codigo: k, nome: it.xProd, ean: it.ean, ncm: it.ncm, cfop: it.cfop };
            else if (m.cfop !== it.cfop && (m.cfop === "5102" || m.cfop === "5405")) {
              var dv = R.alertas.divergencia[k] || (R.alertas.divergencia[k] = { codigo: k, nome: it.xProd, mapeado: m.cfop, nota: it.cfop, vezes: 0, icms: 0 });
              dv.vezes++; dv.icms += it.vICMS;
            }
          }
        } else if (pp === "entrada" || pp === "entrada_propria") {
          var cred = 0;
          if (CST_CREDITO[it.cst]) cred = it.vICMS;
          else if (it.cst === "101" || it.cst === "201" || it.cst === "900") cred = it.vCredSN || (it.cst === "900" ? it.vICMS : 0);
          else if (CST_ST[it.cst] && it.vICMS) R.alertas.stSemCredito += it.vICMS; // ICMS próprio em operação com ST: não credita
          var mp = eanValido(it.ean) && mapa.porEan[it.ean];
          var suspeito = pp === "entrada" && cred > 0 && mp && ehST(mp.cfop);
          if (suspeito) {
            R.creditoSTsuspeito += cred;
            var ks = it.ean;
            var cs = R.alertas.credSTsuspeitos[ks] || (R.alertas.credSTsuspeitos[ks] = { ean: ks, nome: mp.nome, fornecedor: n.emitNome, credito: 0, itens: 0 });
            cs.credito += cred; cs.itens++;
            if (opts.excluirCredST) cred = 0;
          }
          if (cred) { R.credito += cred; dia(n, "credito", cred); }
          soma(R.creditos, (pp === "entrada_propria" ? "Própria " : "") + chaveGrupo + (n.emitUF && n.emitUF !== "MA" ? " · " + n.emitUF : ""), cred, it.vBC);
          // antecipação parcial (compras interestaduais p/ comercialização de produto tributado)
          if (pp === "entrada" && /^6/.test(it.cfop) && !CST_ST[it.cst] && !ehST(it.cfop) && !(mp && ehST(mp.cfop))) {
            var base = it.vBC || (it.vProd - it.vDesc);
            R.antecipacaoEstimada += Math.max(0, base * ALIQ_MA - (it.vICMS || it.vCredSN));
          }
        } else if (pp === "dev_compra") {
          // nota de entrada emitida pelo fornecedor na nossa devolução: estorna o crédito
          if (it.vICMS) { R.debito += it.vICMS; dia(n, "debito", it.vICMS); }
          soma(R.debitos, "Devolução de compra (NF do fornecedor) · CST " + it.cst, it.vICMS, it.vBC);
        }
      });
    });

    var ajustesCred = (+opts.saldoAnterior || 0) + (+opts.antecipacaoPaga || 0) + (+opts.outrosCreditos || 0);
    var ajustesDeb = (+opts.estornos || 0) + (+opts.outrosDebitos || 0);
    R.debito = r2(R.debito); R.credito = r2(R.credito); R.fcp = r2(R.fcp);
    R.antecipacaoEstimada = r2(R.antecipacaoEstimada); R.creditoSTsuspeito = r2(R.creditoSTsuspeito);
    R.totalDebitos = r2(R.debito + ajustesDeb);
    R.totalCreditos = r2(R.credito + ajustesCred);
    R.saldo = r2(R.totalDebitos - R.totalCreditos);
    R.aRecolher = R.saldo > 0 ? R.saldo : 0;
    R.saldoCredor = R.saldo < 0 ? -R.saldo : 0;
    return R;
  }

  var api = { CNPJ: CNPJ, ALIQ_MA: ALIQ_MA, parseXml: parseXml, papel: papel, apurar: apurar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Apuracao = api;
})(typeof window !== "undefined" ? window : globalThis);
