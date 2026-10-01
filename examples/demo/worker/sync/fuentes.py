"""De dónde salen los pedidos y a dónde van."""


def leer_pedidos():
    """Pedidos del día, desde la API de la tienda."""
    return []


def guardar_en_almacen(pedido) -> None:
    """Escribe un pedido en el almacén de datos."""
    if not pedido:
        raise ValueError("pedido vacío")
