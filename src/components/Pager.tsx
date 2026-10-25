import { Button } from "@/components/ui/button";

export function Pager({ total, page, pages, from, to, onPage, unit }: {
  total: number; page: number; pages: number; from: number; to: number; onPage: (p: number) => void; unit: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border p-2 text-xs text-muted-foreground">
      <span>{total ? `${from}–${to} de ${total.toLocaleString("pt-BR")} ${unit}` : `0 ${unit}`}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 0} onClick={() => onPage(page - 1)}>Anterior</Button>
        <span className="self-center">{page + 1}/{pages}</span>
        <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Próxima</Button>
      </div>
    </div>
  );
}

export function QueryError({ onRetry, what }: { onRetry: () => void; what: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-sm">
      <p>Não foi possível carregar {what}.</p>
      <Button size="sm" variant="outline" onClick={onRetry}>Tentar novamente</Button>
    </div>
  );
}
