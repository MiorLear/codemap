/**
 * Acceso al servicio de inventario por HTTP.
 */
const BASE = "https://inventario.example.com";

/** Busca un registro por id; null si el inventario responde 404. */
export async function buscar(tabla: string, id: string) {
  const respuesta = await fetch(`https://inventario.example.com/${tabla}/${id}`);
  if (respuesta.status === 404) return null;
  return respuesta.json();
}

/** Inserta un registro y devuelve el id que le asignó el inventario. */
export async function guardar(tabla: string, datos: unknown): Promise<string> {
  const respuesta = await fetch(`${BASE}/${tabla}`, { method: "POST", body: JSON.stringify(datos) });
  const { id } = await respuesta.json();
  return id;
}
