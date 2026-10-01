/**
 * Diagrama primero: planes que el agente propone ANTES de escribir codigo, y la comparacion
 * del codigo real contra el plan.
 *
 * Un plan vive en `.codemap/plans/<id>.json` y describe, por cada funcion que se va a crear o
 * modificar, los pasos de su flujo con el mismo vocabulario que el diagrama de una funcion:
 *
 *   { "hacer": "Cargar los datos", "llama": ["cargarPedido"] }
 *   { "si": "¿dealId no es numerico?", "entonces": [...], "sino": [...] }
 *   { "intentar": [...], "siFalla": [...] }          // try / catch
 *   { "repetir": "cada contacto del negocio", "pasos": [...] }
 *   { "responde": 502, "detalle": "No se pudo leer el CRM" }
 *   { "devuelve": "el payload" }   { "lanza": "Error de validacion" }
 *
 * El humano lo revisa como diagrama, comenta pasos concretos y lo aprueba (serve.mjs escribe
 * en el archivo). Cuando el codigo existe, cada paso verificable se marca:
 *   ok     el codigo hace eso (llama a esa funcion, responde ese codigo, tiene ese try...)
 *   falta  el plan lo pide y el codigo no lo hace
 * y aparte se listan las llamadas y respuestas del codigo que el plan no preveia.
 */

import fs from "node:fs";
import path from "node:path";

export const PLAN_STATES = ["propuesto", "cambios", "aprobado", "implementado"];

export function loadPlans(dir, graph) {
  if (!fs.existsSync(dir)) return [];
  const plans = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (e) {
      plans.push({ id: file.replace(/\.json$/, ""), titulo: file, estado: "invalido", error: e.message, cambios: [] });
      continue;
    }
    plan.id ??= file.replace(/\.json$/, "");
    plan.estado = PLAN_STATES.includes(plan.estado) ? plan.estado : "propuesto";
    plan.cambios = (plan.cambios ?? []).map((c, ci) => evaluateChange(c, ci, graph));
    const checks = plan.cambios.flatMap((c) => c.flow.nodes.filter((n) => n.check));
    plan.cumplimiento = {
      ok: checks.filter((n) => n.check === "ok").length,
      falta: checks.filter((n) => n.check === "falta").length,
      total: checks.length,
      extras: plan.cambios.reduce((n, c) => n + c.extras.length, 0),
    };
    plans.push(plan);
  }
  return plans;
}

function evaluateChange(change, ci, graph) {
  const flow = stepsToFlow(change.pasos ?? [], `c${ci}`);
  const code = graph.fns[change.funcion] ?? null;
  const out = { ...change, flow, existe: !!code, extras: [], notas: [] };
  if (!code) {
    out.notas.push(change.accion === "crear" ? "La función aún no existe: se verificará cuando se escriba." : "No existe una función con ese id en el mapa.");
    return out;
  }

  const codeNodes = code.flow?.nodes ?? [];
  const codeCalls = new Set(code.calls);
  const codeCodes = new Set(codeNodes.map((n) => /responde (\d+)/.exec(n.label)?.[1]).filter(Boolean));
  const has = (kind) => codeNodes.filter((n) => n.kind === kind).length;
  const planCounts = { decision: 0 };

  for (const n of flow.nodes) {
    if (n.llama?.length) {
      const missing = n.llama.filter((name) => !resolveNames(name, graph).some((id) => codeCalls.has(id)));
      n.check = missing.length ? "falta" : "ok";
      if (missing.length) n.porque = `El código no llama a ${missing.join(", ")}`;
    } else if (n.kind === "respond" && n.codigo) {
      n.check = codeCodes.has(String(n.codigo)) ? "ok" : "falta";
      if (n.check === "falta") n.porque = `El código nunca responde ${n.codigo}`;
    } else if (n.kind === "try") {
      n.check = has("try") ? "ok" : "falta";
      if (n.check === "falta") n.porque = "El código no tiene try/catch";
    } else if (n.kind === "loop") {
      n.check = has("loop") ? "ok" : "falta";
      if (n.check === "falta") n.porque = "El código no tiene ningún bucle";
    } else if (n.kind === "decision") {
      planCounts.decision++;
      n.check = has("decision") >= planCounts.decision ? "ok" : "falta";
      if (n.check === "falta") n.porque = `El plan pide al menos ${planCounts.decision} decisiones y el código tiene ${has("decision")}`;
    }
  }

  // Lo que el codigo hace y el plan no menciona: no es un error, pero hay que verlo
  const planned = new Set(flow.nodes.flatMap((n) => n.llama ?? []).flatMap((name) => resolveNames(name, graph)));
  for (const c of code.calls) {
    if (!planned.has(c)) out.extras.push({ tipo: "llamada", texto: `Llama a ${graph.fns[c]?.name ?? c}, que el plan no menciona`, id: c });
  }
  const plannedCodes = new Set(flow.nodes.filter((n) => n.kind === "respond" && n.codigo).map((n) => String(n.codigo)));
  for (const k of codeCodes) {
    if (plannedCodes.size && !plannedCodes.has(k)) out.extras.push({ tipo: "respuesta", texto: `Responde ${k}, que el plan no menciona` });
  }
  if (change.accion === "modificar" && !code.change) out.notas.push("La función no ha cambiado todavía respecto a la base.");
  out.avisosCodigo = code.warnings;
  return out;
}

/** "cargarPedido", "Clase.metodo" o un id completo "archivo#nombre". */
function resolveNames(name, graph) {
  if (graph.fns[name]) return [name];
  return Object.values(graph.fns).filter((f) => f.name === name || f.name.endsWith("." + name)).map((f) => f.id);
}

/** Pasos anidados del plan → el mismo {nodes, edges} que el flujo de una funcion. */
function stepsToFlow(steps, prefix) {
  const nodes = [];
  const edges = [];
  const add = (kind, label, extra = {}) => {
    const id = `${prefix}-p${nodes.length}`;
    nodes.push({ id, kind, label, ...extra });
    return id;
  };
  const link = (preds, to) => preds.forEach((p) => edges.push({ from: p.id, to, label: p.label ?? null, dashed: !!p.dashed }));

  const start = add("start", "inicio");
  const exits = seq(steps, [{ id: start }]);
  if (exits.length) link(exits, add("end", "fin"));
  return { nodes, edges };

  function seq(list, preds) {
    let cur = preds;
    for (const s of list) {
      if (!cur.length) break;
      if ("si" in s) {
        const d = add("decision", s.si);
        link(cur, d);
        const t = seq(s.entonces ?? [], [{ id: d, label: "sí" }]);
        const e = s.sino ? seq(s.sino, [{ id: d, label: "no" }]) : [{ id: d, label: "no" }];
        cur = [...t, ...e];
      } else if ("intentar" in s) {
        const t = add("try", "intentar");
        link(cur, t);
        const te = seq(s.intentar, [{ id: t }]);
        let ce = [];
        if (s.siFalla) {
          const c = add("catch", "si falla");
          link([{ id: t, label: "error", dashed: true }], c);
          ce = seq(s.siFalla, [{ id: c }]);
        }
        cur = [...te, ...ce];
      } else if ("repetir" in s) {
        const l = add("loop", `para ${s.repetir}`);
        link(cur, l);
        const be = seq(s.pasos ?? [], [{ id: l, label: "cada" }]);
        link(be.map((b) => ({ ...b, label: null, dashed: true })), l);
        cur = [{ id: l, label: "fin" }];
      } else if ("responde" in s) {
        const id = add("respond", `responde ${s.responde}${s.detalle ? ` · ${s.detalle}` : ""}`, { codigo: s.responde, final: s.final !== false });
        link(cur, id);
        // Responder casi siempre termina el camino; "final": false si sigue haciendo cosas
        cur = s.final === false ? [{ id }] : [];
      } else if ("devuelve" in s) {
        link(cur, add("return", `devuelve ${s.devuelve}`));
        cur = [];
      } else if ("lanza" in s) {
        link(cur, add("throw", `lanza ${s.lanza}`));
        cur = [];
      } else {
        const id = add("action", s.hacer ?? JSON.stringify(s), { llama: s.llama ?? [] });
        link(cur, id);
        cur = [{ id }];
      }
    }
    return cur;
  }
}

/** Texto para la terminal: lo que el agente lee para saber si su codigo cumple el plan. */
export function formatPlan(plan) {
  const lines = [`Plan ${plan.id} · ${plan.titulo} · estado: ${plan.estado}`];
  const c = plan.cumplimiento;
  lines.push(`Cumplimiento: ${c.ok}/${c.total} pasos verificables${c.falta ? ` · faltan ${c.falta}` : ""}${c.extras ? ` · ${c.extras} cosas no previstas` : ""}`);
  for (const ch of plan.cambios) {
    lines.push(`\n· ${ch.accion ?? "modificar"} ${ch.funcion}`);
    for (const n of ch.notas) lines.push(`  nota: ${n}`);
    for (const n of ch.flow.nodes.filter((x) => x.check)) lines.push(`  ${n.check === "ok" ? "✓" : "✗"} ${n.label.replace(/\n/g, " ")}${n.porque ? `  ← ${n.porque}` : ""}`);
    for (const x of ch.extras) lines.push(`  + ${x.texto}`);
  }
  for (const r of plan.revision ?? []) lines.push(`\nRevisión${r.paso ? ` (paso ${r.paso})` : ""}: ${r.texto}`);
  return lines.join("\n");
}
