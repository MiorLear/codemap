/**
 * Tarjeta que muestra el resumen de un pedido en el panel de soporte.
 */
import React, { useEffect, useState } from "react";

const API = "https://tienda.example.com";

export function PedidoCard({ id }: { id: string }) {
  const [datos, setDatos] = useState<{ total: number } | null>(null);
  useEffect(() => {
    fetch(`${API}/api/pedidos/${id}`, { method: "GET" })
      .then((r) => r.json())
      .then(setDatos);
  }, [id]);
  return <div>{datos ? `Total: ${datos.total}` : "Cargando…"}</div>;
}
