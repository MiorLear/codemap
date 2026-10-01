"""
Extractor de Python para codemap.

Hace con el modulo `ast` de la libreria estandar lo mismo que `build.mjs` hace con el
compilador de TypeScript: imports resueltos a archivos, funciones y metodos, llamadas
resueltas a su definicion, rutas de FastAPI, subcomandos de argparse y el flujo interno de
cada funcion. Devuelve JSON con la misma forma que el lado TypeScript para que el visor no
tenga que distinguir lenguajes.

Entrada (stdin):  {"root": "...", "files": ["worker/sync/x.py", ...], "roots": ["worker"]}
Salida (stdout):  {"files": {...}, "fns": {...}, "externals": {...}}
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

HTTP_VERBS = {"get", "post", "put", "patch", "delete"}
STDLIB = set(getattr(sys, "stdlib_module_names", ()))


def main() -> None:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    root = Path(req["root"])
    files = req["files"]
    roots = req.get("roots", [])
    file_set = set(files)

    # Nombre de modulo -> archivo, para resolver `src.fusion` o `.fusion`
    modules: dict[str, str] = {}
    for f in files:
        for r in roots:
            if f.startswith(r.rstrip("/") + "/"):
                rel = f[len(r.rstrip("/")) + 1 :][: -len(".py")]
                parts = rel.split("/")
                if parts[-1] == "__init__":
                    parts = parts[:-1]
                modules[".".join(parts)] = f

    trees: dict[str, ast.Module] = {}
    sources: dict[str, str] = {}
    for f in files:
        src = (root / f).read_text(encoding="utf-8")
        sources[f] = src
        trees[f] = ast.parse(src, filename=f)

    out = {"files": {}, "fns": {}, "externals": {}}
    defs: dict[str, dict[str, str]] = {}  # archivo -> nombre local -> id de funcion
    classes: dict[str, set[str]] = {}

    # ── Primera pasada: definiciones ──
    for f, tree in trees.items():
        module_name = next((m for m, p in modules.items() if p == f), None)
        doc = ast.get_docstring(tree)
        out["files"][f] = {
            "id": f,
            "name": Path(f).name,
            "doc": doc,
            "lines": len(sources[f].splitlines()),
            "imports": [],
            "fns": [],
            "warnings": [] if doc else [warn("sin-descripcion", "El modulo no explica para que existe (falta docstring).")],
            "lang": "py",
            "_module": module_name,
        }
        defs[f] = {}
        classes[f] = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                route = fastapi_route(node)
                name = f"{route['method']} {route['path']}" if route else node.name
                fn = add_fn(out, f, sources[f], name, node, kind="route" if route else "function")
                if route:
                    fn["route"] = {
                        "method": route["method"],
                        "path": route["path"],
                        "fullPath": route["path"],
                        "server": f,
                        "middlewares": [],
                        "mounts": [{"server": f, "fullPath": route["path"], "middlewares": []}],
                    }
                defs[f][node.name] = fn["id"]
            elif isinstance(node, ast.ClassDef):
                classes[f].add(node.name)
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        fn = add_fn(out, f, sources[f], f"{node.name}.{m.name}", m, kind="method")
                        fn["exported"] = not node.name.startswith("_") and not m.name.startswith("_")
                        defs[f][f"{node.name}.{m.name}"] = fn["id"]

    # ── Imports: que nombre local apunta a que archivo o funcion ──
    # Como en Python: los imports del modulo valen en todo el archivo; un import perezoso dentro
    # de una funcion solo vale en esa funcion (y tapa al del modulo si se llama igual).
    def bind_imports(f: str, nodes) -> dict[str, tuple[str, str | None]]:
        scope: dict[str, tuple[str, str | None]] = {}
        mod = out["files"][f]["_module"] or ""
        pkg = mod if f.endswith("__init__.py") else mod.rsplit(".", 1)[0]
        for node in nodes:
            if isinstance(node, ast.Import):
                for a in node.names:
                    target = modules.get(a.name)
                    record_import(out, f, a.name, target, [a.asname or a.name])
                    if target:
                        scope[a.asname or a.name.split(".")[0]] = (target, None)
            elif isinstance(node, ast.ImportFrom):
                base = resolve_relative(node.module, node.level, pkg)
                names = [a.name for a in node.names]
                base_file = modules.get(base) if base else None
                if base_file:
                    record_import(out, f, base, base_file, names)
                for a in node.names:
                    sub = modules.get(f"{base}.{a.name}" if base else a.name)
                    if sub:  # from . import fusion as fus
                        record_import(out, f, a.name, sub, [a.name])
                        scope[a.asname or a.name] = (sub, None)
                    elif base_file:
                        scope[a.asname or a.name] = (base_file, a.name)
                if not base_file and not any(modules.get(f"{base}.{a.name}" if base else a.name) for a in node.names):
                    record_import(out, f, base or "", None, names)
        return scope

    module_scopes = {f: bind_imports(f, walk(tree, deep=False)) for f, tree in trees.items()}

    # ── Segunda pasada: llamadas, flujos, comandos ──
    def resolve(f: str, func: ast.AST, cls: str | None, local: dict) -> str | None:
        scope = {**module_scopes[f], **local}

        def from_scope(n: str, attr: str | None = None) -> str | None:
            target, name = scope[n]
            if attr is None:
                return defs[target].get(name) or defs[target].get(f"{name}.__init__") if name else None
            return defs[target].get(attr if name is None else f"{name}.{attr}")

        if isinstance(func, ast.Name):
            n = func.id
            if n in local:
                return from_scope(n)
            if n in defs[f]:
                return defs[f][n]
            if n in classes[f]:
                return defs[f].get(f"{n}.__init__")
            if n in scope:
                return from_scope(n)
            return None
        if isinstance(func, ast.Attribute):
            v = func.value
            if isinstance(v, ast.Name):
                if v.id in ("self", "cls") and cls:
                    return defs[f].get(f"{cls}.{func.attr}")
                if v.id in classes[f] and v.id not in local:
                    return defs[f].get(f"{v.id}.{func.attr}")
                if v.id in scope:
                    return from_scope(v.id, func.attr)
            # __import__("src.medir", fromlist=["comando"]).comando(a)
            if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "__import__" and v.args and isinstance(v.args[0], ast.Constant):
                target = modules.get(str(v.args[0].value))
                if target:
                    return defs[target].get(func.attr)
        return None

    def calls_in(f: str, node: ast.AST, cls: str | None, local: dict) -> list[str]:
        found: list[str] = []
        for n in walk(node, True):
            if isinstance(n, ast.Call):
                t = resolve(f, n.func, cls, local)
                if t:
                    found.append(t)
                for a in [*n.args, *[k.value for k in n.keywords]]:
                    if isinstance(a, (ast.Name, ast.Attribute)):
                        t = resolve(f, a, cls, local)
                        if t:
                            found.append(t)
        return list(dict.fromkeys(found))

    for f, tree in trees.items():
        for node in tree.body:
            targets = []
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                targets.append((node, None))
            elif isinstance(node, ast.ClassDef):
                targets += [(m, node.name) for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
            for fnode, cls in targets:
                route = fastapi_route(fnode) if cls is None else None
                key = f"{cls}.{fnode.name}" if cls else (f"{route['method']} {route['path']}" if route else fnode.name)
                fid = f"{f}#{key}"
                fn = out["fns"][fid]
                local = bind_imports(f, (n for n in ast.walk(fnode) if n is not fnode))
                fn["calls"] = [c for c in calls_in(f, fnode, cls, local) if c != fid]
                fn["flow"] = FlowBuilder(f, sources[f], lambda n, _f=f, _c=cls, _l=local: calls_in(_f, n, _c, _l)).build(fnode)
                fn["warnings"] += except_warnings(fnode)
                if cls is None and fnode.name == "main":
                    for cmd in argparse_commands(fnode):
                        cmd_calls = []
                        for expr in cmd["targets"]:
                            t = resolve(f, expr, None, local) if isinstance(expr, (ast.Name, ast.Attribute)) else None
                            cmd_calls += [t] if t else calls_in(f, expr, None, local)
                        cid = f"{f}#CLI {cmd['name']}"
                        out["fns"][cid] = {
                            "id": cid, "file": f, "name": f"CLI {cmd['name']}", "kind": "route", "lang": "py",
                            "exported": True, "async": False, "line": cmd["line"], "endLine": cmd["endLine"],
                            "doc": cmd["help"], "summary": cmd["help"], "summarySource": "jsdoc" if cmd["help"] else None,
                            "code": ast.get_source_segment(sources[f], cmd["node"]) or "",
                            "calls": list(dict.fromkeys(cmd_calls)), "calledBy": [], "flow": None, "warnings": [],
                            "route": {"method": "CLI", "path": cmd["name"], "fullPath": f"python -m {out['files'][f].get('_module') or Path(f).stem} {cmd['name']}", "server": f,
                                      "middlewares": [], "mounts": [{"server": f, "fullPath": f"python -m {out['files'][f].get('_module') or Path(f).stem} {cmd['name']}", "middlewares": []}]},
                        }
                        out["files"][f]["fns"].append(cid)

    for fi in out["files"].values():
        fi.pop("_module", None)
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


# ───────────────────────── Definiciones ─────────────────────────

def add_fn(out: dict, f: str, src: str, name: str, node: ast.AST, kind: str) -> dict:
    doc = ast.get_docstring(node)
    code = ast.get_source_segment(src, node, padded=True) or ""
    start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
    if code.count("\n") > 300:
        code = "\n".join(code.splitlines()[:300]) + "\n# …"
    fid = f"{f}#{name}"
    fn = {
        "id": fid, "file": f, "name": name, "kind": kind, "lang": "py",
        "exported": not getattr(node, "name", "_").startswith("_"),
        "async": isinstance(node, ast.AsyncFunctionDef),
        "line": start, "endLine": node.end_lineno,
        "doc": doc, "summary": None, "summarySource": "jsdoc" if doc else None,
        "code": code, "calls": [], "calledBy": [], "flow": None, "warnings": [],
    }
    out["fns"][fid] = fn
    out["files"][f]["fns"].append(fid)
    return fn


def fastapi_route(node: ast.AST) -> dict | None:
    for d in getattr(node, "decorator_list", []):
        if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in HTTP_VERBS and d.args and isinstance(d.args[0], ast.Constant):
            return {"method": d.func.attr.upper(), "path": str(d.args[0].value)}
    return None


def argparse_commands(main: ast.AST) -> list[dict]:
    """`x = sub.add_parser("extraer", help=...)` + `x.set_defaults(func=extraer)`."""
    parsers: dict[str, dict] = {}
    cmds = []
    for n in ast.walk(main):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == "add_parser":
            name_arg = n.value.args[0] if n.value.args else None
            if isinstance(name_arg, ast.Constant) and isinstance(n.targets[0], ast.Name):
                help_ = next((k.value.value for k in n.value.keywords if k.arg == "help" and isinstance(k.value, ast.Constant)), None)
                parsers[n.targets[0].id] = {"name": str(name_arg.value), "help": help_, "line": n.lineno, "node": n}
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "set_defaults" and isinstance(n.func.value, ast.Name):
            p = parsers.get(n.func.value.id)
            func = next((k.value for k in n.keywords if k.arg == "func"), None)
            if p and func is not None:
                target = func.body if isinstance(func, ast.Lambda) else func
                cmds.append({**p, "targets": [target], "endLine": n.end_lineno})
    return cmds


def resolve_relative(module: str | None, level: int, pkg: str) -> str | None:
    if level == 0:
        return module
    parts = pkg.split(".") if pkg else []
    base = parts[: len(parts) - (level - 1)] if level > 1 else parts
    return ".".join([*base, *([module] if module else [])]) or None


def record_import(out: dict, f: str, spec: str, target: str | None, names: list[str]) -> None:
    fi = out["files"][f]
    if target:
        if target != f and not any(i["to"] == target for i in fi["imports"]):
            fi["imports"].append({"to": target, "internal": True, "typeOnly": False, "names": names})
        return
    top = spec.split(".")[0]
    if not top or top == "__future__":
        return
    pkg = f"py:{top}" if top in STDLIB else top
    if any(i["to"] == pkg for i in fi["imports"]):
        return
    fi["imports"].append({"to": pkg, "internal": False, "typeOnly": False, "names": names})
    out["externals"].setdefault(pkg, {"name": pkg, "builtin": top in STDLIB, "usedBy": []})["usedBy"].append(f)


def walk(node: ast.AST, deep: bool):
    """ast.walk, pero sin entrar en funciones anidadas si `deep` es False."""
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        for c in ast.iter_child_nodes(n):
            if not deep and isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            stack.append(c)


# ───────────────────────── Lineamientos ─────────────────────────

def except_warnings(fnode: ast.AST) -> list[dict]:
    ws = []
    for n in ast.walk(fnode):
        if isinstance(n, ast.ExceptHandler):
            silent = all(isinstance(s, (ast.Pass, ast.Continue)) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)) for s in n.body)
            if n.type is None:
                ws.append(warn("except-desnudo", f"Linea {n.lineno}: `except:` sin tipo captura tambien Ctrl+C y errores de programacion."))
            elif silent:
                ws.append(warn("except-silencioso", f"Linea {n.lineno}: se captura `{ast.unparse(n.type)}` y se sigue sin registrar nada. Si es a proposito (un parseo que puede fallar) esta bien; si no, el error queda oculto."))
    return ws


def warn(rule: str, msg: str) -> dict:
    return {"rule": rule, "msg": msg}


# ───────────────────────── Flujo interno ─────────────────────────

class FlowBuilder:
    """El mismo formato de flujo que el lado TypeScript: nodos (start, action, decision, loop,
    try, catch, respond, return, throw, end) y aristas con etiqueta."""

    def __init__(self, f: str, src: str, calls_of):
        self.f, self.src, self.calls_of = f, src, calls_of
        self.nodes: list[dict] = []
        self.edges: list[dict] = []

    def add(self, kind: str, label: str, line: int | None = None, calls: list[str] | None = None) -> str:
        nid = f"f{len(self.nodes)}"
        self.nodes.append({"id": nid, "kind": kind, "label": label, "line": line, "calls": calls or []})
        return nid

    def link(self, preds: list[dict], to: str) -> None:
        for p in preds:
            self.edges.append({"from": p["id"], "to": to, "label": p.get("label"), "dashed": p.get("dashed", False)})

    def build(self, fnode: ast.AST) -> dict:
        args = [a.arg for a in fnode.args.args if a.arg not in ("self", "cls")]
        start = self.add("start", f"entrada: {short(', '.join(args), 50)}" if args else "inicio", fnode.lineno)
        exits = self.seq(fnode.body, [{"id": start}], skip_doc=True)
        if exits:
            self.link(exits, self.add("end", "fin"))
        return {"nodes": self.nodes, "edges": self.edges}

    def seq(self, stmts: list[ast.stmt], preds: list[dict], skip_doc: bool = False) -> list[dict]:
        cur = preds
        buf: list[tuple[str, int]] = []

        def flush():
            nonlocal cur, buf
            if buf:
                nid = self.add("action", "\n".join(b[0] for b in buf), buf[0][1])
                self.link(cur, nid)
                cur, buf = [{"id": nid}], []

        def own(kind, label, node, calls=None):
            nonlocal cur
            flush()
            nid = self.add(kind, label, node.lineno, self.calls_of(node) if calls is None else calls)
            self.link(cur, nid)
            cur = [{"id": nid}]
            return nid

        for i, s in enumerate(stmts):
            if not cur and not buf:
                break
            if skip_doc and i == 0 and isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str):
                continue  # el docstring no es un paso
            if isinstance(s, ast.If):
                d = own("decision", f"¿{short(ast.unparse(s.test), 70)}?", s.test)
                t = self.seq(s.body, [{"id": d, "label": "sí"}])
                e = self.seq(s.orelse, [{"id": d, "label": "no"}]) if s.orelse else [{"id": d, "label": "no"}]
                cur = t + e
            elif isinstance(s, ast.Return):
                r = response_label(s.value) if s.value is not None else None
                own("respond" if r else "return", r or (f"devuelve {short(ast.unparse(s.value), 60)}" if s.value is not None else "return"), s)
                cur = []
            elif isinstance(s, ast.Raise):
                r = response_label(s.exc) if s.exc is not None else None
                own("respond" if r else "throw", r or (f"lanza {short(ast.unparse(s.exc), 60)}" if s.exc is not None else "relanza"), s)
                cur = []
            elif isinstance(s, (ast.Try, getattr(ast, "TryStar", ast.Try))):
                t = own("try", "try", s, calls=[])
                te = self.seq(s.body, [{"id": t}])
                if s.orelse:
                    te = self.seq(s.orelse, te)
                ce = []
                for h in s.handlers:
                    c = self.add("catch", f"except {ast.unparse(h.type) if h.type else ''}{' as ' + h.name if h.name else ''}".strip(), h.lineno)
                    self.link([{"id": t, "label": "error", "dashed": True}], c)
                    ce += self.seq(h.body, [{"id": c}])
                cur = te + ce
                if s.finalbody:
                    cur = self.seq(s.finalbody, cur or [{"id": t, "label": "finally"}])
            elif isinstance(s, (ast.For, ast.AsyncFor, ast.While)):
                label = f"para cada {short(ast.unparse(s.target), 30)} en {short(ast.unparse(s.iter), 40)}" if not isinstance(s, ast.While) else f"mientras {short(ast.unparse(s.test), 50)}"
                l = own("loop", label, s, calls=self.calls_of(s.iter if not isinstance(s, ast.While) else s.test))
                be = self.seq(s.body, [{"id": l, "label": "cada"}])
                self.link([{**b, "label": None, "dashed": True} for b in be], l)
                cur = [{"id": l, "label": "fin"}]
            elif isinstance(s, (ast.With, ast.AsyncWith)):
                items = ", ".join(ast.unparse(it.context_expr) + (f" as {ast.unparse(it.optional_vars)}" if it.optional_vars else "") for it in s.items)
                own("action", f"con {short(items, 60)}", s, calls=[c for it in s.items for c in self.calls_of(it.context_expr)])
                cur = self.seq(s.body, cur)
            elif isinstance(s, ast.Match):
                d = own("decision", f"según {short(ast.unparse(s.subject), 50)}", s.subject)
                out = []
                for case in s.cases:
                    out += self.seq(case.body, [{"id": d, "label": short(ast.unparse(case.pattern), 30)}])
                cur = out
            elif isinstance(s, (ast.Break, ast.Continue)):
                flush()
                return cur
            elif isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                buf.append((f"define {s.name}()", s.lineno))
            else:
                calls = self.calls_of(s)
                label = simple_label(s)
                if calls:
                    own("action", label, s, calls)
                else:
                    buf.append((label, s.lineno))
                    if len(buf) == 3:
                        flush()
        flush()
        return cur


def response_label(expr: ast.AST) -> str | None:
    """`raise HTTPException(status_code=400, detail="…")` o `return JSONResponse(...)`."""
    if not isinstance(expr, ast.Call):
        return None
    name = ast.unparse(expr.func)
    if name.endswith("HTTPException"):
        code = next((ast.unparse(k.value) for k in expr.keywords if k.arg == "status_code"), ast.unparse(expr.args[0]) if expr.args else "?")
        detail = next((k.value for k in expr.keywords if k.arg == "detail"), None)
        text = f' · "{short(detail.value, 50)}"' if isinstance(detail, ast.Constant) else ""
        return f"responde {code}{text}"
    if name.endswith(("JSONResponse", "HTMLResponse", "FileResponse", "Response")):
        code = next((ast.unparse(k.value) for k in expr.keywords if k.arg == "status_code"), "200")
        kind = {"JSONResponse": "JSON", "HTMLResponse": "HTML", "FileResponse": "archivo"}.get(name.split(".")[-1], "")
        return f"responde {code}{' · ' + kind if kind else ''}"
    return None


def simple_label(s: ast.stmt) -> str:
    if isinstance(s, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        targets = s.targets if isinstance(s, ast.Assign) else [s.target]
        names = short(", ".join(ast.unparse(t) for t in targets), 40)
        value = s.value
        if value is None:
            return names
        awaited = isinstance(value, ast.Await)
        if awaited:
            value = value.value
        if isinstance(value, ast.Call):
            return f"{names} ← {'await ' if awaited else ''}{short(ast.unparse(value.func), 40)}()"
        op = "+=" if isinstance(s, ast.AugAssign) else "="
        return f"{names} {op} {short(ast.unparse(value), 45)}"
    if isinstance(s, ast.Expr):
        v = s.value
        awaited = isinstance(v, ast.Await)
        if awaited:
            v = v.value
        if isinstance(v, ast.Call):
            return f"{'await ' if awaited else ''}{short(ast.unparse(v.func), 50)}()"
    return short(ast.unparse(s), 60)


def short(t: str, n: int) -> str:
    t = re.sub(r"\s+", " ", str(t)).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


if __name__ == "__main__":
    main()
