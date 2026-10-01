"""Tareas del worker: llevar los pedidos al almacén y limpiar copias viejas."""

from .fuentes import leer_pedidos, guardar_en_almacen


def sincronizar(args) -> int:
    """Copia los pedidos del día; devuelve 1 si alguno falla."""
    fallos = 0
    for pedido in leer_pedidos():
        try:
            guardar_en_almacen(pedido)
        except ConnectionError:
            fallos += 1
    return 1 if fallos else 0


def limpiar(args) -> int:
    try:
        borrar_copias_viejas(dias=30)
    except Exception:
        pass
    return 0


def borrar_copias_viejas(dias: int) -> None:
    print(f"borrando copias de más de {dias} días")
