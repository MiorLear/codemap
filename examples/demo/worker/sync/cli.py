"""Línea de órdenes del worker de sincronización."""

import argparse

from . import tareas


def main() -> int:
    parser = argparse.ArgumentParser(prog="sync")
    sub = parser.add_subparsers(required=True)

    s = sub.add_parser("sincronizar", help="copia los pedidos del día al almacén")
    s.set_defaults(func=lambda a: tareas.sincronizar(a))

    l = sub.add_parser("limpiar", help="borra copias de más de 30 días")
    l.set_defaults(func=tareas.limpiar)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
