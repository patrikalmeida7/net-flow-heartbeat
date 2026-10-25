/** Cliente = concentrador + login (logins iguais em concentradores diferentes são clientes distintos). */
export function clientPath(concentradorId: string | null | undefined, username: string) {
  return concentradorId
    ? `/pppoe/c/${concentradorId}/${encodeURIComponent(username)}`
    : `/pppoe/${encodeURIComponent(username)}`;
}

export const PAGE_SIZE = 50;

export function pageInfo(total: number, page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { pages, page: p, offset: p * size, from: total ? p * size + 1 : 0, to: Math.min(total, (p + 1) * size) };
}
