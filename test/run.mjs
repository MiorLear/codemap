/**
 * Pruebas de extremo a extremo sobre examples/demo (copiado a una carpeta temporal para que
 * nada de lo que escriben toque el repo).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "bin", "codemap.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-test-"));
const demo = path.join(tmp, "demo");
fs.cpSync(path.join(REPO, "examples", "demo"), demo, { recursive: true, filter: (src) => !src.includes(`${path.sep}out`) });

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${String(e.message).split("\n").join("\n    ")}`);
  }
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: demo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`codemap ${args.join(" ")} falló:\n${r.stderr || r.stdout}`);
  return r.stdout;
};
const graph = () => JSON.parse(fs.readFileSync(path.join(demo, ".codemap", "out", "graph.json"), "utf8"));
const fn = (g, id) => g.fns[id] ?? assert.fail(`no existe ${id}`);

console.log("codemap · pruebas sobre examples/demo\n");

await test("el JavaScript del visor compila", () => {
  const html = fs.readFileSync(path.join(REPO, "src", "viewer.html"), "utf8");
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code.replace("/*__CODEMAP_DATA__*/null", "{}"));
});

await test("detecta la config de un proyecto que nunca se configuró", async () => {
  const { detectConfig } = await import(new URL("../src/project.mjs", import.meta.url));
  const cfg = detectConfig(demo);
  assert.deepEqual(cfg.groups.map((g) => g.prefix), ["src/", "web/", "worker/sync/"]);
  assert.deepEqual(cfg.python.roots, ["worker"]);
  assert.equal(cfg.rules.express4AsyncErrors, true);
  assert.ok(cfg.extensions.includes(".tsx") && cfg.extensions.includes(".py"));
});

cli("build");
const g = graph();

await test("encuentra archivos y funciones de TypeScript, TSX y Python", () => {
  assert.equal(Object.keys(g.files).length, 10);
  assert.ok(g.fns["src/pedidos/servicio.ts#resumen"]);
  assert.ok(g.fns["web/PedidoCard.tsx#PedidoCard"]);
  assert.ok(g.fns["worker/sync/tareas.py#sincronizar"]);
});

await test("resuelve rutas de Express con su prefijo y middlewares", () => {
  const r = fn(g, "src/pedidos/routes.ts#GET /pedidos/:id").route;
  assert.equal(r.fullPath, "/api/pedidos/:id");
  assert.deepEqual(r.mounts[0].middlewares, ["express.json()", "requiereClave"]);
});

await test("resuelve llamadas entre archivos", () => {
  const calls = fn(g, "src/pedidos/routes.ts#GET /pedidos/:id").calls;
  assert.ok(calls.includes("src/pedidos/servicio.ts#cargarPedido"));
  assert.ok(calls.includes("src/pedidos/servicio.ts#resumen"));
  assert.ok(fn(g, "src/pedidos/servicio.ts#cargarPedido").calls.includes("src/db.ts#buscar"));
});

await test("une la card con la ruta del backend por HTTP", () => {
  const h = g.http.find((x) => x.from === "web/PedidoCard.tsx#PedidoCard");
  assert.equal(h?.to, "src/pedidos/routes.ts#GET /pedidos/:id");
  assert.ok(g.apis["inventario.example.com"], "debería detectar la API externa");
});

await test("Python: subcomandos de argparse como entradas, con imports relativos", () => {
  const cmd = fn(g, "worker/sync/cli.py#CLI sincronizar");
  assert.equal(cmd.route.fullPath, "python -m sync.cli sincronizar");
  assert.deepEqual(cmd.calls, ["worker/sync/tareas.py#sincronizar"]);
  assert.ok(fn(g, "worker/sync/tareas.py#sincronizar").calls.includes("worker/sync/fuentes.py#leer_pedidos"));
});

await test("flujo interno: decisiones, respuestas y try/catch", () => {
  const flow = fn(g, "src/pedidos/routes.ts#POST /pedidos").flow;
  const kinds = flow.nodes.map((n) => n.kind);
  assert.ok(kinds.includes("decision") && kinds.includes("try") && kinds.includes("catch"));
  const codes = flow.nodes.map((n) => /responde (\d+)/.exec(n.label)?.[1]).filter(Boolean);
  assert.deepEqual(codes.sort(), ["201", "400", "502"]);
});

await test("lineamientos: await sin try en Express 4 y except silencioso", () => {
  const rules = (id) => fn(g, id).warnings.map((w) => w.rule);
  assert.ok(rules("src/pedidos/routes.ts#GET /pedidos/:id").includes("async-sin-try"));
  assert.ok(!rules("src/pedidos/routes.ts#POST /pedidos").includes("async-sin-try"));
  assert.ok(rules("worker/sync/tareas.py#limpiar").includes("except-silencioso"));
});

await test("diagrama primero: compara el plan con el código", () => {
  const out = cli("check", "pedidos-inventario-caido");
  assert.match(out, /Cumplimiento: 7\/9/);
  assert.match(out, /✗ intentar\s+← El código no tiene try\/catch/);
  assert.match(out, /✗ responde 502/);
});

await test("mapa de un solo archivo: el archivo y lo que importa", () => {
  cli("file", "src/pedidos/routes.ts");
  const html = fs.readFileSync(path.join(demo, ".codemap", "out", "archivo-src_pedidos_routes.ts.html"), "utf8");
  const one = JSON.parse(html.match(/const G = (\{.*?\});\n/s)[1]);
  assert.equal(one.meta.focus, "src/pedidos/routes.ts");
  assert.deepEqual(Object.keys(one.files).sort(), ["src/pedidos/routes.ts", "src/pedidos/servicio.ts"]);
});

await test("serve: guarda la revisión de un plan y rechaza estados inventados", async () => {
  const { serve } = await import(new URL("../src/serve.mjs", import.meta.url));
  const { server, url } = await serve({ project: demo, port: 0 }).catch(() => serve({ project: demo, port: 4399 }));
  const base = url.endsWith(":0") ? `http://localhost:${server.address().port}` : url;
  try {
    const post = (body) => fetch(`${base}/api/plans/pedidos-inventario-caido`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ estado: "inventado" })).status, 400);
    assert.equal((await post({ comentario: { paso: "c0-p5", texto: "Que diga cuándo reintentar" } })).status, 200);
    assert.equal((await post({ estado: "aprobado" })).status, 200);
    const plan = JSON.parse(fs.readFileSync(path.join(demo, ".codemap", "plans", "pedidos-inventario-caido.json"), "utf8"));
    assert.equal(plan.estado, "aprobado");
    assert.equal(plan.revision.at(-1).texto, "Que diga cuándo reintentar");
    assert.equal((await fetch(`${base}/api/plans/no-existe`, { method: "POST", body: "{}" })).status, 404);
  } finally {
    server.close();
  }
});

await test("hook: regenera al editar y no repite si nada cambió (proyecto sin git)", async () => {
  const state = path.join(demo, ".codemap", "out", ".hook-state.json");
  const hook = (payload = {}) => spawnSync(process.execPath, [CLI, "hook"], { cwd: demo, input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: demo } });
  const waitBuilt = async (previous) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = JSON.parse(fs.readFileSync(state, "utf8"));
      if (s.builtAt && s.builtAt !== previous && s.built === s.pendingPrint) return s.builtAt;
    }
    throw new Error("el hook no regeneró a tiempo");
  };
  fs.rmSync(state, { force: true });
  hook();
  const first = await waitBuilt(null);

  // Editar un archivo del mapa: tiene que regenerar
  const file = path.join(demo, "src", "db.ts");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  hook({ tool_name: "Edit", tool_input: { file_path: file } });
  const second = await waitBuilt(first);
  assert.notEqual(second, first);

  // Sin cambios: no se apunta ninguna regeneración nueva
  const before = JSON.parse(fs.readFileSync(state, "utf8")).pending;
  hook();
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).pending, before);

  // Un archivo que no es del mapa no dispara nada
  hook({ tool_name: "Edit", tool_input: { file_path: path.join(demo, "package.json") } });
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).pending, before);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nTodo bien.");
process.exit(failed ? 1 : 0);
